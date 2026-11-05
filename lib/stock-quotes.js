// Public, key-free batch quotes. Keep prices paired with their actual trade time,
// including pre/post-market bars; never stamp an old quote with the request time.
export function parseSparkQuotes(payload, requestedSymbols, nowMs = Date.now()) {
  const requested = new Set(requestedSymbols);
  const quotes = [];
  for (const entry of payload?.spark?.result ?? []) {
    if (!requested.has(entry.symbol)) continue;
    const chart = entry.response?.[0];
    const meta = chart?.meta;
    if (!meta || meta.symbol !== entry.symbol || meta.currency !== "USD") continue;
    if (!["EQUITY", "ETF"].includes(meta.instrumentType)) continue;
    const candidates = [];
    const closes = chart.indicators?.quote?.[0]?.close ?? [];
    for (let i = (chart.timestamp?.length ?? 0) - 1; i >= 0; i -= 1) {
      const price = Number(closes[i]);
      const at = Number(chart.timestamp[i]) * 1_000;
      if (price > 0 && Number.isFinite(price) && at > 0 && at <= nowMs + 60_000) {
        candidates.push({ price, at });
        break;
      }
    }
    const regularPrice = Number(meta.regularMarketPrice);
    const regularAt = Number(meta.regularMarketTime) * 1_000;
    if (regularPrice > 0 && Number.isFinite(regularPrice) && regularAt > 0 && regularAt <= nowMs + 60_000) {
      candidates.push({ price: regularPrice, at: regularAt });
    }
    const latest = candidates.sort((a, b) => b.at - a.at)[0];
    if (!latest || Math.round(latest.price * 100) <= 0) continue;
    const previous = Number(meta.chartPreviousClose ?? meta.previousClose);
    quotes.push({
      symbol: entry.symbol,
      name: String(meta.longName ?? meta.shortName ?? entry.symbol).slice(0, 80),
      priceCents: Math.round(latest.price * 100),
      previousCloseCents: previous > 0 && Number.isFinite(previous) ? Math.round(previous * 100) : null,
      generatedAt: new Date(latest.at).toISOString(),
      source: "Yahoo Finance extended-hours",
    });
  }
  return quotes;
}

/**
 * @param {string[]} symbols
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, signal?: AbortSignal, nowMs?: number}} [options]
 */
export async function fetchBatchedStockQuotes(symbols, {
  fetchImpl = fetch,
  timeoutMs = 4_500,
  signal,
  nowMs = Date.now(),
} = {}) {
  const unique = [...new Set(symbols)];
  const batches = [];
  for (let i = 0; i < unique.length; i += 20) batches.push(unique.slice(i, i + 20));
  const timeout = AbortSignal.timeout(timeoutMs);
  const deadlineSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const results = await mapWithConcurrency(batches, 2, async (batch) => {
    const params = new URLSearchParams({
      symbols: batch.join(","), range: "1d", interval: "1m", includePrePost: "true",
    });
    const response = await fetchImpl(`https://query1.finance.yahoo.com/v7/finance/spark?${params}`, {
      cache: "no-store",
      signal: deadlineSignal,
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 TickerQuest/1.0" },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Batch quote request returned ${response.status}.`);
    }
    return parseSparkQuotes(await response.json(), batch, nowMs);
  });
  return results.flatMap((result) => {
    if (result.status === "fulfilled") return result.value;
    console.warn("Stock batch refresh failed:", String(result.reason?.message ?? result.reason));
    return [];
  });
}

export async function mapWithConcurrency(items, concurrency, run) {
  const results = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = { status: "fulfilled", value: await run(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }));
  return results;
}

export function nasdaqTradeTimestamp(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/\sET$/i.test(text)) {
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const wallTime = Date.parse(text.replace(/\sET$/i, " UTC"));
  if (!Number.isFinite(wallTime)) return null;
  const zone = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", timeZoneName: "shortOffset",
  }).formatToParts(wallTime).find((part) => part.type === "timeZoneName")?.value;
  const offset = zone?.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/);
  if (!offset) return null;
  const minutes = (Number(offset[2]) * 60 + Number(offset[3] ?? 0)) * (offset[1] === "-" ? -1 : 1);
  return wallTime - minutes * 60_000;
}
