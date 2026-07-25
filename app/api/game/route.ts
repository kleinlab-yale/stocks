import { getD1 } from "@/db";
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

function quoteSnapshotIsExecutable(snapshot: MarketSnapshot) {
  return quoteTimestampIsExecutable(
    snapshot.generatedAt,
    Date.now(),
    MAX_EXECUTION_QUOTE_AGE_MS,
  );
}

async function fetchMarket(requireExecutable = false) {
  const response = await fetch(`${MARKET_URL}?game=${Date.now()}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new HttpError(503, "The shared market snapshot is unavailable.");
  }
  const snapshot = (await response.json()) as MarketSnapshot;
  if (requireExecutable && !quoteSnapshotIsExecutable(snapshot)) {
    throw new HttpError(
      503,
      "The latest shared quote is more than seven days old. Try again after the price feed refreshes.",
    );
  }
  return snapshot;
}

function priceFor(snapshot: MarketSnapshot, symbol: string) {
  const quote = snapshot.symbols.find((item) => item.symbol === symbol);
  const price = Number(quote?.price);
  if (!quote || !Number.isFinite(price) || price <= 0) {
    throw new HttpError(
      409,
      `${symbol} is not available in the shared market feed.`,
    );
  }
  return { quote, priceCents: Math.round(price * 100) };
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
  const snapshot = await fetchMarket(true);
  const { priceCents } = priceFor(snapshot, symbol);
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
    fetchMarket(false),
  ]);

  const quotes = new Map(
    market.symbols.map((item) => [item.symbol, item]),
  );
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
        const price = Number(quote?.price);
        const priceCents =
          Number.isFinite(price) && price > 0 ? Math.round(price * 100) : 0;
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

  const sessionLabel = market.session?.label ?? "Market unavailable";
  const hasExecutablePrice = market.symbols.some((item) => {
    const price = Number(item.price);
    return Number.isFinite(price) && price > 0;
  });
  const quoteIsExecutable =
    quoteSnapshotIsExecutable(market) && hasExecutablePrice;
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
      canTrade: game.status === "active" && quoteIsExecutable,
      symbols: market.symbols.map((item) => ({
        symbol: item.symbol,
        name: item.name ?? item.symbol,
        priceCents:
          Number.isFinite(Number(item.price)) && Number(item.price) > 0
            ? Math.round(Number(item.price) * 100)
            : null,
        previousCloseCents:
          Number.isFinite(Number(item.previousClose)) &&
          Number(item.previousClose) > 0
            ? Math.round(Number(item.previousClose) * 100)
            : null,
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
