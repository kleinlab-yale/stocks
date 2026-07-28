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
