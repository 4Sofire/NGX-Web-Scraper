const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const zlib    = require('zlib');
const cheerio = require('cheerio');

// ── HTTP helper (no axios/undici) ────────────────────────────────────────────
function fetchUrl(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const lib    = parsed.protocol === 'https:' ? https : http;
      const options = {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        timeout:  timeoutMs,
        headers: {
          'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'Connection':      'keep-alive',
          'Cache-Control':   'no-cache',
        },
      };

      const req = lib.request(options, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
        }
        if (res.statusCode < 200 || res.statusCode >= 400) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const chunks   = [];
        const encoding = res.headers['content-encoding'];
        let   stream   = res;
        if      (encoding === 'gzip')    stream = res.pipe(zlib.createGunzip());
        else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (encoding === 'br')      stream = res.pipe(zlib.createBrotliDecompress());
        stream.on('data',  c => chunks.push(c));
        stream.on('end',   ()  => resolve(Buffer.concat(chunks).toString('utf8')));
        stream.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
      req.on('error',   reject);
      req.end();
    } catch (e) { reject(e); }
  });
}

// ── Market status (WAT = UTC+1) ───────────────────────────────────────────────
// As of April 27 2026, NGX trades 9:00 AM – 4:00 PM WAT, Mon–Fri
function getMarketStatus() {
  const now   = new Date();
  const wat   = new Date(now.getTime() + (60 * 60 * 1000)); // UTC+1
  const day   = wat.getUTCDay();   // 0=Sun, 6=Sat
  const hhmm  = wat.getUTCHours() * 100 + wat.getUTCMinutes();
  const isWeekday = day >= 1 && day <= 5;
  const isOpen    = isWeekday && hhmm >= 900 && hhmm < 1600;
  const isPreOpen = isWeekday && hhmm >= 830 && hhmm < 900;

  let label, color;
  if (isOpen)         { label = 'MARKET OPEN';     color = 'green'; }
  else if (isPreOpen) { label = 'PRE-OPEN';         color = 'amber'; }
  else if (!isWeekday){ label = 'WEEKEND — CLOSED'; color = 'red';   }
  else if (hhmm < 900){ label = 'OPENS 9:00 AM WAT';color = 'amber'; }
  else                { label = 'MARKET CLOSED';    color = 'red';   }

  return { isOpen, isPreOpen, label, color };
}

// ── App state ─────────────────────────────────────────────────────────────────
let mainWindow;
let stockData       = {};
let refreshInterval = null;
const priceHistory  = {};

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: 420, height: 700,
    x: width - 440, y: height - 720,
    frame: false, transparent: false,
    alwaysOnTop: true, resizable: true, skipTaskbar: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'preload.js') },
    backgroundColor: '#0d1117',
  });
  mainWindow.loadFile('index.html');
  startRefreshLoop();
}

// ── Scraper ───────────────────────────────────────────────────────────────────
// The best free source is the NGX website's own ticker strip.
// It shows data in the format: SYMBOL N{price} {change}%
// This data is 30-min delayed on the free tier.

async function scrapeNGX() {
  console.log('[scraper] fetching…');
  const results = await Promise.allSettled([
    scrapeNGXTicker(),
    scrapeAfxKwayisi(),
  ]);

  let merged = {};
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && Object.keys(r.value).length > 0) {
      for (const [sym, data] of Object.entries(r.value)) {
        if (!merged[sym] || Object.keys(data).length > Object.keys(merged[sym]).length) {
          merged[sym] = data;
        }
      }
    }
  }
  console.log(`[scraper] got ${Object.keys(merged).length} stocks`);
  return merged;
}

// Primary: NGX website ticker strip — most reliable free source
// The ticker text looks like: "DANGCEM N588.10 -1.50% GTCO N56.90 +2.30% ..."
async function scrapeNGXTicker() {
  try {
    const html = await fetchUrl('https://ngxgroup.com/exchange/trade/equities/trading-market-structure/', 15000);
    const $    = cheerio.load(html);
    const stocks = {};

    // Extract all text content and scan for price patterns
    const allText = $('body').text().replace(/\s+/g, ' ');

    // Pattern: SYMBOL N{price} {±change}%
    // e.g. "DANGCEM N588.10 -1.50%" or "GTCO N56.90 0.00%"
    const pattern = /([A-Z][A-Z0-9]{1,13})\s+N([\d,]+\.?\d*)\s+([-+]?[\d.]+)\s*%/g;
    let m;
    while ((m = pattern.exec(allText)) !== null) {
      const symbol   = m[1];
      const price    = parseFloat(m[2].replace(/,/g, ''));
      const changePct= parseFloat(m[3]);

      // Skip obviously wrong values (bonds at N100, ETF at N1000000, etc.)
      if (price <= 0 || price === 100 || price === 1000000) continue;
      // Skip symbols that look like bond codes
      if (/\d{4}/.test(symbol)) continue;

      const prevClose = changePct !== 0
        ? parseFloat((price / (1 + changePct / 100)).toFixed(2))
        : price;

      stocks[symbol] = {
        symbol, name: symbol, price, prevClose,
        changePct, source: 'NGX',
      };
    }

    // Also try the equities price list page for more detail (name, volume, high, low)
    try {
      const html2 = await fetchUrl('https://ngxgroup.com/exchange/data/equities-price-list/', 15000);
      const $2    = cheerio.load(html2);

      // Same ticker pattern on this page too
      const text2  = $2('body').text().replace(/\s+/g, ' ');
      const pat2   = /([A-Z][A-Z0-9]{1,13})\s+N([\d,]+\.?\d*)\s+([-+]?[\d.]+)\s*%/g;
      let m2;
      while ((m2 = pat2.exec(text2)) !== null) {
        const sym  = m2[1];
        const px   = parseFloat(m2[2].replace(/,/g, ''));
        const chg  = parseFloat(m2[3]);
        if (px <= 0 || px === 100 || px === 1000000) continue;
        if (/\d{4}/.test(sym)) continue;
        if (!stocks[sym]) {
          const prev = chg !== 0 ? parseFloat((px / (1 + chg / 100)).toFixed(2)) : px;
          stocks[sym] = { symbol: sym, name: sym, price: px, prevClose: prev, changePct: chg, source: 'NGX' };
        }
      }

      // Try the data table for names + OHLV
      $2('table tbody tr').each((_, row) => {
        const cols = $2(row).find('td');
        if (cols.length < 3) return;
        const clean = s => parseFloat((s || '').replace(/[₦,\s]/g, '')) || 0;
        const sym   = $2(cols[0]).text().trim().replace(/\s+/g, '').toUpperCase();
        if (!sym || sym.length > 14 || /\d{4}/.test(sym)) return;

        const col1txt = $2(cols[1]).text().trim();
        const col2txt = $2(cols[2]).text().trim();
        // Detect if col1 is name (non-numeric) or price (numeric)
        const isNameCol = isNaN(parseFloat(col1txt.replace(/[₦,]/g, '')));
        const name  = isNameCol ? col1txt : sym;
        const priceRaw = isNameCol ? clean(col2txt) : clean(col1txt);
        if (priceRaw <= 0 || priceRaw === 100) return;

        // Enrich existing entry or create new
        const entry = stocks[sym] || { symbol: sym, name: sym, price: priceRaw, prevClose: priceRaw, changePct: 0, source: 'NGX' };
        entry.name = name !== sym ? name : entry.name;
        if (cols.length > 3) entry.open   = clean($2(cols[isNameCol ? 3 : 2]).text()) || priceRaw;
        if (cols.length > 4) entry.high   = clean($2(cols[isNameCol ? 4 : 3]).text()) || priceRaw;
        if (cols.length > 5) entry.low    = clean($2(cols[isNameCol ? 5 : 4]).text()) || priceRaw;
        if (cols.length > 6) entry.volume = clean($2(cols[isNameCol ? 6 : 5]).text());
        stocks[sym] = entry;
      });
    } catch (e2) {
      console.log('[NGX price list] sub-fetch failed:', e2.message);
    }

    console.log(`[NGX ticker] ${Object.keys(stocks).length} stocks`);
    return Object.keys(stocks).length > 0 ? stocks : null;
  } catch (e) {
    console.log('[NGX ticker] failed:', e.message);
    return null;
  }
}

// Secondary: afx.kwayisi.org — independent NGX aggregator
async function scrapeAfxKwayisi() {
  try {
    const stocks = {};
    await Promise.all([1, 2, 3, 4, 5].map(async page => {
      try {
        const url  = page === 1 ? 'https://afx.kwayisi.org/ngx/' : `https://afx.kwayisi.org/ngx/?page=${page}`;
        const html = await fetchUrl(url, 10000);
        const $    = cheerio.load(html);
        $('table tbody tr').each((_, row) => {
          const cols  = $(row).find('td');
          if (cols.length < 4) return;
          const clean = s => parseFloat((s||'').replace(/[₦,\s+%]/g, '')) || 0;
          const t = i => $(cols[i]).text().trim();
          let symbol, name, price, changePct, volume;
          if (/^\d+$/.test(t(0))) {
            name = t(1); symbol = t(2).toUpperCase(); price = clean(t(3));
            changePct = cols.length > 4 ? clean(t(4)) : 0;
            volume    = cols.length > 5 ? clean(t(5)) : 0;
          } else {
            symbol = t(0).toUpperCase(); name = t(1); price = clean(t(2));
            changePct = clean(t(3));
            volume    = cols.length > 4 ? clean(t(4)) : 0;
          }
          if (!symbol || symbol.length > 14 || price <= 0 || price === 100) return;
          if (/\d{4}/.test(symbol)) return;
          const prevClose = changePct !== 0 ? parseFloat((price / (1 + changePct / 100)).toFixed(2)) : price;
          stocks[symbol] = { symbol, name: name || symbol, price, prevClose, changePct, volume, source: 'AFX/NGX' };
        });
      } catch (_) {}
    }));
    console.log(`[AFX] ${Object.keys(stocks).length} stocks`);
    return Object.keys(stocks).length > 0 ? stocks : null;
  } catch (e) {
    console.log('[AFX] failed:', e.message);
    return null;
  }
}

// ── History & signals ─────────────────────────────────────────────────────────
function updateHistory(data) {
  for (const [sym, d] of Object.entries(data)) {
    if (!priceHistory[sym]) priceHistory[sym] = [];
    priceHistory[sym].push(d.price);
    if (priceHistory[sym].length > 20) priceHistory[sym].shift();
  }
}

function computeSignal(sym) {
  const hist = priceHistory[sym] || [];
  if (hist.length < 5) return { signal: 'WAIT', strength: 0, rsi: null };
  const changes = hist.slice(1).map((p, i) => p - hist[i]);
  const gains   = changes.filter(c => c > 0);
  const losses  = changes.filter(c => c < 0).map(Math.abs);
  const avgGain = gains.length  ? gains.reduce((a,b)=>a+b,0)  / changes.length : 0;
  const avgLoss = losses.length ? losses.reduce((a,b)=>a+b,0) / changes.length : 0;
  const rs      = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi     = parseFloat((100 - 100 / (1 + rs)).toFixed(1));
  const short   = hist.slice(-3).reduce((a,b)=>a+b,0) / 3;
  const long    = hist.reduce((a,b)=>a+b,0) / hist.length;
  let signal = 'HOLD', strength = 50;
  if      (rsi < 35 && short > long * 0.998) { signal = 'BUY';  strength = Math.min(90, 50 + (35-rsi)*2); }
  else if (rsi > 65 && short < long * 1.002) { signal = 'SELL'; strength = Math.min(90, 50 + (rsi-65)*2); }
  else if (short > long * 1.003)             { signal = 'BUY';  strength = 60; }
  else if (short < long * 0.997)             { signal = 'SELL'; strength = 60; }
  return { signal, strength: Math.round(strength), rsi };
}

// ── Refresh ───────────────────────────────────────────────────────────────────
async function doRefresh() {
  try {
    const data    = await scrapeNGX();
    const gotData = Object.keys(data).length > 0;
    if (gotData) { updateHistory(data); stockData = data; }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('stock-update', {
        stocks:            stockData,
        history:           priceHistory,
        liveDataAvailable: gotData,
        stockCount:        Object.keys(stockData).length,
        marketStatus:      getMarketStatus(),
      });
    }
  } catch (e) { console.error('[refresh]', e.message); }
}

async function startRefreshLoop() {
  await doRefresh();
  refreshInterval = setInterval(doRefresh, 30000);
}

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle('get-all-symbols',   ()       => Object.keys(stockData).sort());
ipcMain.handle('get-signal',        (_, sym) => computeSignal(sym));
ipcMain.handle('get-history',       (_, sym) => priceHistory[sym] || []);
ipcMain.handle('get-market-status', ()       => getMarketStatus());
ipcMain.handle('set-refresh-rate',  (_, ms)  => {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(doRefresh, ms);
});
ipcMain.on('close-app',    ()  => app.quit());
ipcMain.on('minimize-app', ()  => mainWindow && mainWindow.minimize());
ipcMain.on('toggle-pin',   ()  => mainWindow && mainWindow.setAlwaysOnTop(!mainWindow.isAlwaysOnTop()));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });