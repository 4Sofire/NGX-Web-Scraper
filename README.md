# NGX Ticker-Nigerian Exchange Desktop Widget

A compact always-on-top Electron desktop app that tracks Nigerian Exchange Group (NGX) stocks in real time with price analysis, sparklines, RSI, and buy/sell signals.

---

## Features

- **Live prices** scraped from NGX Group website (falls back to demo data if offline)
- **Watchlist** — pick exactly which stocks you follow
- **All Stocks** catalogue — browse/search all available NGX equities
- **Analysis tab** — RSI indicator, day range bar, volume, price change %, and buy/sell/hold signal per stock
- **Sparkline charts** — mini price history on every card
- **Always on top** — stays visible as you work
- **Auto-refresh** — 10 s / 30 s / 60 s / 5 min intervals
- **Right-click** a ticker card to remove it from your watchlist

---

## Setup

### 1. Install Node.js
Download from https://nodejs.org (v18 or later recommended).

### 2. Install dependencies
Open a terminal in this folder and run:

```bash
npm install
```

### 3. Launch the app

```bash
npm start
```

The widget appears in the bottom-right corner of your screen.

---

## Usage

| Action | How |
|--------|-----|
| Add a stock | Go to **All Stocks** tab → click **+** next to any symbol |
| Remove a stock | **Right-click** its card in the Watchlist tab |
| Pin / unpin on top | Click the **green dot** button in the title bar |
| Minimise | Click the **yellow dot** button |
| Close | Click the **red dot** button |
| Change refresh rate | Footer dropdown |

---

## Data Sources

The app attempts to scrape live data from:
1. **NGX Group Equities Price List** — `ngxgroup.com/exchange/data/equities-price-list/`
2. **Cowrywise market data** (fallback)

If both fail (network issues, page structure changes), the app loads **demo data** with simulated price movements so the UI always works.

---

## Signal Logic

| Signal | Condition |
|--------|-----------|
| **BUY** | RSI < 35 and short MA trending above long MA |
| **SELL** | RSI > 65 and short MA trending below long MA |
| **HOLD** | MA crossover without extreme RSI |
| **WAIT** | Insufficient price history (< 5 ticks) |

> These are **technical indicators only** — not financial advice. Always do your own research.

---

## Updating the Scraper

If NGX changes their website layout, edit the `scrapeNGXEquities()` function in `main.js`. The CSS selectors to target are inside the `$('table tbody tr').each(...)` block.

---

## Requirements

- Node.js 18+
- npm
- Internet connection (for live data)
- Windows 10/11, macOS 12+, or Linux (Ubuntu 20+)
