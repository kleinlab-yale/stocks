export const MARKET_SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1_000;

export function marketSnapshotIsFresh(snapshot, nowMs = Date.now()) {
  const generatedAt = Date.parse(snapshot?.generatedAt ?? "");
  return (
    snapshot?.mode !== "demo" &&
    Number.isFinite(generatedAt) &&
    generatedAt <= nowMs + 60_000 &&
    nowMs - generatedAt <= MARKET_SNAPSHOT_MAX_AGE_MS
  );
}

export function newestQuotesBySymbol(quotes) {
  const selected = new Map();
  for (const quote of quotes) {
    const previous = selected.get(quote.symbol);
    if (
      !previous ||
      Date.parse(quote.generatedAt) > Date.parse(previous.generatedAt)
    ) {
      selected.set(quote.symbol, quote);
    }
  }
  return [...selected.values()];
}
