import { getD1 } from "@/db";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import {
  afterTaxValueCents,
  allocateFifoSale,
  applyPendingWashLosses,
  completedCompetitionPeriod,
  dividendGrossCents,
  easternTimestampForUsDate,
  endGameConfirmationIsValid,
  gameEndsAt,
  grossCents,
  microsToShares,
  quoteTimestampIsExecutable,
  selectPeriodBonusWinner,
  sharesHeldMicrosAt,
  sharesToMicros,
  targetValueReached,
  totalTaxReserveCents,
  tradingIsActive,
} from "@/lib/game-rules.js";
import {
  cryptoBaseSymbol,
  cryptoDisplayName,
  isCryptoPair,
  normalizeTradableSymbol,
} from "@/lib/tradable-symbols.js";

export const dynamic = "force-dynamic";

const MARKET_URL =
  "https://kleinlab-yale.github.io/stocks/data/market.json";
const NASDAQ_QUOTE_URL = "https://api.nasdaq.com/api/quote";
const COINBASE_PRODUCTS_URL = "https://api.exchange.coinbase.com/products";
const STATIC_ORIGIN = "https://kleinlab-yale.github.io";
const ALLOWED_ORIGINS = new Set([
  STATIC_ORIGIN,
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);
const STARTING_CASH_CENTS = 1_000_000;
const MIN_STARTING_CASH_CENTS = 10_000;
const MAX_STARTING_CASH_CENTS = 10_000_000_000;
const MAX_TARGET_VALUE_CENTS = 100_000_000_000;
const TAX_RATE_BPS = 2_400;
const MAX_SEATS = 10;
const WASH_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_EXECUTION_QUOTE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const QUOTE_MEMORY_TTL_MS = 60 * 1_000;
const MARKET_MEMORY_TTL_MS = 30 * 1_000;
const MARKET_FETCH_TIMEOUT_MS = 6 * 1_000;
const QUOTE_FETCH_TIMEOUT_MS = 6 * 1_000;
const DIVIDEND_CACHE_TTL_MS = 12 * 60 * 60 * 1_000;
const PORTFOLIO_SNAPSHOT_INTERVAL_MS = 30 * 60 * 1_000;
const MAX_TREND_POINTS = 120;
const PERIOD_BONUSES_CENTS = {
  day: 10_000,
  week: 100_000,
  month: 1_000_000,
} as const;

type GameRow = {
  id: string;
  name: string;
  host_token_hash: string;
  status: string;
  starting_cash_cents: number;
  tax_rate_bps: number;
  duration_days: number;
  target_value_cents: number | null;
  winner_seat_id: string | null;
  period_bonuses_enabled: number;
  dividends_enabled_at: number | null;
  created_at: number;
  started_at: number | null;
  ends_at: number | null;
  ended_at: number | null;
};

type SeatRow = {
  id: string;
  game_id: string;
  seat_number: number;
  invite_token_hash: string;
  player_name: string | null;
  joined_at: number | null;
  cash_cents: number;
  bonus_cents: number;
  dividend_income_cents: number;
  dividend_tax_cents: number;
  realized_net_cents: number;
  tax_reserve_cents: number;
};

type LotRow = {
  id: string;
  game_id: string;
  seat_id: string;
  symbol: string;
  acquired_at: number;
  original_shares_micros: number;
  remaining_shares_micros: number;
  remaining_basis_cents: number;
  source_trade_id: string;
};

type WashLossRow = {
  id: string;
  remaining_shares_micros: number;
  remaining_loss_cents: number;
};

type MarketSymbol = {
  symbol: string;
  name?: string;
  price: number | null;
  regularPrice?: number | null;
  previousClose?: number | null;
};

type MarketSnapshot = {
  generatedAt: string;
  mode: string;
  session?: { label?: string };
  symbols: MarketSymbol[];
};

type ResolvedQuote = {
  symbol: string;
  name: string;
  priceCents: number;
  previousCloseCents: number | null;
  generatedAt: string;
  source: string;
};

type QuoteCacheRow = {
  symbol: string;
  name: string;
  price_cents: number;
  previous_close_cents: number | null;
  quoted_at: number;
  source: string;
  updated_at: number;
};

type PortfolioSnapshotRow = {
  range_name: string;
  seat_id: string;
  after_tax_cents: number;
  captured_at: number;
};

type PeriodValueRow = {
  seat_id: string;
  anchor_value: number | null;
  anchor_at: number | null;
  first_value: number | null;
  first_at: number | null;
  end_value: number | null;
  end_at: number | null;
};

type NasdaqInfoResponse = {
  data?: {
    symbol?: string;
    companyName?: string;
    primaryData?: {
      lastSalePrice?: string;
      lastTradeTimestamp?: string;
    };
    secondaryData?: {
      lastSalePrice?: string;
    } | null;
  } | null;
  status?: { rCode?: number };
};

type NasdaqDividendRow = {
  exOrEffDate?: string;
  type?: string;
  amount?: string;
  paymentDate?: string;
  currency?: string;
};

type NasdaqDividendResponse = {
  data?: {
    dividends?: { rows?: NasdaqDividendRow[] | null } | null;
  } | null;
  status?: { rCode?: number };
};

type CoinbaseProductResponse = {
  id?: string;
  base_currency?: string;
  quote_currency?: string;
  status?: string;
  trading_disabled?: boolean;
};

type CoinbaseTickerResponse = {
  price?: string;
  time?: string;
};

type DividendEvent = {
  exDate: string;
  paymentDate: string;
  amountPerShareMicros: number;
};

type DividendCacheRow = {
  symbol: string;
  payload_json: string;
  fetched_at: number;
};

type DividendTradeRow = {
  seat_id: string;
  symbol: string;
  side: string;
  shares_micros: number;
  created_at: number;
};

const quoteMemoryCache = new Map<
  string,
  { expiresAt: number; quote: ResolvedQuote }
>();
const quoteRefreshesInFlight = new Set<string>();
const dividendRefreshesInFlight = new Set<string>();
let marketMemoryCache:
  | { expiresAt: number; snapshot: MarketSnapshot }
  | undefined;

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function corsHeaders(request: Request) {
  const requestOrigin = request.headers.get("origin");
  const origin =
    requestOrigin && ALLOWED_ORIGINS.has(requestOrigin)
      ? requestOrigin
      : STATIC_ORIGIN;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, X-Game-Role, X-Creator-Player-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

function json(
  request: Request,
  data: unknown,
  status = 200,
): Response {
  return Response.json(data, { status, headers: corsHeaders(request) });
}

function cleanName(value: unknown, fallback: string, max = 40) {
  const cleaned = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
  return cleaned || fallback;
}

function cleanSymbol(value: unknown) {
  const symbol = String(value ?? "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z][A-Z0-9.-]{0,13}$/.test(symbol)) {
    throw new HttpError(400, "Enter a valid ticker.");
  }
  return symbol;
}

function bearerToken(request: Request) {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function creatorPlayerToken(request: Request) {
  return (request.headers.get("x-creator-player-token") ?? "").trim();
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function tokenHash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function requestBody(request: Request) {
  try {
    return (await request.json()) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "The request body must be valid JSON.");
  }
}

async function gameById(db: D1Database, gameId: string) {
  const game = await db
    .prepare("SELECT * FROM games WHERE id = ?")
    .bind(gameId)
    .first<GameRow>();
  if (!game) throw new HttpError(404, "Game not found.");
  return game;
}

async function requireHost(
  db: D1Database,
  gameId: string,
  token: string,
) {
  if (!token) throw new HttpError(401, "The host link is required.");
  const game = await gameById(db, gameId);
  if ((await tokenHash(token)) !== game.host_token_hash) {
    throw new HttpError(403, "This host link is not valid.");
  }
  return game;
}

async function requireCreatorHost(
  db: D1Database,
  gameId: string,
  request: Request,
) {
  const authorizationToken = bearerToken(request);
  const suppliedCreatorToken = creatorPlayerToken(request);
  const playerToken = suppliedCreatorToken || authorizationToken;
  const creatorSeat = await requirePlayer(db, gameId, playerToken);
  if (creatorSeat.seat_number !== 1) {
    throw new HttpError(
      403,
      "Only the game creator in Seat 1 can use Host controls.",
    );
  }
  if (suppliedCreatorToken && suppliedCreatorToken !== authorizationToken) {
    return requireHost(db, gameId, authorizationToken);
  }
  return gameById(db, gameId);
}

async function requirePlayer(
  db: D1Database,
  gameId: string,
  token: string,
) {
  if (!token) throw new HttpError(401, "A player invitation is required.");
  const hash = await tokenHash(token);
  const seat = await db
    .prepare(
      "SELECT * FROM seats WHERE game_id = ? AND invite_token_hash = ?",
    )
    .bind(gameId, hash)
    .first<SeatRow>();
  if (!seat) throw new HttpError(403, "This player invitation is not valid.");
  return seat;
}

async function fetchMarket() {
  if (marketMemoryCache && marketMemoryCache.expiresAt > Date.now()) {
    return marketMemoryCache.snapshot;
  }
  try {
    const cacheWindow = Math.floor(Date.now() / MARKET_MEMORY_TTL_MS);
    const response = await fetch(`${MARKET_URL}?game=${cacheWindow}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(MARKET_FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Market snapshot returned ${response.status}.`);
    }
    const snapshot = (await response.json()) as MarketSnapshot;
    marketMemoryCache = {
      expiresAt: Date.now() + MARKET_MEMORY_TTL_MS,
      snapshot,
    };
    return snapshot;
  } catch {
    if (marketMemoryCache) return marketMemoryCache.snapshot;
    throw new HttpError(503, "The shared market snapshot is unavailable.");
  }
}

function moneyStringToCents(value: unknown) {
  const amount = Number(
    String(value ?? "")
      .replace(/[^0-9.-]/g, ""),
  );
  return Number.isFinite(amount) && amount > 0
    ? Math.round(amount * 100)
    : null;
}

function nasdaqTimestamp(value: unknown) {
  const text = String(value ?? "").trim();
  const normalized = text.replace(/\s+ET$/i, " GMT-0400");
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : Date.now();
}

function snapshotQuote(
  snapshot: MarketSnapshot,
  symbol: string,
): ResolvedQuote | null {
  const item = snapshot.symbols.find((candidate) => candidate.symbol === symbol);
  const price = Number(item?.price);
  if (!item || !Number.isFinite(price) || price <= 0) return null;
  const previousClose = Number(item.previousClose);
  return {
    symbol,
    name: item.name ?? symbol,
    priceCents: Math.round(price * 100),
    previousCloseCents:
      Number.isFinite(previousClose) && previousClose > 0
        ? Math.round(previousClose * 100)
        : null,
    generatedAt: snapshot.generatedAt,
    source: "TickerQuest extended-hours feed",
  };
}

async function cachedQuote(db: D1Database, symbol: string) {
  const row = await db
    .prepare("SELECT * FROM quote_cache WHERE symbol = ?")
    .bind(symbol)
    .first<QuoteCacheRow>();
  if (!row) return null;
  return {
    quote: {
      symbol: row.symbol,
      name: row.name,
      priceCents: row.price_cents,
      previousCloseCents: row.previous_close_cents,
      generatedAt: new Date(row.quoted_at).toISOString(),
      source: row.source,
    } satisfies ResolvedQuote,
    updatedAt: row.updated_at,
  };
}

async function cachedQuotes(db: D1Database, symbols: string[]) {
  if (!symbols.length) return [];
  const placeholders = symbols.map(() => "?").join(", ");
  const rows = await db
    .prepare(
      `SELECT * FROM quote_cache WHERE symbol IN (${placeholders})`,
    )
    .bind(...symbols)
    .all<QuoteCacheRow>();
  return rows.results.map(
    (row) =>
      ({
        symbol: row.symbol,
        name: row.name,
        priceCents: row.price_cents,
        previousCloseCents: row.previous_close_cents,
        generatedAt: new Date(row.quoted_at).toISOString(),
        source: row.source,
      }) satisfies ResolvedQuote,
  );
}

async function fetchNasdaqInfo(
  symbol: string,
  assetClass: "stocks" | "etf",
): Promise<ResolvedQuote | null> {
  const response = await fetch(
    `${NASDAQ_QUOTE_URL}/${encodeURIComponent(symbol)}/info?assetclass=${assetClass}`,
    {
      cache: "no-store",
      signal: AbortSignal.timeout(QUOTE_FETCH_TIMEOUT_MS),
      headers: {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "Mozilla/5.0 TickerQuest/1.0",
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Nasdaq quote request returned ${response.status}.`);
  }
  const payload = (await response.json()) as NasdaqInfoResponse;
  const priceCents = moneyStringToCents(
    payload.data?.primaryData?.lastSalePrice,
  );
  if (
    payload.status?.rCode !== 200 ||
    !payload.data?.symbol ||
    !priceCents
  ) {
    return null;
  }
  return {
    symbol: cleanSymbol(payload.data.symbol),
    name: cleanName(payload.data.companyName, symbol, 80),
    priceCents,
    previousCloseCents: moneyStringToCents(
      payload.data.secondaryData?.lastSalePrice,
    ),
    generatedAt: new Date(
      nasdaqTimestamp(payload.data.primaryData?.lastTradeTimestamp),
    ).toISOString(),
    source: "Nasdaq Last Sale",
  };
}

async function fetchCoinbaseCryptoQuote(
  symbol: string,
): Promise<ResolvedQuote | null> {
  if (!isCryptoPair(symbol)) return null;
  const encodedSymbol = encodeURIComponent(symbol);
  const requestOptions = {
    cache: "no-store" as const,
    signal: AbortSignal.timeout(QUOTE_FETCH_TIMEOUT_MS),
    headers: {
      Accept: "application/json",
      "User-Agent": "TickerQuest/1.0",
    },
  };
  const [productResponse, tickerResponse] = await Promise.all([
    fetch(`${COINBASE_PRODUCTS_URL}/${encodedSymbol}`, requestOptions),
    fetch(`${COINBASE_PRODUCTS_URL}/${encodedSymbol}/ticker`, requestOptions),
  ]);
  if (productResponse.status === 404 || tickerResponse.status === 404) {
    return null;
  }
  if (!productResponse.ok || !tickerResponse.ok) {
    throw new Error("Coinbase crypto quote request failed.");
  }
  const product = (await productResponse.json()) as CoinbaseProductResponse;
  const ticker = (await tickerResponse.json()) as CoinbaseTickerResponse;
  const base = cryptoBaseSymbol(symbol);
  const price = Number(ticker.price);
  if (
    product.id !== symbol ||
    product.base_currency !== base ||
    product.quote_currency !== "USD" ||
    product.status !== "online" ||
    product.trading_disabled ||
    !Number.isFinite(price) ||
    price <= 0
  ) {
    return null;
  }
  if (price < 0.005) {
    throw new HttpError(
      422,
      `${symbol} trades below TickerQuest's one-cent price precision and is not available yet.`,
    );
  }
  const quotedAt = Date.parse(String(ticker.time ?? ""));
  return {
    symbol,
    name: cryptoDisplayName(symbol),
    priceCents: Math.round(price * 100),
    previousCloseCents: null,
    generatedAt: new Date(
      Number.isFinite(quotedAt) ? quotedAt : Date.now(),
    ).toISOString(),
    source: "Coinbase Exchange · Crypto 24/7",
  };
}

function dividendAmountToMicros(value: unknown) {
  const amount = Number(
    String(value ?? "")
      .replace(/[^0-9.-]/g, ""),
  );
  return Number.isFinite(amount) && amount > 0
    ? Math.round(amount * 1_000_000)
    : null;
}

function dividendEventsFromPayload(payload: NasdaqDividendResponse) {
  if (payload.status?.rCode !== 200) return [];
  return (payload.data?.dividends?.rows ?? [])
    .map((row): DividendEvent | null => {
      const amountPerShareMicros = dividendAmountToMicros(row.amount);
      const exDate = String(row.exOrEffDate ?? "").trim();
      const paymentDate = String(row.paymentDate ?? "").trim();
      if (
        row.type !== "Cash" ||
        (row.currency && row.currency !== "USD") ||
        !amountPerShareMicros ||
        easternTimestampForUsDate(exDate) === null ||
        easternTimestampForUsDate(paymentDate) === null
      ) {
        return null;
      }
      return { exDate, paymentDate, amountPerShareMicros };
    })
    .filter((event): event is DividendEvent => Boolean(event));
}

async function fetchNasdaqDividends(symbol: string) {
  for (const assetClass of ["stocks", "etf"]) {
    const response = await fetch(
      `${NASDAQ_QUOTE_URL}/${encodeURIComponent(symbol)}/dividends?assetclass=${assetClass}`,
      {
        cache: "no-store",
        signal: AbortSignal.timeout(QUOTE_FETCH_TIMEOUT_MS),
        headers: {
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": "Mozilla/5.0 TickerQuest/1.0",
        },
      },
    );
    if (!response.ok) continue;
    const payload = (await response.json()) as NasdaqDividendResponse;
    if (payload.status?.rCode === 200) {
      const events = dividendEventsFromPayload(payload);
      if (events.length || assetClass === "etf") return events;
    }
  }
  throw new Error(`Nasdaq did not return dividend data for ${symbol}.`);
}

async function cachedDividendEvents(
  db: D1Database,
  symbols: string[],
) {
  if (!symbols.length) return [];
  const placeholders = symbols.map(() => "?").join(", ");
  const rows = await db
    .prepare(
      `SELECT symbol, payload_json, fetched_at
       FROM dividend_event_cache
       WHERE symbol IN (${placeholders})`,
    )
    .bind(...symbols)
    .all<DividendCacheRow>();
  return rows.results.map((row) => {
    let events: DividendEvent[] = [];
    try {
      events = JSON.parse(row.payload_json) as DividendEvent[];
    } catch {
      events = [];
    }
    return { symbol: row.symbol, fetchedAt: row.fetched_at, events };
  });
}

function refreshDividendsInBackground(
  db: D1Database,
  symbols: string[],
  cached: Array<{ symbol: string; fetchedAt: number }>,
) {
  const context = getRequestExecutionContext();
  if (!context) return;
  const freshness = new Map(
    cached.map((item) => [item.symbol, item.fetchedAt]),
  );
  const pendingSymbols = symbols.filter(
    (symbol) =>
      !dividendRefreshesInFlight.has(symbol) &&
      Number(freshness.get(symbol) ?? 0) + DIVIDEND_CACHE_TTL_MS <= Date.now(),
  );
  if (!pendingSymbols.length) return;
  pendingSymbols.forEach((symbol) => dividendRefreshesInFlight.add(symbol));
  const refresh = Promise.allSettled(
    pendingSymbols.map(async (symbol) => {
      const events = await fetchNasdaqDividends(symbol);
      await db
        .prepare(
          `INSERT INTO dividend_event_cache (symbol, payload_json, fetched_at)
           VALUES (?, ?, ?)
           ON CONFLICT(symbol) DO UPDATE SET
             payload_json = excluded.payload_json,
             fetched_at = excluded.fetched_at`,
        )
        .bind(symbol, JSON.stringify(events), Date.now())
        .run();
    }),
  ).then(() => {
    pendingSymbols.forEach((symbol) => dividendRefreshesInFlight.delete(symbol));
  });
  context.waitUntil(refresh);
}

async function settleDividends(db: D1Database, game: GameRow) {
  if (
    !game.dividends_enabled_at ||
    !game.started_at ||
    game.status === "lobby"
  ) {
    return;
  }
  const symbolRows = await db
    .prepare("SELECT DISTINCT symbol FROM trades WHERE game_id = ?")
    .bind(game.id)
    .all<{ symbol: string }>();
  const symbols = symbolRows.results
    .map((row) => row.symbol)
    .filter((symbol) => !isCryptoPair(symbol));
  if (!symbols.length) return;

  const cached = await cachedDividendEvents(db, symbols);
  refreshDividendsInBackground(db, symbols, cached);
  if (!cached.length) return;

  const now = Date.now();
  const payable = cached
    .map((item) => ({
      ...item,
      events: item.events.filter((event) => {
        const exAt = easternTimestampForUsDate(event.exDate);
        const paymentAt = easternTimestampForUsDate(event.paymentDate);
        return (
          exAt !== null &&
          paymentAt !== null &&
          exAt >= game.dividends_enabled_at! &&
          exAt >= game.started_at! &&
          paymentAt <= now &&
          (!game.ended_at || paymentAt <= game.ended_at)
        );
      }),
    }))
    .filter((item) => item.events.length);
  if (!payable.length) return;

  const [joinedSeats, settledRows] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM seats
         WHERE game_id = ? AND player_name IS NOT NULL`,
      )
      .bind(game.id)
      .all<SeatRow>(),
    db
      .prepare(
        `SELECT seat_id, symbol, ex_date, payment_date
         FROM dividend_payments
         WHERE game_id = ? AND credited_at IS NOT NULL`,
      )
      .bind(game.id)
      .all<{
        seat_id: string;
        symbol: string;
        ex_date: string;
        payment_date: string;
      }>(),
  ]);
  const settledKeys = new Set(
    settledRows.results.map(
      (row) =>
        `${row.seat_id}:${row.symbol}:${row.ex_date}:${row.payment_date}`,
    ),
  );
  const hasOutstandingPayment = payable.some((item) =>
    item.events.some((event) =>
      joinedSeats.results.some(
        (seat) =>
          !settledKeys.has(
            `${seat.id}:${item.symbol}:${event.exDate}:${event.paymentDate}`,
          ),
      ),
    ),
  );
  if (!hasOutstandingPayment) return;
  const tradeRows = await db
    .prepare(
      `SELECT seat_id, symbol, side, shares_micros, created_at
       FROM trades
       WHERE game_id = ?
       ORDER BY created_at`,
    )
    .bind(game.id)
    .all<DividendTradeRow>();

  for (const item of payable) {
    for (const event of item.events) {
      const exAt = easternTimestampForUsDate(event.exDate)!;
      for (const seat of joinedSeats.results) {
        const paymentKey = `${seat.id}:${item.symbol}:${event.exDate}:${event.paymentDate}`;
        if (settledKeys.has(paymentKey)) continue;
        const eligibleTrades = tradeRows.results.filter(
          (tradeRow) =>
            tradeRow.seat_id === seat.id &&
            tradeRow.symbol === item.symbol,
        );
        const eligibleSharesMicros = sharesHeldMicrosAt(
          eligibleTrades,
          exAt,
        );
        const gross = dividendGrossCents(
          eligibleSharesMicros,
          event.amountPerShareMicros,
        );
        const tax = Math.max(
          0,
          Math.round((gross * game.tax_rate_bps) / 10_000),
        );
        const paymentId = await tokenHash(
          `dividend:${game.id}:${seat.id}:${item.symbol}:${event.exDate}:${event.paymentDate}`,
        );
        await db
          .prepare(
            `INSERT INTO dividend_payments (
              id, game_id, seat_id, symbol, ex_date, payment_date,
              shares_micros, amount_per_share_micros, gross_cents,
              tax_cents, credited_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(game_id, seat_id, symbol, ex_date, payment_date)
            DO NOTHING`,
          )
          .bind(
            paymentId,
            game.id,
            seat.id,
            item.symbol,
            event.exDate,
            event.paymentDate,
            eligibleSharesMicros,
            event.amountPerShareMicros,
            gross,
            tax,
          )
          .run();
        const credited = await db.batch([
          db
            .prepare(
              `UPDATE seats
               SET cash_cents = cash_cents + ?,
                   dividend_income_cents = dividend_income_cents + ?,
                   dividend_tax_cents = dividend_tax_cents + ?,
                   tax_reserve_cents = tax_reserve_cents + ?
               WHERE id = ?
                 AND EXISTS (
                   SELECT 1 FROM dividend_payments
                   WHERE id = ? AND credited_at IS NULL
                 )`,
            )
            .bind(gross, gross, tax, tax, seat.id, paymentId),
          db
            .prepare(
              `UPDATE dividend_payments
               SET credited_at = ?
               WHERE id = ? AND credited_at IS NULL`,
            )
            .bind(now, paymentId),
        ]);
        if (credited[1].meta.changes) settledKeys.add(paymentKey);
      }
    }
  }
}

async function resolveQuote(
  db: D1Database,
  symbol: string,
  snapshot?: MarketSnapshot,
) {
  const configured = snapshot ? snapshotQuote(snapshot, symbol) : null;
  if (configured) return configured;

  const memory = quoteMemoryCache.get(symbol);
  if (memory && memory.expiresAt > Date.now()) return memory.quote;
  const persistent = await cachedQuote(db, symbol);
  if (
    persistent &&
    persistent.updatedAt + QUOTE_MEMORY_TTL_MS > Date.now()
  ) {
    quoteMemoryCache.set(symbol, {
      expiresAt: persistent.updatedAt + QUOTE_MEMORY_TTL_MS,
      quote: persistent.quote,
    });
    return persistent.quote;
  }

  try {
    const quote = isCryptoPair(symbol)
      ? await fetchCoinbaseCryptoQuote(symbol)
      : (await fetchNasdaqInfo(symbol, "stocks")) ??
        (await fetchNasdaqInfo(symbol, "etf"));
    if (!quote) {
      throw new HttpError(
        404,
        `${symbol} was not found as a supported stock, ETF, or USD crypto pair.`,
      );
    }
    await db
      .prepare(
        `INSERT INTO quote_cache (
          symbol, name, price_cents, previous_close_cents,
          quoted_at, source, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol) DO UPDATE SET
          name = excluded.name,
          price_cents = excluded.price_cents,
          previous_close_cents = excluded.previous_close_cents,
          quoted_at = excluded.quoted_at,
          source = excluded.source,
          updated_at = excluded.updated_at`,
      )
      .bind(
        quote.symbol,
        quote.name,
        quote.priceCents,
        quote.previousCloseCents,
        new Date(quote.generatedAt).getTime(),
        quote.source,
        Date.now(),
      )
      .run();
    quoteMemoryCache.set(symbol, {
      expiresAt: Date.now() + QUOTE_MEMORY_TTL_MS,
      quote,
    });
    return quote;
  } catch (error) {
    const fallback = persistent ?? (await cachedQuote(db, symbol));
    if (
      fallback &&
      quoteTimestampIsExecutable(
        fallback.quote.generatedAt,
        Date.now(),
        MAX_EXECUTION_QUOTE_AGE_MS,
      )
    ) {
      return fallback.quote;
    }
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      503,
      `The latest price for ${symbol} is temporarily unavailable.`,
    );
  }
}

function refreshQuotesInBackground(
  db: D1Database,
  symbols: string[],
) {
  const context = getRequestExecutionContext();
  if (!context) return;
  const pendingSymbols = symbols.filter(
    (symbol) => !quoteRefreshesInFlight.has(symbol),
  );
  if (!pendingSymbols.length) return;
  pendingSymbols.forEach((symbol) => quoteRefreshesInFlight.add(symbol));
  const refresh = Promise.allSettled(
    pendingSymbols.map((symbol) => resolveQuote(db, symbol)),
  ).then(() => {
    pendingSymbols.forEach((symbol) => quoteRefreshesInFlight.delete(symbol));
  });
  context.waitUntil(refresh);
}

async function settlePeriodBonuses(
  db: D1Database,
  game: GameRow,
) {
  if (
    !game.period_bonuses_enabled ||
    !game.started_at ||
    game.status === "lobby"
  ) {
    return;
  }
  const competitionEnd = game.ended_at ?? game.ends_at;

  for (const periodType of ["day", "week", "month"] as const) {
    const period = completedCompetitionPeriod(periodType);
    if (
      !period ||
      game.started_at >= period.endAt ||
      (competitionEnd && competitionEnd < period.endAt)
    ) {
      continue;
    }
    const settled = await db
      .prepare(
        `SELECT id FROM period_awards
         WHERE game_id = ? AND period_type = ? AND period_key = ?`,
      )
      .bind(game.id, periodType, period.key)
      .first<{ id: string }>();
    if (settled) continue;

    const periodStart = Math.max(period.startAt, game.started_at);
    const values = await db
      .prepare(
        `SELECT
           seats.id AS seat_id,
           (
             SELECT snapshots.after_tax_cents
             FROM portfolio_snapshots AS snapshots
             WHERE snapshots.seat_id = seats.id
               AND snapshots.captured_at <= ?
             ORDER BY snapshots.captured_at DESC
             LIMIT 1
           ) AS anchor_value,
           (
             SELECT snapshots.captured_at
             FROM portfolio_snapshots AS snapshots
             WHERE snapshots.seat_id = seats.id
               AND snapshots.captured_at <= ?
             ORDER BY snapshots.captured_at DESC
             LIMIT 1
           ) AS anchor_at,
           (
             SELECT snapshots.after_tax_cents
             FROM portfolio_snapshots AS snapshots
             WHERE snapshots.seat_id = seats.id
               AND snapshots.captured_at > ?
               AND snapshots.captured_at < ?
             ORDER BY snapshots.captured_at ASC
             LIMIT 1
           ) AS first_value,
           (
             SELECT snapshots.captured_at
             FROM portfolio_snapshots AS snapshots
             WHERE snapshots.seat_id = seats.id
               AND snapshots.captured_at > ?
               AND snapshots.captured_at < ?
             ORDER BY snapshots.captured_at ASC
             LIMIT 1
           ) AS first_at,
           (
             SELECT snapshots.after_tax_cents
             FROM portfolio_snapshots AS snapshots
             WHERE snapshots.seat_id = seats.id
               AND snapshots.captured_at >= ?
               AND snapshots.captured_at < ?
             ORDER BY snapshots.captured_at DESC
             LIMIT 1
           ) AS end_value,
           (
             SELECT snapshots.captured_at
             FROM portfolio_snapshots AS snapshots
             WHERE snapshots.seat_id = seats.id
               AND snapshots.captured_at >= ?
               AND snapshots.captured_at < ?
             ORDER BY snapshots.captured_at DESC
             LIMIT 1
           ) AS end_at
         FROM seats
         WHERE seats.game_id = ? AND seats.player_name IS NOT NULL`,
      )
      .bind(
        periodStart,
        periodStart,
        periodStart,
        period.endAt,
        periodStart,
        period.endAt,
        periodStart,
        period.endAt,
        periodStart,
        period.endAt,
        game.id,
      )
      .all<PeriodValueRow>();

    const { winner, winningChangeBps } = selectPeriodBonusWinner(
      values.results.map((row) => ({
        seatId: row.seat_id,
        startValue: row.anchor_value ?? row.first_value,
        startAt: row.anchor_at ?? row.first_at,
        endValue: row.end_value,
        endAt: row.end_at,
      })),
    );
    const bonusCents = winner ? PERIOD_BONUSES_CENTS[periodType] : 0;
    const inserted = await db
      .prepare(
        `INSERT INTO period_awards (
          id, game_id, seat_id, period_type, period_key, bonus_cents,
          winning_change_bps, awarded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(game_id, period_type, period_key) DO NOTHING`,
      )
      .bind(
        crypto.randomUUID(),
        game.id,
        winner?.seatId ?? null,
        periodType,
        period.key,
        bonusCents,
        winningChangeBps,
        Date.now(),
      )
      .run();
    if (inserted.meta.changes && winner) {
      await db
        .prepare(
          `UPDATE seats
           SET cash_cents = cash_cents + ?,
               bonus_cents = bonus_cents + ?
           WHERE id = ?`,
        )
        .bind(bonusCents, bonusCents, winner.seatId)
        .run();
    }
  }
}

async function recordAndLoadPortfolioTrends(
  db: D1Database,
  game: GameRow,
  seats: SeatRow[],
  leaderboard: Array<{
    seatId: string;
    playerName: string | null;
    afterTaxCents: number;
  }>,
) {
  if (!game.started_at || !leaderboard.length) {
    return {
      playerTrends: [],
      periodLeaders: { day: null, week: null, month: null },
      periodRankings: { day: [], week: [], month: [], max: [] },
    };
  }
  const observedAt =
    game.status === "ended" && game.ended_at
      ? game.ended_at
      : Date.now();
  const currentBucket = Math.floor(
    observedAt / PORTFOLIO_SNAPSHOT_INTERVAL_MS,
  );
  const seatsById = new Map(seats.map((seat) => [seat.id, seat]));
  const statements: D1PreparedStatement[] = [];

  leaderboard.forEach((player) => {
    const seat = seatsById.get(player.seatId);
    if (!seat) return;
    const baselineAt = Math.max(
      game.started_at ?? game.created_at,
      seat.joined_at ?? 0,
    );
    const currentCapturedAt =
      game.status === "ended"
        ? observedAt
        : Math.max(
            currentBucket * PORTFOLIO_SNAPSHOT_INTERVAL_MS,
            baselineAt + 1,
          );
    statements.push(
      db
        .prepare(
          `INSERT INTO portfolio_snapshots (
            id, game_id, seat_id, bucket_start, after_tax_cents, captured_at
          ) VALUES (?, ?, ?, 0, ?, ?)
          ON CONFLICT(seat_id, bucket_start) DO NOTHING`,
        )
        .bind(
          crypto.randomUUID(),
          game.id,
          player.seatId,
          game.starting_cash_cents,
          baselineAt,
        ),
      db
        .prepare(
          `INSERT INTO portfolio_snapshots (
            id, game_id, seat_id, bucket_start, after_tax_cents, captured_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(seat_id, bucket_start) DO UPDATE SET
            after_tax_cents = excluded.after_tax_cents,
            captured_at = excluded.captured_at
          WHERE portfolio_snapshots.after_tax_cents
            <> excluded.after_tax_cents`,
        )
        .bind(
          crypto.randomUUID(),
          game.id,
          player.seatId,
          currentBucket,
          player.afterTaxCents,
          currentCapturedAt,
        ),
    );
  });
  if (statements.length) await db.batch(statements);

  const gameAge = Math.max(1, observedAt - game.started_at);
  const maxBucketMs =
    Math.max(
      1,
      Math.ceil(
        gameAge /
          (MAX_TREND_POINTS - 1) /
          PORTFOLIO_SNAPSHOT_INTERVAL_MS,
      ),
    ) * PORTFOLIO_SNAPSHOT_INTERVAL_MS;
  const rangeSettings = [
    {
      name: "day",
      sinceAt: Math.max(
        game.started_at,
        observedAt - 24 * 60 * 60 * 1_000,
      ),
      bucketMs: PORTFOLIO_SNAPSHOT_INTERVAL_MS,
    },
    {
      name: "week",
      sinceAt: Math.max(
        game.started_at,
        observedAt - 7 * 24 * 60 * 60 * 1_000,
      ),
      bucketMs: 2 * 60 * 60 * 1_000,
    },
    {
      name: "month",
      sinceAt: Math.max(
        game.started_at,
        observedAt - 30 * 24 * 60 * 60 * 1_000,
      ),
      bucketMs: 6 * 60 * 60 * 1_000,
    },
    {
      name: "max",
      sinceAt: game.started_at,
      bucketMs: maxBucketMs,
    },
  ];
  const snapshots = await db
    .prepare(
      `WITH range_settings(range_name, since_at, bucket_ms) AS (
         VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)
       ),
       bucketed AS (
         SELECT
           ranges.range_name,
           snapshots.seat_id,
           snapshots.after_tax_cents,
           snapshots.captured_at,
           ROW_NUMBER() OVER (
             PARTITION BY
               ranges.range_name,
               snapshots.seat_id,
               CAST(snapshots.captured_at / ranges.bucket_ms AS INTEGER)
             ORDER BY snapshots.captured_at DESC
           ) AS bucket_rank
         FROM portfolio_snapshots AS snapshots
         JOIN range_settings AS ranges
           ON snapshots.captured_at >= ranges.since_at
         WHERE snapshots.game_id = ?
           AND snapshots.bucket_start <> 0
       ),
       baselines AS (
         SELECT
           ranges.range_name,
           snapshots.seat_id,
           snapshots.after_tax_cents,
           snapshots.captured_at
         FROM portfolio_snapshots AS snapshots
         JOIN range_settings AS ranges
           ON snapshots.captured_at >= ranges.since_at
         WHERE snapshots.game_id = ?
           AND snapshots.bucket_start = 0
       ),
       anchors AS (
         SELECT
           ranges.range_name,
           snapshots.seat_id,
           snapshots.after_tax_cents,
           ranges.since_at AS captured_at,
           ROW_NUMBER() OVER (
             PARTITION BY ranges.range_name, snapshots.seat_id
             ORDER BY snapshots.captured_at DESC
           ) AS anchor_rank
         FROM portfolio_snapshots AS snapshots
         JOIN range_settings AS ranges
           ON snapshots.captured_at < ranges.since_at
         WHERE snapshots.game_id = ?
       )
       SELECT range_name, seat_id, after_tax_cents, captured_at
       FROM bucketed
       WHERE bucket_rank = 1
       UNION ALL
       SELECT range_name, seat_id, after_tax_cents, captured_at
       FROM baselines
       UNION ALL
       SELECT range_name, seat_id, after_tax_cents, captured_at
       FROM anchors
       WHERE anchor_rank = 1
       ORDER BY range_name, seat_id, captured_at`,
    )
    .bind(
      ...rangeSettings.flatMap((range) => [
        range.name,
        range.sinceAt,
        range.bucketMs,
      ]),
      game.id,
      game.id,
      game.id,
    )
    .all<PortfolioSnapshotRow>();
  const pointsBySeat = new Map<
    string,
    Array<{ at: number; valueCents: number }>
  >();
  snapshots.results.forEach((row) => {
    const key = `${row.range_name}:${row.seat_id}`;
    const points = pointsBySeat.get(key) ?? [];
    points.push({
      at: row.captured_at,
      valueCents: row.after_tax_cents,
    });
    pointsBySeat.set(key, points);
  });

  const playerTrends = leaderboard.map((player) => {
    const ranges = Object.fromEntries(
      rangeSettings.map((range) => {
        const points =
          pointsBySeat.get(`${range.name}:${player.seatId}`) ?? [];
        const firstValue =
          points[0]?.valueCents ?? game.starting_cash_cents;
        const lastValue =
          points.at(-1)?.valueCents ?? player.afterTaxCents;
        const changeCents = lastValue - firstValue;
        return [
          range.name,
          {
            points,
            changeCents,
            changePercent: firstValue
              ? (changeCents / firstValue) * 100
              : 0,
            direction: changeCents >= 0 ? "up" : "down",
          },
        ];
      }),
    );
    return {
      seatId: player.seatId,
      playerName: player.playerName,
      ranges,
    };
  });
  const rankingFor = (
    rangeName: "day" | "week" | "month" | "max",
  ) =>
    [...playerTrends]
      .sort(
        (left, right) =>
          Number(right.ranges[rangeName].changePercent) -
          Number(left.ranges[rangeName].changePercent),
      )
      .map((player, index) => ({
        rank: index + 1,
        seatId: player.seatId,
        playerName: player.playerName,
        changeCents: player.ranges[rangeName].changeCents,
        changePercent: player.ranges[rangeName].changePercent,
      }));
  const periodRankings = {
    day: rankingFor("day"),
    week: rankingFor("week"),
    month: rankingFor("month"),
    max: rankingFor("max"),
  };
  const leaderFor = (rangeName: "day" | "week" | "month") => {
    const leader = periodRankings[rangeName][0];
    return leader
      ? {
          seatId: leader.seatId,
          playerName: leader.playerName,
          changeCents: leader.changeCents,
          changePercent: leader.changePercent,
        }
      : null;
  };
  return {
    playerTrends,
    periodLeaders: {
      day: leaderFor("day"),
      week: leaderFor("week"),
      month: leaderFor("month"),
    },
    periodRankings,
  };
}

async function createGame(request: Request, payload: Record<string, unknown>) {
  const db = getD1();
  const gameId = crypto.randomUUID();
  const hostToken = randomToken();
  const requestedStartingCash =
    payload.startingCash === undefined
      ? STARTING_CASH_CENTS
      : moneyStringToCents(payload.startingCash);
  if (
    requestedStartingCash === null ||
    requestedStartingCash < MIN_STARTING_CASH_CENTS ||
    requestedStartingCash > MAX_STARTING_CASH_CENTS
  ) {
    throw new HttpError(
      400,
      "Starting cash must be between $100 and $100,000,000.",
    );
  }
  const startingCashCents = requestedStartingCash;
  const endCondition = String(payload.endCondition ?? "duration");
  const requestedDuration = Number(payload.durationDays);
  const durationDays =
    endCondition === "goal"
      ? 0
      : [0, 7, 30, 365].includes(requestedDuration)
        ? requestedDuration
        : 30;
  const requestedTargetValue =
    endCondition === "goal"
      ? moneyStringToCents(payload.targetValue)
      : null;
  if (
    endCondition === "goal" &&
    (requestedTargetValue === null ||
      requestedTargetValue <= startingCashCents ||
      requestedTargetValue > MAX_TARGET_VALUE_CENTS)
  ) {
    throw new HttpError(
      400,
      "The winning target must be above the starting cash and no more than $1,000,000,000.",
    );
  }
  const targetValueCents = requestedTargetValue;
  const name = cleanName(payload.name, "Family Portfolio League");
  const createdAt = Date.now();
  const invitations: Array<{ seatNumber: number; token: string }> = [];
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO games (
          id, name, host_token_hash, status, starting_cash_cents,
          tax_rate_bps, duration_days, target_value_cents,
          period_bonuses_enabled, dividends_enabled_at, created_at
        ) VALUES (?, ?, ?, 'lobby', ?, ?, ?, ?, 1, ?, ?)`,
      )
      .bind(
        gameId,
        name,
        await tokenHash(hostToken),
        startingCashCents,
        TAX_RATE_BPS,
        durationDays,
        targetValueCents,
        createdAt,
        createdAt,
      ),
  ];

  for (let seatNumber = 1; seatNumber <= MAX_SEATS; seatNumber += 1) {
    const token = randomToken();
    invitations.push({ seatNumber, token });
    statements.push(
      db
        .prepare(
          `INSERT INTO seats (
            id, game_id, seat_number, invite_token_hash, cash_cents,
            realized_net_cents, tax_reserve_cents
          ) VALUES (?, ?, ?, ?, ?, 0, 0)`,
        )
        .bind(
          crypto.randomUUID(),
          gameId,
          seatNumber,
          await tokenHash(token),
          startingCashCents,
        ),
    );
  }

  await db.batch(statements);
  return json(
    request,
    {
      gameId,
      hostToken,
      invitations,
      name,
      durationDays,
      startingCashCents,
      targetValueCents,
      taxRateBps: TAX_RATE_BPS,
    },
    201,
  );
}

async function health(request: Request) {
  const db = getD1();
  const result = await db
    .prepare("SELECT 1 AS ok")
    .first<{ ok: number }>();
  return json(request, {
    ok: result?.ok === 1,
    service: "tickerquest-family-game",
    capabilities: {
      durationDays: [7, 30, 365, 0],
      configurableStartingCash: true,
      targetValueEnd: true,
      trendRanges: ["day", "week", "month", "max"],
      periodLeaders: ["day", "week", "month"],
      periodRankings: ["day", "week", "month", "max"],
      periodBonuses: {
        dayCents: PERIOD_BONUSES_CENTS.day,
        weekCents: PERIOD_BONUSES_CENTS.week,
        monthCents: PERIOD_BONUSES_CENTS.month,
      },
      dividends: true,
      hostSeatLinks: true,
      maxSeats: MAX_SEATS,
      crypto: true,
      seatOneHostAccess: true,
      protectedEndGame: true,
    },
  });
}

async function joinGame(request: Request, payload: Record<string, unknown>) {
  const db = getD1();
  const gameId = String(payload.gameId ?? "");
  const inviteToken = String(payload.inviteToken ?? "");
  const playerName = cleanName(payload.playerName, "", 20);
  if (!playerName) throw new HttpError(400, "Enter your player name.");
  const game = await gameById(db, gameId);
  if (game.status === "ended") {
    throw new HttpError(409, "This game has already ended.");
  }
  const seat = await requirePlayer(db, gameId, inviteToken);
  if (seat.player_name) {
    throw new HttpError(409, `Seat ${seat.seat_number} is already claimed.`);
  }
  const result = await db
    .prepare(
      `UPDATE seats
       SET player_name = ?, joined_at = ?
       WHERE id = ? AND player_name IS NULL`,
    )
    .bind(playerName, Date.now(), seat.id)
    .run();
  if (!result.meta.changes) {
    throw new HttpError(409, "That seat was just claimed.");
  }
  return json(request, {
    gameId,
    seatNumber: seat.seat_number,
    playerName,
  });
}

async function startGame(request: Request, payload: Record<string, unknown>) {
  const db = getD1();
  const gameId = String(payload.gameId ?? "");
  const game = await requireCreatorHost(db, gameId, request);
  if (game.status !== "lobby") {
    throw new HttpError(409, "This game has already started.");
  }
  const joined = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM seats WHERE game_id = ? AND player_name IS NOT NULL",
    )
    .bind(gameId)
    .first<{ count: number }>();
  if (Number(joined?.count ?? 0) < 2) {
    throw new HttpError(409, "At least two family members must join first.");
  }
  const startedAt = Date.now();
  const endsAt = gameEndsAt(startedAt, game.duration_days);
  await db
    .prepare(
      "UPDATE games SET status = 'active', started_at = ?, ends_at = ? WHERE id = ?",
    )
    .bind(startedAt, endsAt, gameId)
    .run();
  return json(request, { gameId, status: "active", startedAt, endsAt });
}

async function endGame(request: Request, payload: Record<string, unknown>) {
  const db = getD1();
  const gameId = String(payload.gameId ?? "");
  await requireCreatorHost(db, gameId, request);
  if (!endGameConfirmationIsValid(payload.confirmation)) {
    throw new HttpError(
      400,
      "Type END GAME and complete the final confirmation before ending this game.",
    );
  }
  const endedAt = Date.now();
  await db
    .prepare(
      "UPDATE games SET status = 'ended', ended_at = ? WHERE id = ?",
    )
    .bind(endedAt, gameId)
    .run();
  return json(request, { gameId, status: "ended", endedAt });
}

async function expandSeats(request: Request, payload: Record<string, unknown>) {
  const db = getD1();
  const gameId = String(payload.gameId ?? "");
  const game = await requireCreatorHost(db, gameId, request);
  if (game.status === "ended") {
    throw new HttpError(409, "Players cannot be added after the game ends.");
  }
  const existingRows = await db
    .prepare("SELECT seat_number FROM seats WHERE game_id = ?")
    .bind(gameId)
    .all<{ seat_number: number }>();
  const existing = new Set(
    existingRows.results.map((row) => Number(row.seat_number)),
  );
  const invitations: Array<{ seatNumber: number; token: string }> = [];
  const statements: D1PreparedStatement[] = [];
  for (let seatNumber = 1; seatNumber <= MAX_SEATS; seatNumber += 1) {
    if (existing.has(seatNumber)) continue;
    const token = randomToken();
    invitations.push({ seatNumber, token });
    statements.push(
      db
        .prepare(
          `INSERT INTO seats (
            id, game_id, seat_number, invite_token_hash, cash_cents,
            realized_net_cents, tax_reserve_cents
          ) VALUES (?, ?, ?, ?, ?, 0, 0)`,
        )
        .bind(
          crypto.randomUUID(),
          gameId,
          seatNumber,
          await tokenHash(token),
          game.starting_cash_cents,
        ),
    );
  }
  if (statements.length) await db.batch(statements);
  return json(request, {
    gameId,
    invitations,
    maxSeats: MAX_SEATS,
  });
}

async function resetSeat(request: Request, payload: Record<string, unknown>) {
  const db = getD1();
  const gameId = String(payload.gameId ?? "");
  const game = await requireCreatorHost(db, gameId, request);
  if (game.status !== "lobby") {
    throw new HttpError(409, "Seats can only be reset before the game starts.");
  }
  const seatNumber = Number(payload.seatNumber);
  if (!Number.isInteger(seatNumber) || seatNumber < 1 || seatNumber > MAX_SEATS) {
    throw new HttpError(400, "Choose a valid seat.");
  }
  const token = randomToken();
  const result = await db
    .prepare(
      `UPDATE seats
       SET invite_token_hash = ?, player_name = NULL, joined_at = NULL,
           cash_cents = ?, bonus_cents = 0, realized_net_cents = 0,
           dividend_income_cents = 0, dividend_tax_cents = 0,
           tax_reserve_cents = 0
       WHERE game_id = ? AND seat_number = ?`,
    )
    .bind(
      await tokenHash(token),
      game.starting_cash_cents,
      gameId,
      seatNumber,
    )
    .run();
  if (!result.meta.changes) throw new HttpError(404, "Seat not found.");
  return json(request, { gameId, seatNumber, token });
}

async function replaceSeatLink(
  request: Request,
  payload: Record<string, unknown>,
) {
  const db = getD1();
  const gameId = String(payload.gameId ?? "");
  const game = await requireCreatorHost(db, gameId, request);
  if (game.status === "ended") {
    throw new HttpError(409, "Player links cannot be changed after the game ends.");
  }
  const seatNumber = Number(payload.seatNumber);
  if (!Number.isInteger(seatNumber) || seatNumber < 1 || seatNumber > MAX_SEATS) {
    throw new HttpError(400, "Choose a valid seat.");
  }
  const token = randomToken();
  const result = await db
    .prepare(
      `UPDATE seats
       SET invite_token_hash = ?
       WHERE game_id = ? AND seat_number = ?`,
    )
    .bind(await tokenHash(token), gameId, seatNumber)
    .run();
  if (!result.meta.changes) throw new HttpError(404, "Seat not found.");
  return json(request, { gameId, seatNumber, token });
}

async function buyStock(
  request: Request,
  game: GameRow,
  seat: SeatRow,
  symbol: string,
  sharesMicros: number,
  priceCents: number,
) {
  const db = getD1();
  const now = Date.now();
  const costCents = grossCents(sharesMicros, priceCents);
  const washRows = await db
    .prepare(
      `SELECT id, remaining_shares_micros, remaining_loss_cents
       FROM wash_losses
       WHERE seat_id = ? AND symbol = ? AND expires_at >= ?
         AND remaining_shares_micros > 0
       ORDER BY created_at ASC`,
    )
    .bind(seat.id, symbol, now)
    .all<WashLossRow>();
  const wash = applyPendingWashLosses(washRows.results, sharesMicros);
  const newRealizedNet = seat.realized_net_cents + wash.deferredLossCents;
  const newTaxReserve = totalTaxReserveCents(
    newRealizedNet,
    seat.dividend_tax_cents,
    game.tax_rate_bps,
  );
  const taxDeltaCents =
    newTaxReserve - seat.tax_reserve_cents;
  const newCash = seat.cash_cents - costCents;
  if (newCash < newTaxReserve) {
    throw new HttpError(
      409,
      "This purchase exceeds your spendable cash after the tax reserve.",
    );
  }

  const tradeId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE seats
         SET cash_cents = ?, realized_net_cents = ?, tax_reserve_cents = ?
         WHERE id = ?`,
      )
      .bind(newCash, newRealizedNet, newTaxReserve, seat.id),
    db
      .prepare(
        `INSERT INTO trades (
          id, game_id, seat_id, side, symbol, shares_micros, price_cents,
          gross_cents, basis_cents, realized_gain_cents,
          deferred_wash_loss_cents, tax_delta_cents, created_at
        ) VALUES (?, ?, ?, 'buy', ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .bind(
        tradeId,
        game.id,
        seat.id,
        symbol,
        sharesMicros,
        priceCents,
        costCents,
        costCents + wash.deferredLossCents,
        wash.deferredLossCents,
        taxDeltaCents,
        now,
      ),
    db
      .prepare(
        `INSERT INTO lots (
          id, game_id, seat_id, symbol, acquired_at, original_shares_micros,
          remaining_shares_micros, remaining_basis_cents, source_trade_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        game.id,
        seat.id,
        symbol,
        now,
        sharesMicros,
        sharesMicros,
        costCents + wash.deferredLossCents,
        tradeId,
      ),
  ];
  wash.updates.forEach((update) => {
    statements.push(
      db
        .prepare(
          `UPDATE wash_losses
           SET remaining_shares_micros = ?, remaining_loss_cents = ?
           WHERE id = ?`,
        )
        .bind(
          update.remainingSharesMicros,
          update.remainingLossCents,
          update.id,
        ),
    );
  });
  await db.batch(statements);
  return json(request, {
    trade: {
      id: tradeId,
      side: "buy",
      symbol,
      shares: microsToShares(sharesMicros),
      priceCents,
      grossCents: costCents,
      deferredWashLossCents: wash.deferredLossCents,
      taxReserveCents: newTaxReserve,
    },
  });
}

async function sellStock(
  request: Request,
  game: GameRow,
  seat: SeatRow,
  symbol: string,
  sharesMicros: number,
  priceCents: number,
) {
  const db = getD1();
  const lotRows = await db
    .prepare(
      `SELECT * FROM lots
       WHERE seat_id = ? AND symbol = ? AND remaining_shares_micros > 0
       ORDER BY acquired_at ASC, id ASC`,
    )
    .bind(seat.id, symbol)
    .all<LotRow>();
  let sale;
  try {
    sale = allocateFifoSale(lotRows.results, sharesMicros, priceCents);
  } catch (error) {
    throw new HttpError(
      409,
      error instanceof Error ? error.message : "Not enough shares.",
    );
  }

  const now = Date.now();
  const newRealizedNet =
    seat.realized_net_cents + sale.realizedGainCents;
  const newTaxReserve = totalTaxReserveCents(
    newRealizedNet,
    seat.dividend_tax_cents,
    game.tax_rate_bps,
  );
  const taxDeltaCents =
    newTaxReserve - seat.tax_reserve_cents;
  const newCash = seat.cash_cents + sale.proceedsCents;
  const tradeId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE seats
         SET cash_cents = ?, realized_net_cents = ?, tax_reserve_cents = ?
         WHERE id = ?`,
      )
      .bind(newCash, newRealizedNet, newTaxReserve, seat.id),
    db
      .prepare(
        `INSERT INTO trades (
          id, game_id, seat_id, side, symbol, shares_micros, price_cents,
          gross_cents, basis_cents, realized_gain_cents,
          deferred_wash_loss_cents, tax_delta_cents, created_at
        ) VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .bind(
        tradeId,
        game.id,
        seat.id,
        symbol,
        sharesMicros,
        priceCents,
        sale.proceedsCents,
        sale.basisCents,
        sale.realizedGainCents,
        taxDeltaCents,
        now,
      ),
  ];

  sale.allocations.forEach((allocation) => {
    if (allocation.remainingSharesMicros <= 0) {
      statements.push(
        db.prepare("DELETE FROM lots WHERE id = ?").bind(allocation.id),
      );
    } else {
      statements.push(
        db
          .prepare(
            `UPDATE lots
             SET remaining_shares_micros = ?, remaining_basis_cents = ?
             WHERE id = ?`,
          )
          .bind(
            allocation.remainingSharesMicros,
            allocation.remainingBasisCents,
            allocation.id,
          ),
      );
    }
  });

  if (sale.realizedGainCents < 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO wash_losses (
            id, game_id, seat_id, symbol, remaining_shares_micros,
            remaining_loss_cents, created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          game.id,
          seat.id,
          symbol,
          sharesMicros,
          Math.abs(sale.realizedGainCents),
          now,
          now + WASH_WINDOW_MS,
        ),
    );
  }

  await db.batch(statements);
  return json(request, {
    trade: {
      id: tradeId,
      side: "sell",
      symbol,
      shares: microsToShares(sharesMicros),
      priceCents,
      grossCents: sale.proceedsCents,
      basisCents: sale.basisCents,
      realizedGainCents: sale.realizedGainCents,
      taxDeltaCents,
      taxReserveCents: newTaxReserve,
    },
  });
}

async function quoteStock(
  request: Request,
  payload: Record<string, unknown>,
) {
  const db = getD1();
  const gameId = String(payload.gameId ?? "");
  const seat = await requirePlayer(db, gameId, bearerToken(request));
  if (!seat.player_name) {
    throw new HttpError(409, "Claim your player seat before checking prices.");
  }
  const symbol = normalizeTradableSymbol(cleanSymbol(payload.symbol));
  const snapshot = isCryptoPair(symbol) ? undefined : await fetchMarket();
  const quote = await resolveQuote(db, symbol, snapshot);
  return json(request, {
    quote: {
      ...quote,
      sessionLabel: isCryptoPair(quote.symbol)
        ? "Crypto market · 24/7"
        : snapshot?.session?.label ?? "Latest available",
    },
  });
}

async function trade(request: Request, payload: Record<string, unknown>) {
  const db = getD1();
  const gameId = String(payload.gameId ?? "");
  const game = await gameById(db, gameId);
  const seat = await requirePlayer(db, gameId, bearerToken(request));
  if (!seat.player_name) {
    throw new HttpError(409, "Claim your player seat before trading.");
  }
  if (!tradingIsActive(game.status, game.ends_at)) {
    throw new HttpError(409, "Trading is not active for this game.");
  }
  const requestedSymbol = normalizeTradableSymbol(cleanSymbol(payload.symbol));
  const sharesMicros = sharesToMicros(payload.shares);
  if (!sharesMicros) {
    throw new HttpError(400, "Enter a share amount greater than zero.");
  }
  const side = payload.side === "sell" ? "sell" : "buy";
  const snapshot = isCryptoPair(requestedSymbol)
    ? undefined
    : await fetchMarket();
  const quote = await resolveQuote(db, requestedSymbol, snapshot);
  const symbol = quote.symbol;
  if (
    !quoteTimestampIsExecutable(
      quote.generatedAt,
      Date.now(),
      MAX_EXECUTION_QUOTE_AGE_MS,
    )
  ) {
    throw new HttpError(
      503,
      `The latest price for ${symbol} is more than seven days old.`,
    );
  }
  const { priceCents } = quote;
  return side === "buy"
    ? buyStock(request, game, seat, symbol, sharesMicros, priceCents)
    : sellStock(request, game, seat, symbol, sharesMicros, priceCents);
}

async function gameState(request: Request) {
  const db = getD1();
  const url = new URL(request.url);
  const gameId = url.searchParams.get("gameId") ?? "";
  const role = request.headers.get("x-game-role") === "host" ? "host" : "player";
  const token = bearerToken(request);
  let game =
    role === "host"
      ? await requireCreatorHost(db, gameId, request)
      : await gameById(db, gameId);
  const currentSeat =
    role === "player" ? await requirePlayer(db, gameId, token) : null;

  if (
    game.status === "active" &&
    game.ends_at &&
    Date.now() >= game.ends_at
  ) {
    await db
      .prepare(
        "UPDATE games SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'active'",
      )
      .bind(game.ends_at, game.id)
      .run();
    game = { ...game, status: "ended", ended_at: game.ends_at };
  }

  await settleDividends(db, game);
  await settlePeriodBonuses(db, game);

  const [
    seatResult,
    lotResult,
    tradeResult,
    awardResult,
    dividendResult,
    market,
  ] =
    await Promise.all([
    db
      .prepare("SELECT * FROM seats WHERE game_id = ? ORDER BY seat_number")
      .bind(gameId)
      .all<SeatRow>(),
    db
      .prepare(
        `SELECT * FROM lots
         WHERE game_id = ? AND remaining_shares_micros > 0
         ORDER BY acquired_at`,
      )
      .bind(gameId)
      .all<LotRow>(),
    db
      .prepare(
        `SELECT t.*, s.player_name
         FROM trades t
         JOIN seats s ON s.id = t.seat_id
         WHERE t.game_id = ?
         ORDER BY t.created_at DESC
         LIMIT 24`,
      )
      .bind(gameId)
      .all<Record<string, string | number | null>>(),
    db
      .prepare(
        `SELECT
           awards.id,
           awards.seat_id,
           seats.player_name,
           awards.period_type,
           awards.period_key,
           awards.bonus_cents,
           awards.winning_change_bps,
           awards.awarded_at
         FROM period_awards AS awards
         JOIN seats ON seats.id = awards.seat_id
         WHERE awards.game_id = ? AND awards.bonus_cents > 0
         ORDER BY awards.awarded_at DESC`,
      )
      .bind(gameId)
      .all<Record<string, string | number | null>>(),
    db
      .prepare(
        `SELECT
           payments.id,
           payments.seat_id,
           seats.player_name,
           payments.symbol,
           payments.ex_date,
           payments.payment_date,
           payments.shares_micros,
           payments.amount_per_share_micros,
           payments.gross_cents,
           payments.tax_cents,
           payments.credited_at
         FROM dividend_payments AS payments
         JOIN seats ON seats.id = payments.seat_id
         WHERE payments.game_id = ?
           AND payments.gross_cents > 0
           AND payments.credited_at IS NOT NULL
         ORDER BY payments.credited_at DESC
         LIMIT 100`,
      )
      .bind(gameId)
      .all<Record<string, string | number | null>>(),
    fetchMarket(),
  ]);

  const configuredQuotes = market.symbols
    .map((item) => snapshotQuote(market, item.symbol))
    .filter((item): item is ResolvedQuote => Boolean(item));
  const configuredSymbols = new Set(
    configuredQuotes.map((item) => item.symbol),
  );
  const additionalSymbols = [
    ...new Set(
      lotResult.results
        .map((lot) => lot.symbol)
        .filter((symbol) => !configuredSymbols.has(symbol)),
    ),
  ];
  const additionalQuotes = await cachedQuotes(db, additionalSymbols);
  refreshQuotesInBackground(db, additionalSymbols);
  const allQuotes = [...configuredQuotes, ...additionalQuotes];
  const quotes = new Map(allQuotes.map((item) => [item.symbol, item]));
  const joinedSeats = seatResult.results.filter((seat) => seat.player_name);
  const leaderboard = joinedSeats
    .map((seat) => {
      const seatLots = lotResult.results.filter(
        (lot) => lot.seat_id === seat.id,
      );
      const bySymbol = new Map<
        string,
        { sharesMicros: number; basisCents: number }
      >();
      seatLots.forEach((lot) => {
        const current = bySymbol.get(lot.symbol) ?? {
          sharesMicros: 0,
          basisCents: 0,
        };
        current.sharesMicros += lot.remaining_shares_micros;
        current.basisCents += lot.remaining_basis_cents;
        bySymbol.set(lot.symbol, current);
      });
      const holdings = [...bySymbol.entries()].map(([symbol, value]) => {
        const quote = quotes.get(symbol);
        const priceCents = quote?.priceCents ?? 0;
        const marketValueCents = grossCents(
          value.sharesMicros,
          priceCents,
        );
        return {
          symbol,
          name: quote?.name ?? symbol,
          shares: microsToShares(value.sharesMicros),
          basisCents: value.basisCents,
          averageCostCents: value.sharesMicros
            ? Math.round(
                (value.basisCents * 1_000_000) / value.sharesMicros,
              )
            : 0,
          priceCents,
          marketValueCents,
          unrealizedCents: marketValueCents - value.basisCents,
        };
      });
      const marketValueCents = holdings.reduce(
        (sum, holding) => sum + holding.marketValueCents,
        0,
      );
      const afterTaxCents = afterTaxValueCents({
        cashCents: seat.cash_cents,
        marketValueCents,
        taxReserveCents: seat.tax_reserve_cents,
      });
      return {
        seatId: seat.id,
        seatNumber: seat.seat_number,
        playerName: seat.player_name,
        cashCents: seat.cash_cents,
        bonusCents: seat.bonus_cents,
        dividendIncomeCents: seat.dividend_income_cents,
        dividendTaxCents: seat.dividend_tax_cents,
        spendableCashCents: Math.max(
          0,
          seat.cash_cents - seat.tax_reserve_cents,
        ),
        realizedNetCents: seat.realized_net_cents,
        taxReserveCents: seat.tax_reserve_cents,
        marketValueCents,
        afterTaxCents,
        returnPercent:
          ((afterTaxCents - game.starting_cash_cents) /
            game.starting_cash_cents) *
          100,
        holdings,
      };
    })
    .sort((a, b) => b.afterTaxCents - a.afterTaxCents)
    .map((player, index) => ({ ...player, rank: index + 1 }));

  const overallLeader = leaderboard[0];
  if (
    overallLeader &&
    game.status === "active" &&
    targetValueReached(
      overallLeader.afterTaxCents,
      game.target_value_cents,
    )
  ) {
    const endedAt = Date.now();
    const result = await db
      .prepare(
        `UPDATE games
         SET status = 'ended', ended_at = ?, winner_seat_id = ?
         WHERE id = ? AND status = 'active' AND winner_seat_id IS NULL`,
      )
      .bind(endedAt, overallLeader.seatId, game.id)
      .run();
    game = result.meta.changes
      ? {
          ...game,
          status: "ended",
          ended_at: endedAt,
          winner_seat_id: overallLeader.seatId,
        }
      : await gameById(db, game.id);
  }
  if (
    overallLeader &&
    game.status === "ended" &&
    !game.winner_seat_id
  ) {
    const result = await db
      .prepare(
        `UPDATE games
         SET winner_seat_id = ?
         WHERE id = ? AND status = 'ended' AND winner_seat_id IS NULL`,
      )
      .bind(overallLeader.seatId, game.id)
      .run();
    if (result.meta.changes) {
      game = { ...game, winner_seat_id: overallLeader.seatId };
    } else {
      game = await gameById(db, game.id);
    }
  }

  const { playerTrends, periodLeaders, periodRankings } =
    await recordAndLoadPortfolioTrends(
      db,
      game,
      seatResult.results,
      leaderboard,
    );

  const sessionLabel = market.session?.label ?? "Market unavailable";
  return json(request, {
    game: {
      id: game.id,
      name: game.name,
      status: game.status,
      durationDays: game.duration_days,
      startingCashCents: game.starting_cash_cents,
      targetValueCents: game.target_value_cents,
      winnerSeatId: game.winner_seat_id,
      periodBonusesEnabled: Boolean(game.period_bonuses_enabled),
      dividendsEnabled: Boolean(game.dividends_enabled_at),
      dividendsEnabledAt: game.dividends_enabled_at,
      taxRateBps: game.tax_rate_bps,
      createdAt: game.created_at,
      startedAt: game.started_at,
      endsAt: game.ends_at,
      endedAt: game.ended_at,
    },
    role,
    you: currentSeat
      ? leaderboard.find((player) => player.seatId === currentSeat.id) ?? {
          seatId: currentSeat.id,
          seatNumber: currentSeat.seat_number,
          playerName: currentSeat.player_name,
        }
      : null,
    seats: seatResult.results.map((seat) => ({
      seatNumber: seat.seat_number,
      playerName: seat.player_name,
      joined: Boolean(seat.player_name),
    })),
    leaderboard,
    playerTrends,
    periodLeaders,
    periodRankings,
    bonusAwards: awardResult.results.map((row) => ({
      id: row.id,
      seatId: row.seat_id,
      playerName: row.player_name,
      periodType: row.period_type,
      periodKey: row.period_key,
      bonusCents: Number(row.bonus_cents),
      winningChangePercent:
        Number(row.winning_change_bps) / 100,
      awardedAt: Number(row.awarded_at),
    })),
    dividendPayments: dividendResult.results.map((row) => ({
      id: row.id,
      seatId: row.seat_id,
      playerName: row.player_name,
      symbol: row.symbol,
      exDate: row.ex_date,
      paymentDate: row.payment_date,
      shares: microsToShares(Number(row.shares_micros)),
      amountPerShare:
        Number(row.amount_per_share_micros) / 1_000_000,
      grossCents: Number(row.gross_cents),
      taxCents: Number(row.tax_cents),
      creditedAt: Number(row.credited_at),
    })),
    recentTrades: tradeResult.results.map((row) => ({
      id: row.id,
      playerName: row.player_name,
      side: row.side,
      symbol: row.symbol,
      shares: microsToShares(Number(row.shares_micros)),
      priceCents: Number(row.price_cents),
      realizedGainCents: Number(row.realized_gain_cents),
      taxDeltaCents: Number(row.tax_delta_cents),
      createdAt: Number(row.created_at),
    })),
    market: {
      generatedAt: market.generatedAt,
      mode: market.mode,
      sessionLabel,
      executionPolicy: "latest-available",
      canTrade: tradingIsActive(
        game.status,
        game.ends_at,
        Date.now(),
      ),
      symbols: allQuotes.map((quote) => ({
        symbol: quote.symbol,
        name: quote.name,
        priceCents: quote.priceCents,
        previousCloseCents: quote.previousCloseCents,
        generatedAt: quote.generatedAt,
        source: quote.source,
      })),
    },
  });
}

export async function OPTIONS(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request: Request) {
  try {
    return await gameState(request);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message =
      error instanceof Error ? error.message : "Unexpected game-service error.";
    return json(request, { error: message }, status);
  }
}

export async function POST(request: Request) {
  try {
    const payload = await requestBody(request);
    switch (payload.action) {
      case "health":
        return await health(request);
      case "create":
        return await createGame(request, payload);
      case "join":
        return await joinGame(request, payload);
      case "start":
        return await startGame(request, payload);
      case "end":
        return await endGame(request, payload);
      case "resetSeat":
        return await resetSeat(request, payload);
      case "replaceSeatLink":
        return await replaceSeatLink(request, payload);
      case "expandSeats":
        return await expandSeats(request, payload);
      case "quote":
        return await quoteStock(request, payload);
      case "trade":
        return await trade(request, payload);
      default:
        throw new HttpError(400, "Choose a valid game action.");
    }
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message =
      error instanceof Error ? error.message : "Unexpected game-service error.";
    return json(request, { error: message }, status);
  }
}
