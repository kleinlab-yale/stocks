export const SHARES_SCALE = 1_000_000;

export function sharesToMicros(value) {
  const shares = Number(value);
  if (!Number.isFinite(shares) || shares <= 0) return null;
  const micros = Math.round(shares * SHARES_SCALE);
  return micros > 0 ? micros : null;
}

export function microsToShares(value) {
  return Number(value) / SHARES_SCALE;
}

export function grossCents(sharesMicros, priceCents) {
  return Math.round((Number(sharesMicros) * Number(priceCents)) / SHARES_SCALE);
}

export function taxReserveCents(realizedNetCents, taxRateBps) {
  return Math.max(
    0,
    Math.round((Number(realizedNetCents) * Number(taxRateBps)) / 10_000),
  );
}

export function totalTaxReserveCents(
  realizedNetCents,
  dividendTaxCents,
  taxRateBps,
) {
  return (
    taxReserveCents(realizedNetCents, taxRateBps) +
    Math.max(0, Number(dividendTaxCents) || 0)
  );
}

export function dividendGrossCents(
  sharesMicros,
  amountPerShareMicros,
) {
  return Math.max(
    0,
    Math.round(
      (Number(sharesMicros) * Number(amountPerShareMicros)) / 10_000_000_000,
    ),
  );
}

export function sharesHeldMicrosAt(trades, cutoffAt) {
  return Math.max(
    0,
    trades.reduce((total, trade) => {
      const createdAt = Number(trade.createdAt ?? trade.created_at);
      if (!Number.isFinite(createdAt) || createdAt >= Number(cutoffAt)) {
        return total;
      }
      const quantity = Number(
        trade.sharesMicros ?? trade.shares_micros,
      );
      return total + (trade.side === "sell" ? -quantity : quantity);
    }, 0),
  );
}

export function allocateFifoSale(lots, requestedSharesMicros, priceCents) {
  let needed = Number(requestedSharesMicros);
  const allocations = [];
  let basisCents = 0;

  for (const lot of lots) {
    if (needed <= 0) break;
    const available = Number(
      lot.remainingSharesMicros ?? lot.remaining_shares_micros,
    );
    if (available <= 0) continue;
    const sharesMicros = Math.min(available, needed);
    const lotBasis = Number(
      lot.remainingBasisCents ?? lot.remaining_basis_cents,
    );
    const allocatedBasis =
      sharesMicros === available
        ? lotBasis
        : Math.round((lotBasis * sharesMicros) / available);
    allocations.push({
      id: lot.id,
      sharesMicros,
      basisCents: allocatedBasis,
      remainingSharesMicros: available - sharesMicros,
      remainingBasisCents: lotBasis - allocatedBasis,
    });
    basisCents += allocatedBasis;
    needed -= sharesMicros;
  }

  if (needed > 0) {
    throw new Error("Not enough shares to complete this sale.");
  }

  const proceedsCents = grossCents(requestedSharesMicros, priceCents);
  return {
    allocations,
    basisCents,
    proceedsCents,
    realizedGainCents: proceedsCents - basisCents,
  };
}

export function applyPendingWashLosses(
  washLosses,
  purchasedSharesMicros,
) {
  let needed = Number(purchasedSharesMicros);
  let deferredLossCents = 0;
  const updates = [];

  for (const loss of washLosses) {
    if (needed <= 0) break;
    const availableShares = Number(
      loss.remainingSharesMicros ?? loss.remaining_shares_micros,
    );
    const availableLoss = Number(
      loss.remainingLossCents ?? loss.remaining_loss_cents,
    );
    if (availableShares <= 0 || availableLoss <= 0) continue;
    const matchedShares = Math.min(availableShares, needed);
    const matchedLoss =
      matchedShares === availableShares
        ? availableLoss
        : Math.round((availableLoss * matchedShares) / availableShares);
    deferredLossCents += matchedLoss;
    updates.push({
      id: loss.id,
      remainingSharesMicros: availableShares - matchedShares,
      remainingLossCents: availableLoss - matchedLoss,
    });
    needed -= matchedShares;
  }

  return { deferredLossCents, updates };
}

export function afterTaxValueCents({
  cashCents,
  marketValueCents,
  taxReserveCents: reserve,
}) {
  return Number(cashCents) + Number(marketValueCents) - Number(reserve);
}

export function quoteTimestampIsExecutable(
  generatedAt,
  nowMs = Date.now(),
  maxAgeMs = 7 * 24 * 60 * 60 * 1_000,
) {
  const generatedMs = new Date(generatedAt).getTime();
  if (!Number.isFinite(generatedMs)) return false;
  const ageMs = nowMs - generatedMs;
  return ageMs >= -5 * 60 * 1_000 && ageMs <= maxAgeMs;
}

export function gameEndsAt(startedAt, durationDays) {
  const days = Number(durationDays);
  return days > 0
    ? Number(startedAt) + days * 24 * 60 * 60 * 1_000
    : null;
}

export function tradingIsActive(status, endsAt, nowMs = Date.now()) {
  return (
    status === "active" &&
    (endsAt === null || Number(nowMs) < Number(endsAt))
  );
}

export function targetValueReached(afterTaxCents, targetValueCents) {
  const target = Number(targetValueCents);
  return (
    Number.isFinite(target) &&
    target > 0 &&
    Number(afterTaxCents) >= target
  );
}

const COMPETITION_TIME_ZONE = "America/New_York";

function easternDateParts(timestamp) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: COMPETITION_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(new Date(timestamp));
  return Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
}

function shiftedCalendarDate(parts, days) {
  const shifted = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day + days),
  );
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function easternMidnight(parts) {
  const desired = Date.UTC(parts.year, parts.month - 1, parts.day);
  let candidate = desired;
  for (let pass = 0; pass < 3; pass += 1) {
    const observed = easternDateParts(candidate);
    const observedDate = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
    );
    const observedHour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: COMPETITION_TIME_ZONE,
        hour: "numeric",
        hourCycle: "h23",
      })
        .formatToParts(new Date(candidate))
        .find((part) => part.type === "hour")?.value ?? 0,
    );
    candidate += desired - observedDate - observedHour * 60 * 60 * 1_000;
  }
  return candidate;
}

export function easternTimestampForUsDate(value) {
  const match = String(value ?? "")
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const parts = {
    year: Number(match[3]),
    month: Number(match[1]),
    day: Number(match[2]),
  };
  const candidate = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day),
  );
  if (
    candidate.getUTCFullYear() !== parts.year ||
    candidate.getUTCMonth() + 1 !== parts.month ||
    candidate.getUTCDate() !== parts.day
  ) {
    return null;
  }
  return easternMidnight(parts);
}

function periodKey(parts, includeDay = true) {
  const year = String(parts.year).padStart(4, "0");
  const month = String(parts.month).padStart(2, "0");
  const day = String(parts.day).padStart(2, "0");
  return includeDay ? `${year}-${month}-${day}` : `${year}-${month}`;
}

export function completedCompetitionPeriod(periodType, nowMs = Date.now()) {
  const today = easternDateParts(nowMs);
  let startDate;
  let endDate;

  if (periodType === "day") {
    endDate = today;
    startDate = shiftedCalendarDate(today, -1);
  } else if (periodType === "week") {
    const weekday = new Date(
      Date.UTC(today.year, today.month - 1, today.day),
    ).getUTCDay();
    const daysSinceMonday = (weekday + 6) % 7;
    endDate = shiftedCalendarDate(today, -daysSinceMonday);
    startDate = shiftedCalendarDate(endDate, -7);
  } else if (periodType === "month") {
    endDate = { year: today.year, month: today.month, day: 1 };
    const previousMonth = new Date(
      Date.UTC(today.year, today.month - 2, 1),
    );
    startDate = {
      year: previousMonth.getUTCFullYear(),
      month: previousMonth.getUTCMonth() + 1,
      day: 1,
    };
  } else {
    return null;
  }

  return {
    periodType,
    key: periodKey(startDate, periodType !== "month"),
    startAt: easternMidnight(startDate),
    endAt: easternMidnight(endDate),
  };
}

export function selectPeriodBonusWinner(candidates) {
  const ranked = candidates
    .map((candidate) => {
      const startValue = Number(candidate.startValue);
      const endValue = Number(candidate.endValue);
      const startAt = Number(candidate.startAt);
      const endAt = Number(candidate.endAt);
      if (
        !Number.isFinite(startValue) ||
        !Number.isFinite(endValue) ||
        !Number.isFinite(startAt) ||
        !Number.isFinite(endAt) ||
        startValue <= 0 ||
        endAt <= startAt
      ) {
        return null;
      }
      return {
        seatId: candidate.seatId,
        endValue,
        changeBps: Math.round(
          ((endValue - startValue) / startValue) * 10_000,
        ),
      };
    })
    .filter(Boolean)
    .sort(
      (left, right) =>
        right.changeBps - left.changeBps ||
        right.endValue - left.endValue,
    );
  const winner =
    ranked[0] &&
    (!ranked[1] || ranked[0].changeBps !== ranked[1].changeBps)
      ? ranked[0]
      : null;
  return {
    winner,
    winningChangeBps: ranked[0]?.changeBps ?? 0,
  };
}
