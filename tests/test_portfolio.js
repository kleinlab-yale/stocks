const test = require("node:test");
const assert = require("node:assert/strict");
const Portfolio = require("../site/portfolio.js");

test("aggregates multiple purchases into cost basis and total return", () => {
  const holding = {
    symbol: "NVDA",
    lots: [
      { id: "a", shares: 10, price: 100 },
      { id: "b", shares: 5, price: 130 },
    ],
  };
  const summary = Portfolio.summarizeHolding(holding, 150);
  assert.equal(summary.shares, 15);
  assert.equal(summary.costBasis, 1650);
  assert.equal(summary.averageCost, 110);
  assert.equal(summary.marketValue, 2250);
  assert.equal(summary.unrealized, 600);
  assert.ok(Math.abs(summary.returnPercent - 36.363636) < 0.00001);
  assert.equal(summary.complete, true);
});

test("reports partial cost coverage without inventing a purchase price", () => {
  const holding = {
    symbol: "META",
    lots: [
      { id: "a", shares: 2, price: 400 },
      { id: "b", shares: 1, price: null },
    ],
  };
  const summary = Portfolio.summarizeHolding(holding, 500);
  assert.equal(summary.shares, 3);
  assert.equal(summary.pricedShares, 2);
  assert.equal(summary.costBasis, 800);
  assert.equal(summary.unrealized, 200);
  assert.equal(summary.complete, false);
});

test("migrates legacy share counts and merges duplicate symbols into lots", () => {
  let id = 0;
  const holdings = Portfolio.normalizeHoldings([
    { symbol: "amd", shares: 2 },
    { symbol: "AMD", shares: 3, buyPrice: 120 },
  ], [], () => `lot-${++id}`);
  assert.equal(holdings.length, 1);
  assert.equal(holdings[0].symbol, "AMD");
  assert.equal(holdings[0].lots.length, 2);
  assert.equal(holdings[0].lots[0].price, null);
  assert.equal(holdings[0].lots[1].price, 120);
  assert.equal(Portfolio.totalShares(holdings[0]), 5);
});

test("keeps an intentionally empty saved portfolio empty", () => {
  const holdings = Portfolio.normalizeHoldings([], [{ symbol: "NVDA" }], () => "lot-1");
  assert.deepEqual(holdings, []);
});

test("creates the default lineup only when no saved portfolio exists", () => {
  let id = 0;
  const holdings = Portfolio.normalizeHoldings(null, [{ symbol: "NVDA" }, { symbol: "META" }], () => `lot-${++id}`);
  assert.equal(holdings.length, 2);
  assert.equal(holdings[0].lots[0].price, null);
});
