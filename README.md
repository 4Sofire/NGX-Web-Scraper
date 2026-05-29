# NGX Ticker-Nigerian Exchange Desktop Widget

---

## Features

- **Live prices** achieved using a personal tier API from ngxpulse.ng
- **Watchlist**-pick exactly which stocks you would like to follow
- **All Stocks** catalogue-browse/search all available NGX equities
- **Analysis tab**-Relative Strength indicator (RSI), day range bar, volume, price change %, and buy/sell/hold signal per stock
- **Sparkline charts**-mini price history on every card
- **Always on top**-stays visible as you work
- **Auto-refresh**-refreshes every 10 min during market hours and every 60 minutes outside market hours
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
| Add a stock | Go to **All Stocks** tab, click **+** next to any symbol |
| Remove a stock | **Right-click** its card in the Watchlist tab |
| Pin / unpin on top | Click the **green dot** button in the title bar |
| Minimise | Click the **yellow dot** button |
| Close | Click the **red dot** button |
| Refresh | Footer dropdown |

---

## Signal Logic

| Signal | Condition |
|--------|-----------|
| **BUY** | RSI < 35 and short MA trending above long Moving Average (MA) |
| **SELL** | RSI > 65 and short MA trending below long MA |
| **HOLD** | MA crossover without extreme RSI |
| **WAIT** | Insufficient price history (< 5 ticks) |

> These are **technical indicators only**, not financial advice. Always do your own research.
