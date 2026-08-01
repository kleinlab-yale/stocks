import assert from "node:assert/strict";
import test from "node:test";

import {
  cryptoBaseSymbol,
  cryptoDisplayName,
  isCryptoPair,
  normalizeTradableSymbol,
} from "../lib/tradable-symbols.js";

test("common crypto symbols normalize to explicit Coinbase USD pairs", () => {
  assert.equal(normalizeTradableSymbol("btc"), "BTC-USD");
  assert.equal(normalizeTradableSymbol(" ETH "), "ETH-USD");
  assert.equal(normalizeTradableSymbol("SOL-USD"), "SOL-USD");
});

test("stock and ETF tickers remain unchanged", () => {
  assert.equal(normalizeTradableSymbol("AAPL"), "AAPL");
  assert.equal(normalizeTradableSymbol("SPY"), "SPY");
});

test("crypto pair helpers expose a clean player-facing identity", () => {
  assert.equal(isCryptoPair("BTC-USD"), true);
  assert.equal(isCryptoPair("BTC"), false);
  assert.equal(cryptoBaseSymbol("BTC-USD"), "BTC");
  assert.equal(cryptoDisplayName("BTC-USD"), "Bitcoin");
  assert.equal(cryptoDisplayName("MKR-USD"), "MKR");
});
