# TickerQuest

A free, static portfolio scorecard for GitHub Pages. TickerQuest refreshes market data on a weekday schedule, includes pre-market and after-hours observations when the source exposes them, tracks purchase-lot cost basis and unrealized return, and turns daily and weekly momentum into a transparent 0–100 score.

## Change the tracked tickers

Edit [`config/watchlist.json`](config/watchlist.json). Each item needs a market symbol and can include a display name:

The included lineup is NVDA, META, AMD, MSFT, GOOG, TSM, and EOSE. The file uses this shape:

```json
[
  { "symbol": "NVDA", "name": "NVIDIA" },
  { "symbol": "META", "name": "Meta Platforms" }
]
```

The next scheduled run will refresh those symbols. Visitors can add or remove symbols and record any number of purchases for the same ticker, each with its own share count and price paid. The page aggregates the lots into total shares, weighted average cost, cost basis, and unrealized gain or loss. These personal choices stay in that browser. Existing version-one share counts migrate automatically as purchase lots with an unknown price, ready for the user to fill in. A symbol added only in the browser will show as pending until it is also added to `config/watchlist.json`.

## Publish on GitHub Pages

1. Push this repository to `kleinlab-yale/stocks` with `main` as its default branch.
2. In **Settings → Pages**, set **Source** to **GitHub Actions**.
3. Run **Actions → Refresh market data & publish → Run workflow** once, or wait for the schedule.

The workflow publishes `site/` to `https://kleinlab-yale.github.io/stocks/`. It refreshes every 15 minutes on weekdays across the U.S. pre-market, regular, and after-hours window. GitHub schedules can start late during busy periods, so the timestamp and freshness label in the page are authoritative.

## Run locally

```bash
python3 -m http.server 8000 --directory site
```

Then open `http://localhost:8000`.

To refresh the data locally:

```bash
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
.venv/bin/python scripts/fetch_market_data.py
```

## Scoring

Each stock receives a momentum score:

```text
50 + 25 × tanh(day % ÷ 3) + 25 × tanh(week % ÷ 7)
```

The portfolio score is weighted by each holding's current market value. Total return uses only the purchase lots with a recorded price and clearly reports partial cost coverage when some historical prices are still missing. Scores are descriptive game mechanics, not predictions or investment recommendations.

## Data and limitations

The updater uses the open-source `yfinance` package and public Yahoo Finance endpoints. It needs no API key, but it is unofficial and intended for personal/research use. Quotes can be delayed, corrected, unavailable, or temporarily blocked. The page always shows its last update time and degrades to the last successful snapshot.

## License

MIT. Market data remains subject to the upstream provider's terms.
