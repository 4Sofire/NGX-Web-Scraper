const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path    = require('path');
const https   = require('https');
const http    = require('http');
const zlib    = require('zlib');
const cheerio = require('cheerio');

// ── HTTP helper ───────────────────────────────────────────────────────────────
function fetchUrl(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    try {
      const parsed  = new URL(url);
      const lib     = parsed.protocol === 'https:' ? https : http;
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
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        const enc    = res.headers['content-encoding'];
        let stream   = res;
        if      (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
        else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
        else if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress());
        stream.on('data',  c  => chunks.push(c));
        stream.on('end',   () => resolve(Buffer.concat(chunks).toString('utf8')));
        stream.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.on('error',   reject);
      req.end();
    } catch (e) { reject(e); }
  });
}

// ── Market status (WAT = UTC+1) ───────────────────────────────────────────────
// NGX trades Mon–Fri 9:00 AM – 4:00 PM WAT (since April 27, 2026)
function getMarketStatus() {
  const now  = new Date();
  const wat  = new Date(now.getTime() + 3600000);
  const day  = wat.getUTCDay();
  const hhmm = wat.getUTCHours() * 100 + wat.getUTCMinutes();
  const isWeekday = day >= 1 && day <= 5;
  const isOpen    = isWeekday && hhmm >= 900 && hhmm < 1600;
  const isPreOpen = isWeekday && hhmm >= 830 && hhmm < 900;
  let label, color;
  if      (isOpen)     { label = 'MARKET OPEN';        color = 'green'; }
  else if (isPreOpen)  { label = 'PRE-OPEN';            color = 'amber'; }
  else if (!isWeekday) { label = 'WEEKEND — CLOSED';    color = 'red';   }
  else if (hhmm < 900) { label = 'OPENS 9:00 AM WAT';  color = 'amber'; }
  else                 { label = 'MARKET CLOSED';        color = 'red';   }
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
    x: width - 440, y: 20,
    frame: false, transparent: false,
    alwaysOnTop: true, resizable: true, skipTaskbar: false,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    backgroundColor: '#0d1117',
  });
  mainWindow.loadFile('index.html');
  startRefreshLoop();
}

// ── Scraper ───────────────────────────────────────────────────────────────────
//
// Source: afx.kwayisi.org/ngx/
//
// The page has a table with these columns:
//   # | Company | Symbol | Price (NGN) | Change | Volume
//
// Pages: afx.kwayisi.org/ngx/           (page 1, ~50 stocks)
//        afx.kwayisi.org/ngx/?page=2    (page 2)
//        afx.kwayisi.org/ngx/?page=3    (page 3)  etc.
//
// Each stock also has its own page: afx.kwayisi.org/ngx/{symbol}.html
// which has previous close, market cap, sector, 52-week high/low.

async function scrapeNGX() {
  console.log('[AFX] scraping all pages…');
  const stocks = {};

  // Scrape all pages in parallel (pages 1–5 covers all ~150 NGX equities)
  await Promise.all([1, 2, 3, 4, 5].map(async (page) => {
    const url = page === 1
      ? 'https://afx.kwayisi.org/ngx/'
      : `https://afx.kwayisi.org/ngx/?page=${page}`;

    try {
      const html = await fetchUrl(url, 15000);
      const $    = cheerio.load(html);

      // AFX table columns: rank | company | symbol | price | change | volume
      $('table tbody tr').each((_, row) => {
        const cols = $(row).find('td');
        if (cols.length < 5) return;

        const clean  = s => parseFloat((s || '').replace(/[,\s]/g, '')) || 0;
        const colTxt = i => $(cols[i]).text().trim();

        // Col 0 = rank (number), col 1 = company name, col 2 = symbol (link)
        // col 3 = price, col 4 = change, col 5 = volume (if present)
        const rankTxt = colTxt(0);
        if (!/^\d+$/.test(rankTxt)) return;  // skip non-data rows

        const name      = colTxt(1);
        const symbol    = colTxt(2).toUpperCase().replace(/\s*\[.*?\]/g, '').trim();
        const price     = clean(colTxt(3));
        const changePct = parseFloat((colTxt(4) || '0').replace(/[+\s%]/g, '')) || 0;
        const volume    = cols.length > 5 ? clean(colTxt(5)) : 0;

        if (!symbol || price <= 0) return;

        // Derive previous close from price and % change
        const prevClose    = changePct !== 0
          ? parseFloat((price / (1 + changePct / 100)).toFixed(2))
          : price;
        const priceChange  = parseFloat((price - prevClose).toFixed(2));

        stocks[symbol] = {
          symbol,
          name:        name || symbol,
          price,
          prevClose,
          priceChange,
          changePct,
          volume,
          source:      'AFX/NGX',
        };
      });

      console.log(`[AFX] page ${page}: running total ${Object.keys(stocks).length} stocks`);
    } catch (e) {
      console.log(`[AFX] page ${page} failed: ${e.message}`);
    }
  }));

  console.log(`[AFX] total scraped: ${Object.keys(stocks).length} stocks`);
  return stocks;
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
  if      (rsi < 35 && short > long * 0.998) { signal = 'BUY';  strength = Math.min(90, 50+(35-rsi)*2); }
  else if (rsi > 65 && short < long * 1.002) { signal = 'SELL'; strength = Math.min(90, 50+(rsi-65)*2); }
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
ipcMain.on('close-app',    () => app.quit());
ipcMain.on('minimize-app', () => mainWindow && mainWindow.minimize());
ipcMain.on('toggle-pin',   () => mainWindow && mainWindow.setAlwaysOnTop(!mainWindow.isAlwaysOnTop()));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });