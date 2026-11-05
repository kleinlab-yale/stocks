import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";
import test from "node:test";
import vm from "node:vm";
import * as rules from "../lib/game-rules.js";
import * as freshness from "../lib/market-freshness.js";
import * as stockQuotes from "../lib/stock-quotes.js";
import * as symbols from "../lib/tradable-symbols.js";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const compiled = ts.transpileModule(readFileSync(new URL("../app/api/game/route.ts", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const now = Date.parse("2026-11-05T18:00:00Z");
const currentQuote = {
  symbol: "SPCX", name: "Space Exploration Technologies Corp.", priceCents: 12329,
  previousCloseCents: 13592, generatedAt: "2026-11-05T17:59:00.000Z", source: "Yahoo Finance extended-hours",
};

function harness(refreshed) {
  const writes = [];
  const requested = [];
  const seat = { id: "grandma", game_id: "family", seat_number: 3, player_name: 'Grandma "The Queen"',
    joined_at: now - 86_400_000, cash_cents: 12800295, bonus_cents: 0, dividend_income_cents: 0,
    dividend_tax_cents: 426, realized_net_cents: 0, tax_reserve_cents: 426 };
  const lot = { id: "purchase", seat_id: "grandma", game_id: "family", symbol: "SPCX",
    acquired_at: now - 86_400_000, remaining_shares_micros: 1_000_000_000, remaining_basis_cents: 11252000 };
  const game = { id: "family", name: "1st Klein Millionaire", status: "active", started_at: now - 86_400_000,
    created_at: now - 86_400_000, ends_at: null, ended_at: null, duration_days: 0,
    starting_cash_cents: 10000000, tax_rate_bps: 2400, target_value_cents: 100000000,
    winner_seat_id: null, period_bonuses_enabled: 0, dividends_enabled_at: null };
  let cached = { symbol: "SPCX", name: currentQuote.name, price_cents: 14749, previous_close_cents: null,
    quoted_at: Date.parse("2026-10-22T00:00:00Z"), updated_at: Date.parse("2026-10-25T22:42:58Z"), source: "Nasdaq Last Sale" };
  const db = {
    prepare(sql) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      const statement = {
        sql: normalized, values: [],
        bind(...values) { this.values = values; return this; },
        async first() {
          if (normalized.startsWith("SELECT * FROM games")) return { ...game };
          if (normalized.startsWith("SELECT * FROM seats")) return { ...seat };
          if (normalized.startsWith("SELECT * FROM quote_cache")) return { ...cached };
          return null;
        },
        async all() {
          if (normalized.startsWith("SELECT * FROM seats")) return { results: [{ ...seat }] };
          if (normalized.startsWith("SELECT * FROM lots")) return { results: [{ ...lot }] };
          if (normalized.startsWith("SELECT * FROM quote_cache")) return { results: [{ ...cached }] };
          return { results: [] };
        },
      };
      return statement;
    },
    async batch(statements) {
      writes.push(...statements);
      for (const statement of statements) {
        if (!statement.sql.startsWith("INSERT INTO quote_cache")) continue;
        assert.match(statement.sql, /WHERE excluded.quoted_at >= quote_cache.quoted_at/);
        const [symbol, name, price_cents, previous_close_cents, quoted_at, source, updated_at] = statement.values;
        if (quoted_at >= cached.quoted_at) cached = { symbol, name, price_cents, previous_close_cents, quoted_at, source, updated_at };
      }
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const exports = {};
  const modules = {
    "@/db": { getD1: () => db },
    "vinext/shims/request-context": { getRequestExecutionContext: () => undefined },
    "@/lib/game-rules.js": rules,
    "@/lib/market-freshness.js": { ...freshness,
      quoteIsStale: (quote) => freshness.quoteIsStale(quote, now),
      marketSnapshotIsFresh: (snapshot) => freshness.marketSnapshotIsFresh(snapshot, now),
    },
    "@/lib/tradable-symbols.js": symbols,
    "@/lib/stock-quotes.js": { ...stockQuotes, fetchBatchedStockQuotes: async (wanted) => {
      requested.push(...wanted); return refreshed;
    } },
  };
  vm.runInNewContext(compiled, {
    exports, require: (id) => { if (!(id in modules)) throw new Error(`Unexpected module ${id}`); return modules[id]; },
    Date: FixedDate, Intl, console, URL, Response, Request, AbortController, AbortSignal, TextEncoder, crypto: webcrypto,
    fetch: async () => Response.json({ generatedAt: new Date(now).toISOString(), mode: "live", symbols: [], session: { label: "Market open" } }),
  });
  return { exports, requested, writes, seat, lot, game, cache: () => cached };
}

test("the first game response refreshes Grandma's SpaceX valuation without altering purchases or cash", async () => {
  const h = harness([currentQuote]);
  const before = JSON.stringify({ seat: h.seat, lot: h.lot, game: h.game });
  const response = await h.exports.GET(new Request("https://example.test/api/game?gameId=family", {
    headers: { Authorization: "Bearer test-player-token" },
  }));
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.deepEqual(h.requested, ["SPCX"]);
  assert.equal(data.you.holdings[0].shares, 1_000);
  assert.equal(data.you.holdings[0].averageCostCents, 11252);
  assert.equal(data.you.holdings[0].marketValueCents, 12329000);
  assert.equal(data.you.holdings[0].quotedAt, currentQuote.generatedAt);
  assert.equal(data.you.holdings[0].quoteStale, false);
  assert.equal(data.you.afterTaxCents, 25128869);
  assert.equal(h.cache().price_cents, 12329);
  assert.deepEqual(data.market.staleSymbols, []);
  assert.equal(JSON.stringify({ seat: h.seat, lot: h.lot, game: h.game }), before);
  assert.ok(h.writes.every((statement) => /^INSERT INTO (quote_cache|portfolio_snapshots) /.test(statement.sql)));
});

test("provider failure leaves positions intact, labels the stale value, and does not record a bad trend point", async () => {
  const h = harness([]);
  const response = await h.exports.GET(new Request("https://example.test/api/game?gameId=family", {
    headers: { Authorization: "Bearer test-player-token" },
  }));
  const data = await response.json();
  assert.equal(response.status, 200, JSON.stringify(data));
  assert.equal(data.you.holdings[0].priceCents, 14749);
  assert.equal(data.you.holdings[0].quoteStale, true);
  assert.equal(data.you.valuationStale, true);
  assert.deepEqual(data.market.staleSymbols, ["SPCX"]);
  assert.equal(h.writes.length, 0);
});
