const { app, BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const https = require('https');
const http  = require('http');
const zlib  = require('zlib');
const cheerio = require('cheerio');

// Drop-in fetch using Node built-ins — no axios/undici dependency
function fetchUrl(url, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
      }
    };

    const req = lib.request(options, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }

      const chunks = [];
      const encoding = res.headers['content-encoding'];

      let stream = res;
      if (encoding === 'gzip')    stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
    req.on('error', reject);
    req.end();
  });
}

let mainWindow;
let stockData = {};
let watchlist = [];
let refreshInterval = null;

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 420,
    height: 680,
    x: width - 440,
    y: height - 700,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    backgroundColor: '#0d1117',
    titleBarStyle: 'hidden'
  });

  mainWindow.loadFile('index.html');
  startRefreshLoop();
}

// ── NGX Scraper ─────────────────────────────────────────────────────────────
// NOTE: NGX's own website shows 30-min delayed data (free tier).
// True real-time requires a paid X-DataPortal subscription from NGX.
// We scrape two independent sources and merge them for best coverage.


async function scrapeNGX() {
  console.log('[scraper] Starting fetch cycle…');

  // Run all sources in parallel, take whatever succeeds
  const results = await Promise.allSettled([
    scrapeNGXWebsite(),
    scrapeAfxKwayisi(),
    scrapeProshareLive(),
  ]);

  let merged = {};
  let successSources = [];

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value && Object.keys(r.value).length > 0) {
      const incoming = r.value;
      const src = Object.values(incoming)[0]?.source || 'unknown';
      successSources.push(src);
      // Merge: prefer data with more fields (live over partial)
      for (const [sym, data] of Object.entries(incoming)) {
        if (!merged[sym] || Object.keys(data).length > Object.keys(merged[sym]).length) {
          merged[sym] = data;
        }
      }
    }
  }

  if (Object.keys(merged).length > 0) {
    console.log(`[scraper] Got ${Object.keys(merged).length} stocks from: ${successSources.join(', ')}`);
    return merged;
  }

  console.log('[scraper] All live sources failed — using last-known data or empty set');
  // Return empty so the UI shows a "data unavailable" state rather than fake prices
  return {};
}

// Source 1: NGX Group official website (30-min delayed, most complete)
async function scrapeNGXWebsite() {
  try {
    const html = await fetchUrl('https://ngxgroup.com/exchange/data/equities-price-list/', 15000);
    const $ = cheerio.load(html);
    const stocks = {};

    // The NGX page renders a ticker strip at the top with current prices
    // Format: SYMBOL N{price} {change}%
    const tickerText = $('.ticker-wrap, .market-ticker, #ticker, [class*="ticker"]').text();
    if (tickerText) {
      const matches = [...tickerText.matchAll(/([A-Z]{2,12})\s+N([\d,]+\.?\d*)\s+([-+][\d.]+)/g)];
      matches.forEach(m => {
        const symbol = m[1];
        const price  = parseFloat(m[2].replace(/,/g, ''));
        const chg    = parseFloat(m[3]);
        if (symbol && price > 0) {
          const prevClose = price / (1 + chg / 100);
          stocks[symbol] = { symbol, name: symbol, price, prevClose: parseFloat(prevClose.toFixed(2)), change: chg, source: 'NGX' };
        }
      });
    }

    // Also try the main data table
    $('table tbody tr, .price-list-table tbody tr').each((i, row) => {
      const cols = $(row).find('td');
      if (cols.length < 4) return;

      const rawSym = $(cols[0]).text().trim().replace(/\s+/g, '');
      const symbol = rawSym.toUpperCase();
      if (!symbol || symbol.length > 14) return;

      const clean  = s => parseFloat(s.replace(/[₦,\s]/g, '')) || 0;
      const price  = clean($(cols[2]).text()) || clean($(cols[1]).text());
      const open   = clean($(cols[3]).text());
      const high   = clean($(cols[4] ? $(cols[4]).text() : ''));
      const low    = clean($(cols[5] ? $(cols[5]).text() : ''));
      const vol    = clean($(cols[6] ? $(cols[6]).text() : ''));
      const name   = $(cols[1]).text().trim() || symbol;

      if (price > 0) {
        stocks[symbol] = { symbol, name, price, open: open||price, high: high||price, low: low||price, volume: vol, source: 'NGX' };
      }
    });

    // Parse inline JSON if the page uses it (many modern exchange sites do)
    const jsonMatches = html.match(/var\s+(?:stockData|priceList|equities)\s*=\s*(\[[\s\S]*?\]);/);
    if (jsonMatches) {
      try {
        const arr = JSON.parse(jsonMatches[1]);
        arr.forEach(item => {
          const sym = (item.symbol || item.ticker || item.code || '').toUpperCase();
          const price = parseFloat(item.close || item.price || item.last || 0);
          if (sym && price > 0) {
            stocks[sym] = {
              symbol: sym,
              name: item.name || item.companyName || sym,
              price,
              prevClose: parseFloat(item.prevClose || item.prev_close || 0) || price,
              open:   parseFloat(item.open  || 0) || price,
              high:   parseFloat(item.high  || 0) || price,
              low:    parseFloat(item.low   || 0) || price,
              volume: parseFloat(item.volume || item.vol || 0),
              source: 'NGX',
            };
          }
        });
      } catch (_) {}
    }

    console.log(`[NGX website] parsed ${Object.keys(stocks).length} stocks`);
    return Object.keys(stocks).length > 0 ? stocks : null;
  } catch (e) {
    console.log('[NGX website] failed:', e.message);
    return null;
  }
}

// Source 2: afx.kwayisi.org/ngx — independent NGX aggregator, updated daily
async function scrapeAfxKwayisi() {
  try {
    // Fetch multiple pages (paginated ~30 stocks each)
    const pages = [1, 2, 3, 4, 5];
    const stocks = {};

    await Promise.all(pages.map(async (page) => {
      try {
        const url = page === 1
          ? 'https://afx.kwayisi.org/ngx/'
          : `https://afx.kwayisi.org/ngx/?page=${page}`;

        const pageHtml = await fetchUrl(url, 10000);
        const $ = cheerio.load(pageHtml);

        $('table tbody tr').each((i, row) => {
          const cols = $(row).find('td');
          if (cols.length < 4) return;

          // AFX table: Rank | Company | Symbol | Price | Change | Volume
          // or: Symbol | Name | Price | Change
          let symbol, name, price, prevClose, change, volume;

          const text0 = $(cols[0]).text().trim();
          const text1 = $(cols[1]).text().trim();
          const text2 = $(cols[2]).text().trim();
          const text3 = $(cols[3]).text().trim();

          const clean = s => parseFloat(s.replace(/[₦,\s+%]/g, '')) || 0;

          // Detect column layout by whether col0 is a number (rank) or symbol
          if (/^\d+$/.test(text0)) {
            // Rank | Name | Symbol | Price | Change | Volume
            name      = text1;
            symbol    = text2.toUpperCase();
            price     = clean(text3);
            change    = cols.length > 4 ? clean($(cols[4]).text()) : 0;
            volume    = cols.length > 5 ? clean($(cols[5]).text()) : 0;
          } else {
            // Symbol | Name | Price | Change
            symbol    = text0.toUpperCase();
            name      = text1;
            price     = clean(text2);
            change    = clean(text3);
            volume    = cols.length > 4 ? clean($(cols[4]).text()) : 0;
          }

          if (!symbol || symbol.length > 14 || price <= 0) return;

          // Derive prevClose from change%
          prevClose = change !== 0 ? parseFloat((price / (1 + change / 100)).toFixed(2)) : price;

          // Get link to individual stock page for name if needed
          const link = $(row).find('a').attr('href') || '';

          stocks[symbol] = {
            symbol,
            name: name || symbol,
            price,
            prevClose,
            change,
            volume,
            source: 'AFX/NGX',
          };
        });
      } catch (e) {
        // Page might not exist, that's fine
      }
    }));

    console.log(`[AFX Kwayisi] parsed ${Object.keys(stocks).length} stocks`);
    return Object.keys(stocks).length > 0 ? stocks : null;
  } catch (e) {
    console.log('[AFX Kwayisi] failed:', e.message);
    return null;
  }
}

// Source 3: Proshare live market summary
async function scrapeProshareLive() {
  try {
    const html = await fetchUrl('https://proshare.net/market/ngx-live-market', 12000);
    const $ = cheerio.load(html);
    const stocks = {};

    $('table tbody tr, .market-data-row').each((i, row) => {
      const cols = $(row).find('td');
      if (cols.length < 3) return;
      const clean  = s => parseFloat(s.replace(/[₦,\s]/g, '')) || 0;
      const symbol = $(cols[0]).text().trim().toUpperCase().replace(/\s+/g,'');
      const price  = clean($(cols[1]).text());
      const prev   = clean($(cols[2]).text());
      if (!symbol || symbol.length > 14 || price <= 0) return;
      stocks[symbol] = { symbol, name: symbol, price, prevClose: prev || price, source: 'Proshare' };
    });

    // Also try JSON embedded in page
    const json = html.match(/"prices"\s*:\s*(\[[\s\S]*?\])/);
    if (json) {
      try {
        JSON.parse(json[1]).forEach(item => {
          const sym = (item.symbol||'').toUpperCase();
          const price = parseFloat(item.price||0);
          if (sym && price > 0) {
            stocks[sym] = { symbol: sym, name: item.name||sym, price, prevClose: parseFloat(item.prevClose||price), source: 'Proshare' };
          }
        });
      } catch (_) {}
    }

    console.log(`[Proshare] parsed ${Object.keys(stocks).length} stocks`);
    return Object.keys(stocks).length > 0 ? stocks : null;
  } catch (e) {
    console.log('[Proshare] failed:', e.message);
    return null;
  }
}

function getDemoData() {
  // Only used if explicitly requested — not auto-fallback anymore
  const base = {
    'DANGCEM':  { name: 'Dangote Cement',       price: 620.00,  prevClose: 612.50,  open: 612.50,  high: 625.00,  low: 610.00,  volume: 1245800 },
    'GTCO':     { name: 'Guaranty Trust',        price: 48.50,   prevClose: 47.20,   open: 47.20,   high: 49.10,   low: 46.80,   volume: 8923400 },
    'AIRTELAFRI':{ name: 'Airtel Africa',        price: 2180.00, prevClose: 2150.00, open: 2150.00, high: 2195.00, low: 2140.00, volume: 342100  },
    'MTNN':     { name: 'MTN Nigeria',           price: 915.00,  prevClose: 870.00,  open: 870.00,  high: 920.00,  low: 865.00,  volume: 4120500 },
    'ZENITHBANK':{ name: 'Zenith Bank',          price: 37.80,   prevClose: 36.90,   open: 36.90,   high: 38.20,   low: 36.50,   volume: 12034200},
    'ACCESS':   { name: 'Access Holdings',       price: 22.45,   prevClose: 21.80,   open: 21.80,   high: 22.90,   low: 21.60,   volume: 9876500 },
    'BUACEMENT':{ name: 'BUA Cement',            price: 115.00,  prevClose: 113.50,  open: 113.50,  high: 116.80,  low: 112.00,  volume: 2134500 },
    'SEPLAT':   { name: 'Seplat Energy',         price: 11495.00,prevClose: 10450.00,open: 10450.00,high: 11500.00,low:10400.00, volume: 189300  },
    'FBNH':     { name: 'FBN Holdings',          price: 28.60,   prevClose: 29.10,   open: 29.10,   high: 29.50,   low: 28.30,   volume: 7654300 },
    'NB':       { name: 'Nigerian Breweries',    price: 78.70,   prevClose: 79.50,   open: 79.50,   high: 80.00,   low: 78.00,   volume: 1098700 },
    'NESTLE':   { name: 'Nestle Nigeria',        price: 3100.00, prevClose: 3100.00, open: 3100.00, high: 3100.00, low: 3050.00, volume: 87600   },
    'UBA':      { name: 'United Bank for Africa',price: 24.10,   prevClose: 23.50,   open: 23.50,   high: 24.50,   low: 23.30,   volume: 11234500},
    'STANBIC':  { name: 'Stanbic IBTC',          price: 72.50,   prevClose: 71.00,   open: 71.00,   high: 73.20,   low: 70.50,   volume: 987600  },
    'NAHCO':    { name: 'NAHCO',                 price: 258.00,  prevClose: 240.00,  open: 240.00,  high: 260.00,  low: 238.00,  volume: 234500  },
    'FLOURMILL':{ name: 'Flour Mills Nigeria',   price: 45.50,   prevClose: 44.80,   open: 44.80,   high: 46.10,   low: 44.50,   volume: 1456700 },
    'FLOURMILL':{ name: 'Flour Mills Nigeria',   price: 45.50,   prevClose: 44.80,   open: 44.80,   high: 46.10,   low: 44.50,   volume: 1456700 },
    'OANDO':    { name: 'Oando',                 price: 19.80,   prevClose: 19.20,   open: 19.20,   high: 20.10,   low: 19.00,   volume: 3421000 },
    'PRESCO':   { name: 'Presco',                price: 380.00,  prevClose: 375.00,  open: 375.00,  high: 385.00,  low: 373.00,  volume: 145600  },
    'CADBURY':  { name: 'Cadbury Nigeria',       price: 25.60,   prevClose: 24.90,   open: 24.90,   high: 26.00,   low: 24.80,   volume: 876500  },
    'WAPCO':    { name: 'Lafarge Africa',        price: 42.80,   prevClose: 42.00,   open: 42.00,   high: 43.50,   low: 41.80,   volume: 678900  },
    'ECOBANK':  { name: 'Ecobank Transnational', price: 21.30,   prevClose: 20.80,   open: 20.80,   high: 21.70,   low: 20.60,   volume: 5678900 },
  };

  // Add small random walk to simulate live prices
  const result = {};
  for (const [sym, d] of Object.entries(base)) {
    const delta = (Math.random() - 0.48) * d.price * 0.008;
    const price = parseFloat((d.price + delta).toFixed(2));
    result[sym] = { ...d, symbol: sym, price, source: 'Demo' };
  }
  return result;
}

// ── History & signals ────────────────────────────────────────────────────────
const priceHistory = {};   // symbol → [price, price, ...]  (last 20 ticks)

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

  // RSI (simplified 14-period — uses available history)
  const changes = hist.slice(1).map((p, i) => p - hist[i]);
  const gains = changes.filter(c => c > 0);
  const losses = changes.filter(c => c < 0).map(Math.abs);
  const avgGain = gains.length ? gains.reduce((a,b)=>a+b,0)/changes.length : 0;
  const avgLoss = losses.length ? losses.reduce((a,b)=>a+b,0)/changes.length : 0;
  const rs   = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi  = parseFloat((100 - 100/(1+rs)).toFixed(1));

  // Simple MA crossover
  const short = hist.slice(-3).reduce((a,b)=>a+b,0)/3;
  const long  = hist.reduce((a,b)=>a+b,0)/hist.length;

  let signal = 'HOLD', strength = 50;
  if (rsi < 35 && short > long * 0.998) { signal = 'BUY';  strength = Math.min(90, 50 + (35-rsi)*2); }
  else if (rsi > 65 && short < long * 1.002) { signal = 'SELL'; strength = Math.min(90, 50 + (rsi-65)*2); }
  else if (short > long * 1.003)  { signal = 'BUY';  strength = 60; }
  else if (short < long * 0.997)  { signal = 'SELL'; strength = 60; }

  return { signal, strength: Math.round(strength), rsi };
}

// ── Refresh loop ─────────────────────────────────────────────────────────────
async function startRefreshLoop() {
  const refresh = async () => {
    try {
      const data = await scrapeNGX();
      const gotData = Object.keys(data).length > 0;
      if (gotData) {
        updateHistory(data);
        stockData = data;
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('stock-update', {
          stocks: stockData,
          history: priceHistory,
          liveDataAvailable: gotData,
          stockCount: Object.keys(stockData).length,
        });
      }
    } catch (e) {
      console.error('Refresh error:', e.message);
    }
  };

  await refresh();
  refreshInterval = setInterval(refresh, 30000);
}

// ── IPC handlers ─────────────────────────────────────────────────────────────
ipcMain.handle('get-all-symbols', () => Object.keys(stockData).sort());
ipcMain.handle('get-signal', (_, sym) => computeSignal(sym));
ipcMain.handle('get-history', (_, sym) => priceHistory[sym] || []);
ipcMain.handle('set-refresh-rate', (_, ms) => {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(async () => {
    const data = await scrapeNGX();
    const gotData = Object.keys(data).length > 0;
    if (gotData) { updateHistory(data); stockData = data; }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('stock-update', {
        stocks: stockData, history: priceHistory,
        liveDataAvailable: gotData, stockCount: Object.keys(stockData).length,
      });
    }
  }, ms);
});

ipcMain.on('close-app',    () => app.quit());
ipcMain.on('minimize-app', () => mainWindow.minimize());
ipcMain.on('toggle-pin',   () => mainWindow.setAlwaysOnTop(!mainWindow.isAlwaysOnTop()));

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
