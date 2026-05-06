const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const zlib    = require('zlib');
const cheerio = require('cheerio');

// ── HTTP helper (no axios, no undici) ────────────────────────────────────────
function fetchUrl(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
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
      // Follow redirects (up to 5)
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

      stream.on('data',  chunk => chunks.push(chunk));
      stream.on('end',   ()    => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
    req.on('error',   reject);
    req.end();
  });
}

// ── App state ────────────────────────────────────────────────────────────────
let mainWindow;
let stockData      = {};
let refreshInterval = null;
const priceHistory  = {};   // symbol → last 20 prices

// ── Window ───────────────────────────────────────────────────────────────────
function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width:       420,
    height:      680,
    x:           width  - 440,
    y:           height - 700,
    frame:       false,
    transparent: false,
    alwaysOnTop: true,
    resizable:   true,
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    backgroundColor: '#0d1117',
    titleBarStyle:   'hidden',
  });

  mainWindow.loadFile('index.html');
  startRefreshLoop();
}

// ── Scrapers ─────────────────────────────────────────────────────────────────
// NGX free data is delayed ~30 min. True real-time requires a paid NGX subscription.

async function scrapeNGX() {
  console.log('[scraper] fetch cycle starting…');

  const results = await Promise.allSettled([
    scrapeNGXWebsite(),
    scrapeAfxKwayisi(),
    scrapeProshareLive(),
  ]);

  let merged = {};
  let sources = [];

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && Object.keys(r.value).length > 0) {
      const src = Object.values(r.value)[0]?.source || '?';
      sources.push(src);
      for (const [sym, data] of Object.entries(r.value)) {
        if (!merged[sym] || Object.keys(data).length > Object.keys(merged[sym]).length) {
          merged[sym] = data;
        }
      }
    }
  }

  if (Object.keys(merged).length > 0) {
    console.log(`[scraper] ${Object.keys(merged).length} stocks from: ${sources.join(', ')}`);
    return merged;
  }

  console.log('[scraper] all sources failed');
  return {};
}

// Source 1 — NGX Group official website
async function scrapeNGXWebsite() {
  try {
    const html = await fetchUrl('https://ngxgroup.com/exchange/data/equities-price-list/', 15000);
    const $    = cheerio.load(html);
    const stocks = {};

    // Try ticker strip
    const tickerText = $('.ticker-wrap, .market-ticker, #ticker, [class*="ticker"]').text();
    if (tickerText) {
      const matches = [...tickerText.matchAll(/([A-Z]{2,12})\s+N([\d,]+\.?\d*)\s+([-+][\d.]+)/g)];
      matches.forEach(m => {
        const symbol = m[1];
        const price  = parseFloat(m[2].replace(/,/g, ''));
        const chg    = parseFloat(m[3]);
        if (symbol && price > 0) {
          const prevClose = parseFloat((price / (1 + chg / 100)).toFixed(2));
          stocks[symbol] = { symbol, name: symbol, price, prevClose, change: chg, source: 'NGX' };
        }
      });
    }

    // Try data table
    $('table tbody tr').each((_, row) => {
      const cols   = $(row).find('td');
      if (cols.length < 4) return;
      const symbol = $(cols[0]).text().trim().replace(/\s+/g, '').toUpperCase();
      if (!symbol || symbol.length > 14) return;
      const clean  = s => parseFloat(s.replace(/[₦,\s]/g, '')) || 0;
      const price  = clean($(cols[2]).text()) || clean($(cols[1]).text());
      if (price <= 0) return;
      stocks[symbol] = {
        symbol,
        name:   $(cols[1]).text().trim() || symbol,
        price,
        open:   clean($(cols[3]).text()) || price,
        high:   cols.length > 4 ? clean($(cols[4]).text()) || price : price,
        low:    cols.length > 5 ? clean($(cols[5]).text()) || price : price,
        volume: cols.length > 6 ? clean($(cols[6]).text()) : 0,
        source: 'NGX',
      };
    });

    // Try embedded JSON
    const m = html.match(/var\s+(?:stockData|priceList|equities)\s*=\s*(\[[\s\S]*?\]);/);
    if (m) {
      try {
        JSON.parse(m[1]).forEach(item => {
          const sym   = (item.symbol || item.ticker || item.code || '').toUpperCase();
          const price = parseFloat(item.close || item.price || item.last || 0);
          if (sym && price > 0) {
            stocks[sym] = {
              symbol: sym, name: item.name || item.companyName || sym,
              price,
              prevClose: parseFloat(item.prevClose || item.prev_close || price),
              open:      parseFloat(item.open   || price),
              high:      parseFloat(item.high   || price),
              low:       parseFloat(item.low    || price),
              volume:    parseFloat(item.volume || item.vol || 0),
              source:    'NGX',
            };
          }
        });
      } catch (_) {}
    }

    console.log(`[NGX website] ${Object.keys(stocks).length} stocks`);
    return Object.keys(stocks).length > 0 ? stocks : null;
  } catch (e) {
    console.log('[NGX website] failed:', e.message);
    return null;
  }
}

// Source 2 — afx.kwayisi.org/ngx (independent NGX aggregator)
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
          const clean = s => parseFloat(s.replace(/[₦,\s+%]/g, '')) || 0;

          const t0 = $(cols[0]).text().trim();
          const t1 = $(cols[1]).text().trim();
          const t2 = $(cols[2]).text().trim();
          const t3 = $(cols[3]).text().trim();

          let symbol, name, price, change, volume;

          if (/^\d+$/.test(t0)) {
            // Rank | Name | Symbol | Price | Change | Volume
            name   = t1;
            symbol = t2.toUpperCase();
            price  = clean(t3);
            change = cols.length > 4 ? clean($(cols[4]).text()) : 0;
            volume = cols.length > 5 ? clean($(cols[5]).text()) : 0;
          } else {
            // Symbol | Name | Price | Change
            symbol = t0.toUpperCase();
            name   = t1;
            price  = clean(t2);
            change = clean(t3);
            volume = cols.length > 4 ? clean($(cols[4]).text()) : 0;
          }

          if (!symbol || symbol.length > 14 || price <= 0) return;
          const prevClose = change !== 0 ? parseFloat((price / (1 + change / 100)).toFixed(2)) : price;
          stocks[symbol]  = { symbol, name: name || symbol, price, prevClose, change, volume, source: 'AFX/NGX' };
        });
      } catch (_) {}
    }));

    console.log(`[AFX Kwayisi] ${Object.keys(stocks).length} stocks`);
    return Object.keys(stocks).length > 0 ? stocks : null;
  } catch (e) {
    console.log('[AFX Kwayisi] failed:', e.message);
    return null;
  }
}

// Source 3 — Proshare live market
async function scrapeProshareLive() {
  try {
    const html   = await fetchUrl('https://proshare.net/market/ngx-live-market', 12000);
    const $      = cheerio.load(html);
    const stocks = {};

    $('table tbody tr, .market-data-row').each((_, row) => {
      const cols   = $(row).find('td');
      if (cols.length < 3) return;
      const clean  = s => parseFloat(s.replace(/[₦,\s]/g, '')) || 0;
      const symbol = $(cols[0]).text().trim().toUpperCase().replace(/\s+/g, '');
      const price  = clean($(cols[1]).text());
      const prev   = clean($(cols[2]).text());
      if (!symbol || symbol.length > 14 || price <= 0) return;
      stocks[symbol] = { symbol, name: symbol, price, prevClose: prev || price, source: 'Proshare' };
    });

    // Try embedded JSON
    const m = html.match(/"prices"\s*:\s*(\[[\s\S]*?\])/);
    if (m) {
      try {
        JSON.parse(m[1]).forEach(item => {
          const sym   = (item.symbol || '').toUpperCase();
          const price = parseFloat(item.price || 0);
          if (sym && price > 0) {
            stocks[sym] = { symbol: sym, name: item.name || sym, price, prevClose: parseFloat(item.prevClose || price), source: 'Proshare' };
          }
        });
      } catch (_) {}
    }

    console.log(`[Proshare] ${Object.keys(stocks).length} stocks`);
    return Object.keys(stocks).length > 0 ? stocks : null;
  } catch (e) {
    console.log('[Proshare] failed:', e.message);
    return null;
  }
}

// ── History & signals ────────────────────────────────────────────────────────
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
  const avgGain = gains.length  ? gains.reduce((a, b) => a + b, 0)  / changes.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / changes.length : 0;
  const rs      = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi     = parseFloat((100 - 100 / (1 + rs)).toFixed(1));

  const short = hist.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const long  = hist.reduce((a, b) => a + b, 0) / hist.length;

  let signal = 'HOLD', strength = 50;
  if      (rsi < 35 && short > long * 0.998) { signal = 'BUY';  strength = Math.min(90, 50 + (35 - rsi) * 2); }
  else if (rsi > 65 && short < long * 1.002) { signal = 'SELL'; strength = Math.min(90, 50 + (rsi - 65) * 2); }
  else if (short > long * 1.003)              { signal = 'BUY';  strength = 60; }
  else if (short < long * 0.997)              { signal = 'SELL'; strength = 60; }

  return { signal, strength: Math.round(strength), rsi };
}

// ── Refresh loop ─────────────────────────────────────────────────────────────
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
      });
    }
  } catch (e) {
    console.error('[refresh] error:', e.message);
  }
}

async function startRefreshLoop() {
  await doRefresh();
  refreshInterval = setInterval(doRefresh, 30000);
}

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle('get-all-symbols', ()       => Object.keys(stockData).sort());
ipcMain.handle('get-signal',      (_, sym) => computeSignal(sym));
ipcMain.handle('get-history',     (_, sym) => priceHistory[sym] || []);

ipcMain.handle('set-refresh-rate', (_, ms) => {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(doRefresh, ms);
});

ipcMain.on('close-app',    ()  => app.quit());
ipcMain.on('minimize-app', ()  => mainWindow && mainWindow.minimize());
ipcMain.on('toggle-pin',   ()  => mainWindow && mainWindow.setAlwaysOnTop(!mainWindow.isAlwaysOnTop()));

// ── Boot ──────────────────────────────────────────────────────────────────────
app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });