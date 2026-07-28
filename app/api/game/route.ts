import { getD1 } from "@/db";
import { getRequestExecutionContext } from "vinext/shims/request-context";
import {
  afterTaxValueCents,
  allocateFifoSale,
  applyPendingWashLosses,
  grossCents,
  microsToShares,
  quoteTimestampIsExecutable,
  sharesToMicros,
  taxReserveCents,
} from "@/lib/game-rules.js";

export const dynamic = "force-dynamic";

const MARKET_URL =
  "https://kleinlab-yale.github.io/stocks/data/market.json";
const NASDAQ_QUOTE_URL = "https://api.nasdaq.com/api/quote";
const STATIC_ORIGIN = "https://kleinlab-yale.github.io";
const ALLOWED_ORIGINS = new Set([
  STATIC_ORIGIN,
  "http://localhost:8000",
  "http://127.0.0.1:8000",
]);
const STARTING_CASH_CENTS = 1_000_000;
const TAX_RATE_BPS = 2_400;
const MAX_SEATS = 8;
const WASH_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_EXECUTION_QUOTE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const QUOTE_MEMORY_TTL_MS = 60 * 1_000;
const MARKET_MEMORY_TTL_MS = 30 * 1_000;
const MARKET_FETCH_TIMEOUT_MS = 6 * 1_000;
const QUOTE_FETCH_TIMEOUT_MS = 6 * 1_000;
const PORTFOLIO_SNAPSHOT_INTERVAL_MS = 30 * 60 * 1_000;
const MAX_TREND_POINTS = 120;

type GameRow = {
  id: string;
  name: string;
  host_token_hash: string;
  status: string;
  starting_cash_cents: number;
  tax_rate_bps: number;
  duration_days: number;
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
  seat_id: string;
  after_tax_cents: number;
  captured_at: number;
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

const quoteMemoryCache = new Map<
  string,
  { expiresAt: number; quote: ResolvedQuote }
>();
const quoteRefreshesInFlight = new Set<string>();
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
      "Authorization, Content-Type, X-Game-Role",
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
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    throw new HttpError(400, "Enter a valid ticker.");
  }
  return symbol;
}

function bearerToken(request: Request) {
  const value = request.headers.get("authorization") ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
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
    const quote =
      (await fetchNasdaqInfo(symbol, "stocks")) ??
      (await fetchNasdaqInfo(symbol, "etf"));
    if (!quote) {
      throw new HttpError(
        404,
        `${symbol} was not found as a U.S.-listed stock or ETF.`,
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
  if (!game.started_at || !leaderboard.length) return [];
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

  const snapshots = await db
    .prepare(
      `SELECT seat_id, after_tax_cents, captured_at
       FROM (
         SELECT
           seat_id,
           bucket_start,
           after_tax_cents,
           captured_at,
           ROW_NUMBER() OVER (
             PARTITION BY seat_id
             ORDER BY captured_at DESC
           ) AS point_rank
         FROM portfolio_snapshots
         WHERE game_id = ?
       )
       WHERE bucket_start = 0 OR point_rank <= ?
       ORDER BY seat_id, captured_at`,
    )
    .bind(game.id, MAX_TREND_POINTS - 1)
    .all<PortfolioSnapshotRow>();
  const pointsBySeat = new Map<
    string,
    Array<{ at: number; valueCents: number }>
  >();
  snapshots.results.forEach((row) => {
    const points = pointsBySeat.get(row.seat_id) ?? [];
    points.push({
      at: row.captured_at,
      valueCents: row.after_tax_cents,
    });
    pointsBySeat.set(row.seat_id, points);
  });

  return leaderboard.map((player) => {
    const points = pointsBySeat.get(player.seatId) ?? [];
    const firstValue = points[0]?.valueCents ?? game.starting_cash_cents;
    const lastValue =
      points.at(-1)?.valueCents ?? player.afterTaxCents;
    const changeCents = lastValue - firstValue;
    return {
      seatId: player.seatId,
      playerName: player.playerName,
      points,
      changeCents,
      changePercent: firstValue
        ? (changeCents / firstValue) * 100
        : 0,
      direction: changeCents >= 0 ? "up" : "down",
    };
  });
}

async function createGame(request: Request, payload: Record<string, unknown>) {
  const db = getD1();
  const gameId = crypto.randomUUID();
  const hostToken = randomToken();
  const durationDays = Number(payload.durationDays) === 7 ? 7 : 30;
  const name = cleanName(payload.name, "Family Portfolio League");
  const createdAt = Date.now();
  const invitations: Array<{ seatNumber: number; token: string }> = [];
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO games (
          id, name, host_token_hash, status, starting_cash_cents,
          tax_rate_bps, duration_days, created_at
        ) VALUES (?, ?, ?, 'lobby', ?, ?, ?, ?)`,
      )
      .bind(
        gameId,
        name,
        await tokenHash(hostToken),
        STARTING_CASH_CENTS,
        TAX_RATE_BPS,
        durationDays,
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
          STARTING_CASH_CENTS,
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
      startingCashCents: STARTING_CASH_CENTS,
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
  const game = await requireHost(db, gameId, bearerToken(request));
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
  const endsAt = startedAt + game.duration_days * 24 * 60 * 60 * 1_000;
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
  await requireHost(db, gameId, bearerToken(request));
  const endedAt = Date.now();
  await db
    .prepare(
      "UPDATE games SET status = 'ended', ended_at = ? WHERE id = ?",
    )
    .bind(endedAt, gameId)
    .run();
  return json(request, { gameId, status: "ended", endedAt });
}

async function resetSeat(request: Request, payload: Record<string, unknown>) {
  const db = getD1();
  const gameId = String(payload.gameId ?? "");
  const game = await requireHost(db, gameId, bearerToken(request));
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
           cash_cents = ?, realized_net_cents = 0, tax_reserve_cents = 0
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
  const newTaxReserve = taxReserveCents(
    newRealizedNet,
    game.tax_rate_bps,
  );
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
        newTaxReserve - seat.tax_reserve_cents,
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
  const newTaxReserve = taxReserveCents(
    newRealizedNet,
    game.tax_rate_bps,
  );
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
        newTaxReserve - seat.tax_reserve_cents,
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
  const symbol = cleanSymbol(payload.symbol);
  const snapshot = await fetchMarket();
  const quote = await resolveQuote(db, symbol, snapshot);
  return json(request, {
    quote: {
      ...quote,
      sessionLabel: snapshot.session?.label ?? "Latest available",
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
  if (
    game.status !== "active" ||
    !game.ends_at ||
    Date.now() >= game.ends_at
  ) {
    throw new HttpError(409, "Trading is not active for this game.");
  }
  const symbol = cleanSymbol(payload.symbol);
  const sharesMicros = sharesToMicros(payload.shares);
  if (!sharesMicros) {
    throw new HttpError(400, "Enter a share amount greater than zero.");
  }
  const side = payload.side === "sell" ? "sell" : "buy";
  const snapshot = await fetchMarket();
  const quote = await resolveQuote(db, symbol, snapshot);
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
      ? await requireHost(db, gameId, token)
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

  const [seatResult, lotResult, tradeResult, market] = await Promise.all([
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
  const playerTrends = await recordAndLoadPortfolioTrends(
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
    recentTrades: tradeResult.results.map((row) => ({
      id: row.id,
      playerName: row.player_name,
      side: row.side,
      symbol: row.symbol,
      shares: microsToShares(Number(row.shares_micros)),
      priceCents: Number(row.price_cents),
      realizedGainCents: Number(row.realized_gain_cents),
      createdAt: Number(row.created_at),
    })),
    market: {
      generatedAt: market.generatedAt,
      mode: market.mode,
      sessionLabel,
      executionPolicy: "latest-available",
      canTrade: game.status === "active",
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
