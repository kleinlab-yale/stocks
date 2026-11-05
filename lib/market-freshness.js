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

export function quoteIsStale(quote, nowMs = Date.now()) {
  const at = Date.parse(quote?.generatedAt ?? "");
  if (!quote?.priceCents || !Number.isFinite(at) || at > nowMs + 60_000) return true;
  const age = nowMs - at;
  if (String(quote.symbol).endsWith("-USD")) return age > 15 * 60_000;
  // A Friday close is a valid weekend price. Allow long holiday weekends, but
  // flag old prices promptly while extended-hours markets should be updating.
  if (age > 4 * 86_400_000) return true;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "numeric", hourCycle: "h23",
  }).formatToParts(nowMs);
  const day = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  return !["Sat", "Sun"].includes(day) && hour >= 4 && hour < 20 && age > 60 * 60_000;
}
