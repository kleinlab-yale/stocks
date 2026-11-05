import assert from "node:assert/strict";
import test from "node:test";
import { fetchBatchedStockQuotes, mapWithConcurrency, nasdaqTradeTimestamp, parseSparkQuotes } from "../lib/stock-quotes.js";

const now = Date.parse("2026-11-05T18:00:00Z");
function fixture(symbol = "SPCX", overrides = {}) {
  return { symbol, response: [{
    meta: {
      symbol, currency: "USD", instrumentType: "EQUITY", longName: "Space Exploration Technologies Corp.",
      regularMarketPrice: 123.285, regularMarketTime: (now - 60_000) / 1_000, chartPreviousClose: 135.92,
      ...overrides,
    },
    timestamp: [(now - 120_000) / 1_000, (now - 60_000) / 1_000],
    indicators: { quote: [{ close: [123.4, 123.285] }] },
  }] };
}

test("SpaceX quotes replace the frozen $147.49 valuation with a timestamped live price", () => {
  const [quote] = parseSparkQuotes({ spark: { result: [fixture()] } }, ["SPCX"], now);
  assert.equal(quote.priceCents, 12329);
  assert.equal(quote.generatedAt, "2026-11-05T17:59:00.000Z");
  assert.equal(quote.previousCloseCents, 13592);
  assert.equal(1_000 * quote.priceCents / 100, 123_290);
});

test("a later extended-hours bar takes precedence over the regular close", () => {
  const entry = fixture();
  entry.response[0].timestamp.push(now / 1_000);
  entry.response[0].indicators.quote[0].close.push(124.15);
  const [quote] = parseSparkQuotes({ spark: { result: [entry] } }, ["SPCX"], now);
  assert.equal(quote.priceCents, 12415);
  assert.equal(Date.parse(quote.generatedAt), now);
});

test("missing bars do not attach today's time to an old price", () => {
  const entry = fixture();
  entry.response[0].indicators.quote[0].close = [123.4, null];
  entry.response[0].meta.regularMarketTime = (now - 3_600_000) / 1_000;
  const [quote] = parseSparkQuotes({ spark: { result: [entry] } }, ["SPCX"], now);
  assert.equal(quote.priceCents, 12340);
  assert.equal(Date.parse(quote.generatedAt), now - 120_000);
});

test("unrequested symbols, foreign currency, and unsupported instruments are not accepted", () => {
  const payload = { spark: { result: [fixture("OTHER"), fixture("SPCX", { currency: "EUR" }), fixture("SPCX", { instrumentType: "INDEX" })] } };
  assert.deepEqual(parseSparkQuotes(payload, ["SPCX"], now), []);
});

test("a family league uses batches of at most 20 and includes extended-hours data", async () => {
  const symbols = Array.from({ length: 45 }, (_, i) => `T${i}`);
  const calls = [];
  let active = 0;
  let maxActive = 0;
  const quotes = await fetchBatchedStockQuotes([...symbols, "T0"], {
    nowMs: now,
    fetchImpl: async (url) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const params = new URL(url).searchParams;
      const batch = params.get("symbols").split(",");
      calls.push(batch);
      assert.equal(params.get("includePrePost"), "true");
      assert.ok(batch.length <= 20);
      await Promise.resolve();
      active -= 1;
      return Response.json({ spark: { result: batch.map((symbol) => fixture(symbol)) } });
    },
  });
  assert.equal(calls.length, 3);
  assert.ok(maxActive <= 2);
  assert.equal(quotes.length, 45);
});

test("one failed batch does not discard successful quote batches", async () => {
  let calls = 0;
  const quotes = await fetchBatchedStockQuotes(Array.from({ length: 21 }, (_, i) => `T${i}`), {
    nowMs: now,
    fetchImpl: async () => ++calls === 1 ? new Response("Unavailable", { status: 503 }) : Response.json({ spark: { result: [fixture("T20")] } }),
  });
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].symbol, "T20");
});

test("bounded fallback workers settle failures without starving subsequent symbols", async () => {
  const seen = [];
  const result = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => {
    seen.push(n);
    if (n === 2) throw new Error("provider failed");
    return n * 2;
  });
  assert.equal(result[1].status, "rejected");
  assert.equal(result[3].value, 8);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4]);
});

test("Nasdaq Eastern timestamps respect both standard and daylight-saving time", () => {
  assert.equal(nasdaqTradeTimestamp("Nov 5, 2026 12:47 PM ET"), Date.parse("2026-11-05T17:47:00Z"));
  assert.equal(nasdaqTradeTimestamp("Oct 22, 2026 12:47 PM ET"), Date.parse("2026-10-22T16:47:00Z"));
  assert.equal(nasdaqTradeTimestamp("not a quote date"), null);
  assert.equal(nasdaqTradeTimestamp(null), null);
});
