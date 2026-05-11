const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path  = require('path');
const https = require('https');
const zlib  = require('zlib');

// ── Config ────────────────────────────────────────────────────────────────────
const API_KEY  = 'ngxpulse_1l33crmyz9si54tt';
const BASE_URL = 'ngxpulse.ng';  // no www

// ── Rate limit tracker ────────────────────────────────────────────────────────
// Personal tier: 10 req/min, 100 req/day
// Strategy: fetch all stocks in 1 call every 30s during market hours,
//           every 5 min outside market hours → well within 100/day
let requestsToday = 0;
let lastDayReset  = new Date().toDateString();

function trackRequest() {
  const today = new Date().toDateString();
  if (today !== lastDayReset) { requestsToday = 0; lastDayReset = today; }
  requestsToday++;
  console.log(`[API] request #${requestsToday} today`);
}

function canRequest() {
  const today = new Date().toDateString();
  if (today !== lastDayReset) { requestsToday = 0; lastDayReset = today; }
  return requestsToday < 98; // leave 2 buffer
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function apiGet(endpoint) {
  return new Promise((resolve, reject) => {
    console.log(`[API] GET https://${BASE_URL}${endpoint}`);
    const options = {
      hostname: BASE_URL,
      path:     endpoint,
      method:   'GET',
      timeout:  15000,
      headers: {
        'X-API-Key':      API_KEY,
        'Content-Type':   'application/json',
        'Accept':         'application/json',
        'User-Agent':     'NGX-Ticker-Desktop/1.0',
        'Accept-Encoding':'gzip, deflate',
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode === 429) {
        return reject(new Error('Rate limit hit (429)'));
      }
      if (res.statusCode === 401) {
        return reject(new Error('Invalid API key (401)'));
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
      stream.on('end',   () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        console.log('[API raw response]', raw.slice(0, 500));
        try {
          resolve(JSON.parse(raw));
        } catch (e) {
          reject(new Error('JSON parse failed — got: ' + raw.slice(0, 200)));
        }
      });
      stream.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error',   reject);
    req.end();
  });
}

// ── Market status ─────────────────────────────────────────────────────────────
// First try the API, fall back to local time calculation
let cachedMarketStatus = null;

async function getMarketStatus() {
  // Try API market-status endpoint (costs 1 request — only call occasionally)
  try {
    if (canRequest()) {
      trackRequest();
      const data = await apiGet('/api/ngxdata/market-status');
      const isOpen = data.status === 'open';
      cachedMarketStatus = {
        isOpen,
        isPreOpen: false,
        label:  isOpen ? 'MARKET OPEN' : 'MARKET CLOSED',
        color:  isOpen ? 'green' : 'red',
      };
      return cachedMarketStatus;
    }
  } catch (_) {}

  // Fallback: calculate locally (WAT = UTC+1)
  // NGX trades Mon–Fri 9:00 AM – 4:00 PM WAT
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
      sandbox:          false,
      preload: path.join(__dirname, 'preload.js'),
    },
    backgroundColor: '#0d1117',
  });
  mainWindow.loadFile('index.html');
  startRefreshLoop();
}

// ── Fetch all stocks from API ─────────────────────────────────────────────────
// GET /api/ngxdata/stocks
// Returns: [{ symbol, name, current_price, change_percent, volume,
//             shares_outstanding, sector, pe_ratio }, ...]
async function fetchAllStocks() {
  if (!canRequest()) {
    console.log('[API] daily limit reached, skipping fetch');
    return null;
  }

  trackRequest();
  const data = await apiGet('/api/ngxdata/stocks');

  if (!Array.isArray(data)) {
    throw new Error('Unexpected response format');
  }

  const stocks = {};
  for (const item of data) {
    const symbol = (item.symbol || '').toUpperCase().trim();
    const price  = parseFloat(item.current_price) || 0;
    if (!symbol || price <= 0) continue;

    const changePct   = parseFloat(item.change_percent) || 0;
    const prevClose   = changePct !== 0
      ? parseFloat((price / (1 + changePct / 100)).toFixed(2))
      : price;
    const priceChange = parseFloat((price - prevClose).toFixed(2));
    const marketCap   = price * (parseFloat(item.shares_outstanding) || 0);

    stocks[symbol] = {
      symbol,
      name:         item.name || symbol,
      price,
      prevClose,
      priceChange,
      changePct,
      volume:       parseFloat(item.volume) || 0,
      sharesOut:    parseFloat(item.shares_outstanding) || 0,
      marketCap,
      sector:       item.sector || '—',
      peRatio:      parseFloat(item.pe_ratio) || null,
      source:       'NGXPulse API',
    };
  }

  console.log(`[API] fetched ${Object.keys(stocks).length} stocks`);
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

// ── Refresh loop ──────────────────────────────────────────────────────────────
// Smart refresh rate:
// - During market hours (9am-4pm WAT): every 5 minutes = max 84 calls/day for stocks
// - Outside market hours: every 30 minutes (prices don't change anyway)
// This keeps us well within the 100/day limit

function getRefreshInterval() {
  const wat  = new Date(Date.now() + 3600000);
  const day  = wat.getUTCDay();
  const hhmm = wat.getUTCHours() * 100 + wat.getUTCMinutes();
  const isMarketHours = day >= 1 && day <= 5 && hhmm >= 900 && hhmm < 1600;
  // Market hours 9am-4pm = 7hrs = 420min / 10min = 42 calls
  // Outside hours: ~17hrs / 60min = ~17 calls
  // Total: ~59 calls/day — safe within 100/day limit
  return isMarketHours ? 10 * 60 * 1000 : 60 * 60 * 1000; // 10min or 60min
}

async function doRefresh() {
  try {
    const data    = await fetchAllStocks();
    const gotData = data && Object.keys(data).length > 0;
    if (gotData) { updateHistory(data); stockData = data; }

    const marketStatus = await getMarketStatus();

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('stock-update', {
        stocks:            stockData,
        history:           priceHistory,
        liveDataAvailable: gotData,
        stockCount:        Object.keys(stockData).length,
        requestsToday,
        marketStatus,
      });
    }

    // Reschedule with smart interval
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setTimeout(doRefresh, getRefreshInterval());

  } catch (e) {
    console.error('[refresh]', e.message);
    // On error, retry in 2 minutes
    if (refreshInterval) clearInterval(refreshInterval);
    refreshInterval = setTimeout(doRefresh, 2 * 60 * 1000);

    if (mainWindow && !mainWindow.isDestroyed()) {
      const marketStatus = await getMarketStatus();
      mainWindow.webContents.send('stock-update', {
        stocks:            stockData,
        history:           priceHistory,
        liveDataAvailable: false,
        stockCount:        Object.keys(stockData).length,
        requestsToday,
        marketStatus,
        error: e.message,
      });
    }
  }
}

async function startRefreshLoop() {
  await doRefresh();
}

// ── IPC ───────────────────────────────────────────────────────────────────────
ipcMain.handle('get-all-symbols',   ()       => Object.keys(stockData).sort());
ipcMain.handle('get-signal',        (_, sym) => computeSignal(sym));
ipcMain.handle('get-history',       (_, sym) => priceHistory[sym] || []);
ipcMain.handle('get-market-status', ()       => getMarketStatus());
ipcMain.handle('get-requests-today',()       => requestsToday);

// Manual refresh triggered by user — costs 1 request
ipcMain.handle('manual-refresh', async () => {
  if (!canRequest()) return { error: 'Daily limit reached (100/day)' };
  await doRefresh();
  return { ok: true };
});

ipcMain.on('close-app',    () => app.quit());
ipcMain.on('minimize-app', () => mainWindow && mainWindow.minimize());
ipcMain.on('toggle-pin',   () => mainWindow && mainWindow.setAlwaysOnTop(!mainWindow.isAlwaysOnTop()));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });