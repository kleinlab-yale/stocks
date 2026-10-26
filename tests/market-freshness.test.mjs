import assert from "node:assert/strict";
import test from "node:test";
import {
  marketSnapshotIsFresh,
  newestQuotesBySymbol,
} from "../lib/market-freshness.js";

test("a frozen September snapshot cannot block October live quote refreshes", () => {
  const now = Date.parse("2026-10-25T15:00:00Z");
  assert.equal(marketSnapshotIsFresh({
    generatedAt: "2026-09-30T19:39:54Z", mode: "live",
  }, now), false);
  assert.equal(marketSnapshotIsFresh({
    generatedAt: "2026-10-25T14:45:00Z", mode: "live",
  }, now), true);
});

test("portfolio valuation uses a newer cached quote over a frozen shared quote", () => {
  const oldQuote = {
    symbol: "NVDA", priceCents: 23067, generatedAt: "2026-09-30T19:39:54Z",
  };
  const newQuote = {
    symbol: "NVDA", priceCents: 24000, generatedAt: "2026-10-23T19:59:00Z",
  };
  assert.deepEqual(newestQuotesBySymbol([oldQuote, newQuote]), [newQuote]);
  assert.deepEqual(newestQuotesBySymbol([newQuote, oldQuote]), [newQuote]);
});

test("last known prices remain available while the live quote refresh is pending", () => {
  const oldQuote = {
    symbol: "NVDA", priceCents: 23067, generatedAt: "2026-09-30T19:39:54Z",
  };
  assert.deepEqual(newestQuotesBySymbol([oldQuote]), [oldQuote]);
});
