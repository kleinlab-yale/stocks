import test from "node:test";
import assert from "node:assert/strict";
import {
  SHARES_SCALE,
  afterTaxValueCents,
  allocateFifoSale,
  applyPendingWashLosses,
  grossCents,
  quoteTimestampIsExecutable,
  sharesToMicros,
  taxReserveCents,
} from "../lib/game-rules.js";

test("converts fractional shares and values a trade in cents", () => {
  assert.equal(sharesToMicros(2.5), 2.5 * SHARES_SCALE);
  assert.equal(grossCents(sharesToMicros(2.5), 12_345), 30_863);
});

test("calculates a standardized 24 percent tax reserve on net gains", () => {
  assert.equal(taxReserveCents(100_000, 2_400), 24_000);
  assert.equal(taxReserveCents(-100_000, 2_400), 0);
});

test("allocates sales through FIFO lots and calculates the realized gain", () => {
  const result = allocateFifoSale(
    [
      {
        id: "old",
        remainingSharesMicros: 2 * SHARES_SCALE,
        remainingBasisCents: 20_000,
      },
      {
        id: "new",
        remainingSharesMicros: 2 * SHARES_SCALE,
        remainingBasisCents: 30_000,
      },
    ],
    3 * SHARES_SCALE,
    20_000,
  );
  assert.equal(result.proceedsCents, 60_000);
  assert.equal(result.basisCents, 35_000);
  assert.equal(result.realizedGainCents, 25_000);
  assert.equal(result.allocations[0].remainingSharesMicros, 0);
  assert.equal(result.allocations[1].remainingSharesMicros, SHARES_SCALE);
  assert.equal(result.allocations[1].remainingBasisCents, 15_000);
});

test("defers a wash-sale loss proportionally into replacement shares", () => {
  const result = applyPendingWashLosses(
    [
      {
        id: "wash-1",
        remainingSharesMicros: 4 * SHARES_SCALE,
        remainingLossCents: 8_000,
      },
    ],
    SHARES_SCALE,
  );
  assert.equal(result.deferredLossCents, 2_000);
  assert.deepEqual(result.updates[0], {
    id: "wash-1",
    remainingSharesMicros: 3 * SHARES_SCALE,
    remainingLossCents: 6_000,
  });
});

test("ranks using cash plus holdings minus the locked tax reserve", () => {
  assert.equal(
    afterTaxValueCents({
      cashCents: 400_000,
      marketValueCents: 700_000,
      taxReserveCents: 25_000,
    }),
    1_075_000,
  );
});

test("allows weekend execution with the newest available quote", () => {
  const saturdayNoon = Date.parse("2026-07-25T16:00:00Z");
  const fridayAfterHours = "2026-07-24T23:30:00Z";
  assert.equal(
    quoteTimestampIsExecutable(fridayAfterHours, saturdayNoon),
    true,
  );
});

test("blocks execution when the shared quote is more than seven days old", () => {
  const now = Date.parse("2026-07-25T16:00:00Z");
  const oldQuote = "2026-07-17T15:59:59Z";
  assert.equal(quoteTimestampIsExecutable(oldQuote, now), false);
});
