# TickerQuest

TickerQuest combines a free portfolio/watchlist scorecard with a private eight-player family stock game. The public dashboard remains on GitHub Pages and refreshes market data on a weekday schedule. The family game adds shared invitations, simulated trading, realistic tax accounting, and an after-tax leaderboard without requiring anyone to create an account.

## Family Portfolio League

Open `game.html` from the dashboard and create a one-week or one-month league. The host receives eight unique private invitation links. A family member follows one link, enters a display name, and immediately receives $10,000 of simulated cash.

The host can:

- invite up to eight players without email addresses or passwords;
- occupy a player seat while retaining separate host controls;
- reissue an unclaimed invitation or clear a lobby seat;
- start after at least two players have joined; and
- end the game early and lock the final standings.

Players can enter any valid U.S.-listed stock or ETF ticker, check its newest available price, and buy or sell fractional shares whenever the game is active, including nights and weekends. The original dashboard watchlist is only a suggestion list and does not limit game purchases. Orders use the newest shared quote available—regular-market, pre-market, after-hours, or the most recent closing snapshot—and show that quote’s source and timestamp before execution. A quote more than seven days old cannot execute a trade. Everyone can see the leaderboard, each player’s current holdings, and recent league activity. The page is designed for phone use and refreshes the shared game every minute.

### Game taxation

The family league uses a consistent simulated tax model:

- every sale realizes a gain or loss whether or not the proceeds are reinvested;
- purchase lots are sold first-in, first-out;
- net realized losses offset net realized gains;
- 24% of positive net realized gains is locked as a tax reserve;
- reserved tax cannot be spent and is subtracted from leaderboard value; and
- a loss followed by a same-ticker repurchase within 30 days is deferred into the replacement lot’s cost basis.

Rank is determined by:

```text
after-tax value = cash + current holdings value − tax reserve
```

These are transparent game rules, not individualized tax calculations or tax advice.

### Shared-service architecture

GitHub Pages serves the public game interface. A small Cloudflare-compatible service stores games, seats, trades, FIFO lots, and wash-sale adjustments in D1. Raw host and player tokens are only returned in private links; the database stores their SHA-256 hashes. The host’s original eight invitation links are also kept in that host browser so they can be copied again without an account.

The service source lives in the same repository:

- `app/api/game/route.ts` — game API, authentication, market checks, and trades;
- `db/schema.ts` and `drizzle/` — durable shared database schema;
- `lib/game-rules.js` — testable money, FIFO, tax, and wash-sale calculations; and
- `site/game.html`, `site/game.css`, and `site/game.js` — family-facing interface.

Because this first version deliberately avoids accounts, a lost private player link cannot be recovered; the host can reissue that seat before the game starts. A lost host link means the host controls cannot be recovered from another browser.

## Change the tracked tickers

Edit [`config/watchlist.json`](config/watchlist.json). Each item needs a market symbol and can include a display name:

The included lineup is NVDA, META, AMD, MSFT, GOOG, TSM, and EOSE. The file uses this shape:

```json
[
  { "symbol": "NVDA", "name": "NVIDIA" },
  { "symbol": "META", "name": "Meta Platforms" }
]
```

The next scheduled run will refresh those symbols. Visitors can keep stocks they are considering in a separate browser-local Watchlist without affecting portfolio value, weighting, P&L, or scores. Recording a purchase from a watched ticker moves it into the portfolio automatically.

The trend selector includes daily, weekly, one-year, and five-year views. One-year and five-year lines use weekly historical closes, while the selected horizon also controls the ordering and line color of positions and watched stocks.

Visitors can also add or remove holdings and record any number of purchases for the same ticker, each with its own share count and price paid. The page aggregates the lots into total shares, weighted average cost, cost basis, and unrealized gain or loss. These personal choices stay in that browser. Existing version-one share counts migrate automatically as purchase lots with an unknown price, ready for the user to fill in. A symbol added only in the browser will show as pending until it is also added to `config/watchlist.json`.

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

Small information controls beside Market Value, Momentum Score, Cost Basis, Overnight Pulse, and each stock's points reveal these definitions on hover, keyboard activation, or tap without adding permanent explanatory sections to the dashboard.

The Overnight Pulse combines three components:

```text
50% portfolio pre-market/after-hours movement
25% latest Nikkei, Hang Seng, Shanghai, KOSPI, and Taiwan index movement
25% time-decayed headline signal from an 18-hour GDELT news scan
```

The headline scan groups market-relevant coverage into geopolitics, policy, and AI/chips. It can capture reporting about major political or social-media statements, including Trump posts, but does not claim to be a direct or complete archive of any social network.

## Data and limitations

The updater uses the open-source `yfinance` package and public Yahoo Finance endpoints for prices, plus the GDELT DOC 2.0 API for recent news coverage. Neither requires an API key. Quotes and news can be delayed, corrected, unavailable, rate-limited, or incomplete. When a component is missing, the page labels the Overnight Pulse as partial instead of manufacturing a signal. The page always shows its last update time.

## License

MIT. Market data remains subject to the upstream provider's terms.
