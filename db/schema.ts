import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const games = sqliteTable("games", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  hostTokenHash: text("host_token_hash").notNull(),
  status: text("status").notNull().default("lobby"),
  startingCashCents: integer("starting_cash_cents").notNull(),
  taxRateBps: integer("tax_rate_bps").notNull(),
  durationDays: integer("duration_days").notNull(),
  createdAt: integer("created_at").notNull(),
  startedAt: integer("started_at"),
  endsAt: integer("ends_at"),
  endedAt: integer("ended_at"),
});

export const seats = sqliteTable(
  "seats",
  {
    id: text("id").primaryKey(),
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    seatNumber: integer("seat_number").notNull(),
    inviteTokenHash: text("invite_token_hash").notNull(),
    playerName: text("player_name"),
    joinedAt: integer("joined_at"),
    cashCents: integer("cash_cents").notNull(),
    realizedNetCents: integer("realized_net_cents").notNull().default(0),
    taxReserveCents: integer("tax_reserve_cents").notNull().default(0),
  },
  (table) => [
    uniqueIndex("seats_game_number_unique").on(
      table.gameId,
      table.seatNumber,
    ),
    index("seats_game_idx").on(table.gameId),
    index("seats_invite_hash_idx").on(table.inviteTokenHash),
  ],
);

export const trades = sqliteTable(
  "trades",
  {
    id: text("id").primaryKey(),
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    seatId: text("seat_id")
      .notNull()
      .references(() => seats.id, { onDelete: "cascade" }),
    side: text("side").notNull(),
    symbol: text("symbol").notNull(),
    sharesMicros: integer("shares_micros").notNull(),
    priceCents: integer("price_cents").notNull(),
    grossCents: integer("gross_cents").notNull(),
    basisCents: integer("basis_cents").notNull(),
    realizedGainCents: integer("realized_gain_cents").notNull(),
    deferredWashLossCents: integer("deferred_wash_loss_cents")
      .notNull()
      .default(0),
    taxDeltaCents: integer("tax_delta_cents").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("trades_game_idx").on(table.gameId),
    index("trades_seat_idx").on(table.seatId),
  ],
);

export const lots = sqliteTable(
  "lots",
  {
    id: text("id").primaryKey(),
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    seatId: text("seat_id")
      .notNull()
      .references(() => seats.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    acquiredAt: integer("acquired_at").notNull(),
    originalSharesMicros: integer("original_shares_micros").notNull(),
    remainingSharesMicros: integer("remaining_shares_micros").notNull(),
    remainingBasisCents: integer("remaining_basis_cents").notNull(),
    sourceTradeId: text("source_trade_id")
      .notNull()
      .references(() => trades.id, { onDelete: "cascade" }),
  },
  (table) => [
    index("lots_seat_symbol_idx").on(
      table.seatId,
      table.symbol,
      table.acquiredAt,
    ),
  ],
);

export const washLosses = sqliteTable(
  "wash_losses",
  {
    id: text("id").primaryKey(),
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    seatId: text("seat_id")
      .notNull()
      .references(() => seats.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    remainingSharesMicros: integer("remaining_shares_micros").notNull(),
    remainingLossCents: integer("remaining_loss_cents").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("wash_losses_lookup_idx").on(
      table.seatId,
      table.symbol,
      table.expiresAt,
    ),
  ],
);

export const quoteCache = sqliteTable("quote_cache", {
  symbol: text("symbol").primaryKey(),
  name: text("name").notNull(),
  priceCents: integer("price_cents").notNull(),
  previousCloseCents: integer("previous_close_cents"),
  quotedAt: integer("quoted_at").notNull(),
  source: text("source").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const portfolioSnapshots = sqliteTable(
  "portfolio_snapshots",
  {
    id: text("id").primaryKey(),
    gameId: text("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    seatId: text("seat_id")
      .notNull()
      .references(() => seats.id, { onDelete: "cascade" }),
    bucketStart: integer("bucket_start").notNull(),
    afterTaxCents: integer("after_tax_cents").notNull(),
    capturedAt: integer("captured_at").notNull(),
  },
  (table) => [
    uniqueIndex("portfolio_snapshots_seat_bucket_unique").on(
      table.seatId,
      table.bucketStart,
    ),
    index("portfolio_snapshots_game_time_idx").on(
      table.gameId,
      table.capturedAt,
    ),
  ],
);
