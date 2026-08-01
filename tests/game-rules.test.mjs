import test from "node:test";
import assert from "node:assert/strict";
import {
  SHARES_SCALE,
  afterTaxValueCents,
  allocateFifoSale,
  applyPendingWashLosses,
  completedCompetitionPeriod,
  dividendGrossCents,
  easternTimestampForUsDate,
  endGameConfirmationIsValid,
  grossCents,
  gameEndsAt,
  quoteTimestampIsExecutable,
  selectPeriodBonusWinner,
  sharesHeldMicrosAt,
  sharesToMicros,
  targetValueReached,
  taxReserveCents,
  totalTaxReserveCents,
  tradingIsActive,
} from "../lib/game-rules.js";

test("requires the exact destructive-action phrase before ending a game", () => {
  assert.equal(endGameConfirmationIsValid("END GAME"), true);
  assert.equal(endGameConfirmationIsValid(" END GAME "), true);
  assert.equal(endGameConfirmationIsValid("end game"), false);
  assert.equal(endGameConfirmationIsValid(""), false);
});

test("converts fractional shares and values a trade in cents", () => {
  assert.equal(sharesToMicros(2.5), 2.5 * SHARES_SCALE);
  assert.equal(grossCents(sharesToMicros(2.5), 12_345), 30_863);
});

test("calculates a standardized 24 percent tax reserve on net gains", () => {
  assert.equal(taxReserveCents(100_000, 2_400), 24_000);
  assert.equal(taxReserveCents(-100_000, 2_400), 0);
});

test("keeps dividend tax reserved when a later stock sale is a loss", () => {
  assert.equal(totalTaxReserveCents(-10_000, 240, 2_400), 240);
  assert.equal(totalTaxReserveCents(10_000, 240, 2_400), 2_640);
});

test("calculates fractional-share dividends to the nearest cent", () => {
  assert.equal(
    dividendGrossCents(2.5 * SHARES_SCALE, 250_000),
    63,
  );
  assert.equal(dividendGrossCents(SHARES_SCALE, 2_500), 0);
});

test("uses shares owned before the ex-dividend date", () => {
  const exAt = Date.parse("2026-08-10T04:00:00Z");
  assert.equal(
    sharesHeldMicrosAt(
      [
        { side: "buy", shares_micros: 4 * SHARES_SCALE, created_at: exAt - 2 },
        { side: "sell", shares_micros: SHARES_SCALE, created_at: exAt - 1 },
        { side: "buy", shares_micros: 9 * SHARES_SCALE, created_at: exAt },
        { side: "sell", shares_micros: 2 * SHARES_SCALE, created_at: exAt + 1 },
      ],
      exAt,
    ),
    3 * SHARES_SCALE,
  );
});

test("parses Nasdaq dividend dates at New York midnight", () => {
  assert.equal(
    easternTimestampForUsDate("08/10/2026"),
    Date.parse("2026-08-10T04:00:00Z"),
  );
  assert.equal(
    easternTimestampForUsDate("12/10/2026"),
    Date.parse("2026-12-10T05:00:00Z"),
  );
  assert.equal(easternTimestampForUsDate("02/30/2026"), null);
});

test("never adds tax to a sale at a realized loss", () => {
  const sale = allocateFifoSale(
    [
      {
        id: "loss-lot",
        remainingSharesMicros: SHARES_SCALE,
        remainingBasisCents: 20_000,
      },
    ],
    SHARES_SCALE,
    10_000,
  );
  assert.equal(sale.realizedGainCents, -10_000);
  assert.equal(taxReserveCents(sale.realizedGainCents, 2_400), 0);

  const reserveBeforeLoss = taxReserveCents(50_000, 2_400);
  const reserveAfterLoss = taxReserveCents(
    50_000 + sale.realizedGainCents,
    2_400,
  );
  assert.ok(reserveAfterLoss < reserveBeforeLoss);
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

test("allocates a sale from D1 snake-case lot rows", () => {
  const result = allocateFifoSale(
    [
      {
        id: "d1-lot",
        remaining_shares_micros: 2 * SHARES_SCALE,
        remaining_basis_cents: 20_000,
      },
    ],
    SHARES_SCALE,
    15_000,
  );
  assert.equal(result.proceedsCents, 15_000);
  assert.equal(result.basisCents, 10_000);
  assert.deepEqual(result.allocations[0], {
    id: "d1-lot",
    sharesMicros: SHARES_SCALE,
    basisCents: 10_000,
    remainingSharesMicros: SHARES_SCALE,
    remainingBasisCents: 10_000,
  });
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

test("applies wash-sale losses from D1 snake-case rows", () => {
  const result = applyPendingWashLosses(
    [
      {
        id: "d1-wash",
        remaining_shares_micros: 2 * SHARES_SCALE,
        remaining_loss_cents: 4_000,
      },
    ],
    SHARES_SCALE,
  );
  assert.equal(result.deferredLossCents, 2_000);
  assert.deepEqual(result.updates[0], {
    id: "d1-wash",
    remainingSharesMicros: SHARES_SCALE,
    remainingLossCents: 2_000,
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

test("supports year-long and no-end game schedules", () => {
  const startedAt = Date.parse("2026-07-28T12:00:00Z");
  assert.equal(
    gameEndsAt(startedAt, 365),
    startedAt + 365 * 24 * 60 * 60 * 1_000,
  );
  assert.equal(gameEndsAt(startedAt, 0), null);
});

test("keeps trading active when an active game has no end date", () => {
  const now = Date.parse("2026-07-28T12:00:00Z");
  assert.equal(tradingIsActive("active", null, now), true);
  assert.equal(tradingIsActive("ended", null, now), false);
  assert.equal(tradingIsActive("active", now - 1, now), false);
});

test("ends a target-value game exactly when the portfolio reaches its goal", () => {
  assert.equal(targetValueReached(99_999_999, 100_000_000), false);
  assert.equal(targetValueReached(100_000_000, 100_000_000), true);
  assert.equal(targetValueReached(100_000_001, 100_000_000), true);
  assert.equal(targetValueReached(100_000_000, null), false);
});

test("builds completed day, week, and month bonus windows in New York time", () => {
  const now = Date.parse("2026-07-28T12:00:00Z");
  assert.deepEqual(completedCompetitionPeriod("day", now), {
    periodType: "day",
    key: "2026-07-27",
    startAt: Date.parse("2026-07-27T04:00:00Z"),
    endAt: Date.parse("2026-07-28T04:00:00Z"),
  });
  assert.deepEqual(completedCompetitionPeriod("week", now), {
    periodType: "week",
    key: "2026-07-20",
    startAt: Date.parse("2026-07-20T04:00:00Z"),
    endAt: Date.parse("2026-07-27T04:00:00Z"),
  });
  assert.deepEqual(completedCompetitionPeriod("month", now), {
    periodType: "month",
    key: "2026-06",
    startAt: Date.parse("2026-06-01T04:00:00Z"),
    endAt: Date.parse("2026-07-01T04:00:00Z"),
  });
});

test("selects a unique period bonus winner and pays no tied period", () => {
  const candidates = [
    {
      seatId: "one",
      startValue: 1_000_000,
      endValue: 1_020_000,
      startAt: 1,
      endAt: 2,
    },
    {
      seatId: "two",
      startValue: 1_000_000,
      endValue: 1_010_000,
      startAt: 1,
      endAt: 2,
    },
  ];
  assert.deepEqual(selectPeriodBonusWinner(candidates), {
    winner: { seatId: "one", endValue: 1_020_000, changeBps: 200 },
    winningChangeBps: 200,
  });
  assert.equal(
    selectPeriodBonusWinner([
      candidates[0],
      { ...candidates[0], seatId: "two" },
    ]).winner,
    null,
  );
});
