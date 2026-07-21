#!/usr/bin/env python3
"""Build the static market snapshot consumed by TickerQuest."""

from __future__ import annotations

import json
import math
import re
from datetime import datetime, time, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

import yfinance as yf


ROOT = Path(__file__).resolve().parents[1]
WATCHLIST_PATH = ROOT / "config" / "watchlist.json"
OUTPUT_PATH = ROOT / "site" / "data" / "market.json"
EASTERN = ZoneInfo("America/New_York")
GDELT_DOC_URL = "https://api.gdeltproject.org/api/v2/doc/doc"
NEWS_QUERY = (
    '(war OR conflict OR missile OR sanctions OR ceasefire OR tariff OR '
    '"Donald Trump" OR "artificial intelligence" OR Nvidia OR semiconductor OR '
    '"Federal Reserve") sourcelang:english'
)
ASIAN_MARKETS = [
    ("^N225", "Nikkei 225", 0.25),
    ("^HSI", "Hang Seng", 0.25),
    ("000001.SS", "Shanghai", 0.20),
    ("^KS11", "KOSPI", 0.15),
    ("^TWII", "Taiwan", 0.15),
]
CATEGORY_TERMS = {
    "Geopolitics": ("war", "conflict", "missile", "attack", "sanction", "ceasefire", "iran", "israel", "russia", "ukraine", "china", "taiwan"),
    "Policy": ("trump", "white house", "tariff", "trade", "federal reserve", "fed", "export control", "regulation"),
    "AI & chips": ("artificial intelligence", " ai ", "nvidia", "semiconductor", "chip", "data center", "microsoft", "google", "meta"),
}
POSITIVE_TERMS = (
    "agreement", "approve", "beat", "breakthrough", "ceasefire", "deal", "easing",
    "gain", "growth", "optimism", "peace", "rally", "rebound", "strong", "surge",
)
NEGATIVE_TERMS = (
    "attack", "ban", "bomb", "conflict", "crisis", "escalat", "inflation", "investigation",
    "missile", "probe", "recession", "restrict", "sanction", "slump", "tariff", "threat",
    "war", "warning", "weak",
)
IRRELEVANT_NEWS_TERMS = ("world war ii", "pearl harbor", "civil war history", "war museum", "war anniversary")


def number(value: Any) -> float | None:
    """Return a finite float or None."""
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def last_number(series: Any) -> float | None:
    try:
        cleaned = series.dropna()
        return number(cleaned.iloc[-1]) if not cleaned.empty else None
    except (AttributeError, IndexError, TypeError):
        return None


def clamp(value: float, low: float = 0, high: float = 100) -> float:
    return max(low, min(high, value))


def phrase_count(text: str, terms: tuple[str, ...]) -> int:
    lowered = text.lower()
    hits = 0
    for term in terms:
        needle = term.strip()
        suffix = r"\w*" if needle in {"escalat", "restrict"} else ""
        if re.search(rf"\b{re.escape(needle)}{suffix}\b", lowered):
            hits += 1
    return hits


def headline_signal(title: str) -> tuple[str, int]:
    """Classify a headline and return a transparent -3..3 market signal."""
    cleaned = re.sub(r"\s+", " ", title).strip().lower()
    category_hits = {name: phrase_count(cleaned, terms) for name, terms in CATEGORY_TERMS.items()}
    category = max(category_hits, key=category_hits.get) if max(category_hits.values()) else "Markets"
    positive = phrase_count(cleaned, POSITIVE_TERMS)
    negative = phrase_count(cleaned, NEGATIVE_TERMS)
    return category, int(clamp(positive - negative, -3, 3))


def parse_news_time(value: str, fallback: datetime) -> datetime:
    try:
        if re.fullmatch(r"\d{8}T\d{6}Z", value or ""):
            return datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        parsed = parsedate_to_datetime(value)
        return parsed.astimezone(timezone.utc)
    except (TypeError, ValueError):
        return fallback


def score_news_records(records: list[dict[str, Any]], now_utc: datetime, source: str) -> dict[str, Any]:
    scored: list[tuple[float, dict[str, Any]]] = []
    weighted_signal = 0.0
    total_weight = 0.0
    seen_titles: set[str] = set()

    for record in records:
        title = re.sub(r"\s+", " ", str(record.get("title") or "")).strip()
        url = str(record.get("url") or "").strip()
        normalized = re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()
        if not title or not url or normalized in seen_titles:
            continue
        seen_titles.add(normalized)
        published_value = record.get("published")
        published = published_value if isinstance(published_value, datetime) else parse_news_time(str(published_value or ""), now_utc)
        age_hours = max(0.0, (now_utc - published).total_seconds() / 3600)
        if age_hours > 24:
            continue
        recency = 0.5 ** (age_hours / 8)
        category, signal = headline_signal(title)
        if category == "Markets" or any(term in title.lower() for term in IRRELEVANT_NEWS_TERMS):
            continue
        weighted_signal += signal * recency
        total_weight += recency
        tone = "positive" if signal > 0 else "negative" if signal < 0 else "mixed"
        story = {
            "title": title,
            "url": url,
            "source": str(record.get("source") or "News source"),
            "seenAt": published.isoformat().replace("+00:00", "Z"),
            "category": category,
            "tone": tone,
        }
        scored.append((abs(signal) * 2 + recency, story))

    average_signal = weighted_signal / total_weight if total_weight else 0.0
    score = round(clamp(50 + 16 * average_signal))
    scored.sort(key=lambda item: item[0], reverse=True)
    return {
        "status": "ok" if scored else "unavailable",
        "score": score,
        "articleCount": len(scored),
        "windowHours": 18,
        "stories": [story for _, story in scored[:6]],
        "source": source,
    }


def fetch_gdelt_news(now_utc: datetime) -> dict[str, Any]:
    params = urlencode(
        {
            "query": NEWS_QUERY,
            "mode": "artlist",
            "maxrecords": 40,
            "timespan": "18h",
            "sort": "datedesc",
            "format": "json",
        }
    )
    request = Request(
        f"{GDELT_DOC_URL}?{params}",
        headers={"User-Agent": "TickerQuest/1.0 (+https://kleinlab-yale.github.io/stocks/)"},
    )
    with urlopen(request, timeout=25) as response:
        raw = response.read()
    payload = json.loads(raw.decode("utf-8"))
    records = [
        {
            "title": article.get("title"),
            "url": article.get("url"),
            "source": article.get("domain"),
            "published": article.get("seendate"),
        }
        for article in payload.get("articles", [])
    ]
    result = score_news_records(records, now_utc, "GDELT DOC 2.0")
    if result["status"] == "unavailable":
        raise RuntimeError("GDELT returned no usable recent stories")
    return result


def fetch_yahoo_news(now_utc: datetime) -> dict[str, Any]:
    records: list[dict[str, Any]] = []
    failures: list[str] = []
    queries = (
        "war",
        "Trump tariffs",
        "artificial intelligence",
        "Nvidia chips",
    )
    for query in queries:
        try:
            articles = yf.Search(query, max_results=0, news_count=8, timeout=20).news
            for article in articles:
                timestamp = number(article.get("providerPublishTime"))
                published = datetime.fromtimestamp(timestamp, tz=timezone.utc) if timestamp else now_utc
                records.append(
                    {
                        "title": article.get("title"),
                        "url": article.get("link"),
                        "source": article.get("publisher"),
                        "published": published,
                    }
                )
        except Exception as exc:
            failures.append(f"{query}: {type(exc).__name__}")
    result = score_news_records(records, now_utc, "Yahoo Finance News")
    if result["status"] == "unavailable" and failures:
        raise RuntimeError("; ".join(failures))
    return result


def fetch_overnight_news(now_utc: datetime) -> dict[str, Any]:
    try:
        return fetch_gdelt_news(now_utc)
    except Exception as gdelt_error:
        result = fetch_yahoo_news(now_utc)
        result["fallbackNote"] = f"GDELT unavailable: {type(gdelt_error).__name__}"
        return result


def fetch_asian_markets() -> dict[str, Any]:
    markets: list[dict[str, Any]] = []
    weighted_change = 0.0
    available_weight = 0.0
    for symbol, name, weight in ASIAN_MARKETS:
        try:
            history = yf.Ticker(symbol).history(period="5d", interval="1d", auto_adjust=False, actions=False)
            closes = history["Close"].dropna()
            if len(closes) < 2:
                raise RuntimeError("Not enough index history")
            previous = number(closes.iloc[-2])
            latest = number(closes.iloc[-1])
            if not previous or latest is None:
                raise RuntimeError("No usable index close")
            change_percent = ((latest - previous) / previous) * 100
            weighted_change += change_percent * weight
            available_weight += weight
            markets.append(
                {
                    "symbol": symbol,
                    "name": name,
                    "price": round(latest, 2),
                    "changePercent": round(change_percent, 2),
                    "status": "ok",
                }
            )
        except Exception as exc:
            markets.append(
                {
                    "symbol": symbol,
                    "name": name,
                    "price": None,
                    "changePercent": None,
                    "status": "unavailable",
                    "error": f"{type(exc).__name__}: {str(exc)[:120]}",
                }
            )
    average_change = weighted_change / available_weight if available_weight else None
    score = 50 if average_change is None else round(clamp(50 + 25 * math.tanh(average_change / 1.5)))
    healthy = sum(1 for market in markets if market["status"] == "ok")
    return {
        "status": "ok" if healthy == len(markets) else "partial" if healthy else "unavailable",
        "score": score,
        "averageChangePercent": round(average_change, 2) if average_change is not None else None,
        "markets": markets,
        "source": "Yahoo Finance via yfinance",
    }


def build_overnight(now_utc: datetime, errors: list[str]) -> dict[str, Any]:
    try:
        asia = fetch_asian_markets()
    except Exception as exc:
        errors.append(f"Asian markets: {type(exc).__name__}: {str(exc)[:180]}")
        asia = {"status": "unavailable", "score": 50, "averageChangePercent": None, "markets": [], "source": "Yahoo Finance via yfinance"}
    try:
        news = fetch_overnight_news(now_utc)
    except Exception as exc:
        errors.append(f"Overnight news: {type(exc).__name__}: {str(exc)[:180]}")
        news = {"status": "unavailable", "score": 50, "articleCount": 0, "windowHours": 18, "stories": [], "source": "GDELT DOC 2.0"}
    statuses = [component["status"] for component in (asia, news)]
    available = sum(status != "unavailable" for status in statuses)
    return {
        "generatedAt": now_utc.isoformat().replace("+00:00", "Z"),
        "status": "ok" if all(status == "ok" for status in statuses) else "partial" if available else "unavailable",
        "asia": asia,
        "news": news,
        "method": "Portfolio extended hours 50% · Asian markets 25% · overnight news 25%",
    }


def session_for(now_et: datetime) -> dict[str, str]:
    if now_et.weekday() >= 5:
        label = "Market closed"
    elif time(4, 0) <= now_et.time() < time(9, 30):
        label = "Pre-market"
    elif time(9, 30) <= now_et.time() < time(16, 0):
        label = "Market open"
    elif time(16, 0) <= now_et.time() < time(20, 0):
        label = "After hours"
    else:
        label = "Market closed"
    return {"label": label, "timezone": "America/New_York"}


def closes_for_clock(frame: Any, start: time, end: time, trading_date: Any = None) -> Any:
    if frame is None or frame.empty:
        return None
    localized = frame.copy()
    if localized.index.tz is None:
        localized.index = localized.index.tz_localize(EASTERN)
    else:
        localized.index = localized.index.tz_convert(EASTERN)
    clocks = localized.index.time
    mask = (clocks >= start) & (clocks < end)
    if trading_date is not None:
        mask &= localized.index.date == trading_date
    return localized[mask]["Close"]


def fetch_symbol(item: dict[str, str], now_et: datetime) -> dict[str, Any]:
    symbol = item["symbol"].strip().upper()
    ticker = yf.Ticker(symbol)
    daily = ticker.history(period="1mo", interval="1d", auto_adjust=False, actions=False)
    intraday = ticker.history(
        period="5d",
        interval="5m",
        prepost=True,
        auto_adjust=False,
        actions=False,
    )
    if daily.empty and intraday.empty:
        raise RuntimeError("No price history returned")

    try:
        metadata: dict[str, Any] = ticker.get_history_metadata() or {}
    except Exception:
        metadata = {}

    daily_close = daily["Close"].dropna() if not daily.empty else None
    daily_dates = [] if daily_close is None else [index.date() for index in daily_close.index]
    latest_daily = last_number(daily_close)
    has_today = bool(daily_dates and daily_dates[-1] == now_et.date())

    if daily_close is not None and not daily_close.empty:
        if has_today and len(daily_close) > 1:
            previous_close = number(daily_close.iloc[-2])
        else:
            previous_close = latest_daily
        week_index = -6 if has_today and len(daily_close) >= 6 else -5
        week_ago_close = number(daily_close.iloc[week_index]) if len(daily_close) >= abs(week_index) else number(daily_close.iloc[0])
        sparkline = [round(float(value), 4) for value in daily_close.iloc[-7:].tolist() if number(value) is not None]
    else:
        previous_close = number(metadata.get("previousClose"))
        week_ago_close = previous_close
        sparkline = []

    current_price = last_number(intraday["Close"]) if not intraday.empty else latest_daily
    regular_price = last_number(closes_for_clock(intraday, time(9, 30), time(16, 0), now_et.date())) or latest_daily
    premarket_price = last_number(closes_for_clock(intraday, time(4, 0), time(9, 30), now_et.date()))
    after_hours_price = last_number(closes_for_clock(intraday, time(16, 0), time(20, 0), now_et.date()))

    if current_price is None:
        current_price = regular_price or previous_close
    if current_price is None:
        raise RuntimeError("No usable price returned")
    if not sparkline or sparkline[-1] != round(current_price, 4):
        sparkline.append(round(current_price, 4))

    return {
        "symbol": symbol,
        "name": item.get("name") or metadata.get("shortName") or symbol,
        "currency": metadata.get("currency") or "USD",
        "price": round(current_price, 4),
        "regularPrice": round(regular_price, 4) if regular_price is not None else None,
        "previousClose": round(previous_close, 4) if previous_close is not None else None,
        "weekAgoClose": round(week_ago_close, 4) if week_ago_close is not None else None,
        "premarketPrice": round(premarket_price, 4) if premarket_price is not None else None,
        "afterHoursPrice": round(after_hours_price, 4) if after_hours_price is not None else None,
        "sparkline": sparkline[-8:],
        "status": "ok",
    }


def load_previous() -> dict[str, dict[str, Any]]:
    try:
        payload = json.loads(OUTPUT_PATH.read_text())
        return {item["symbol"]: item for item in payload.get("symbols", [])}
    except (OSError, KeyError, TypeError, json.JSONDecodeError):
        return {}


def main() -> None:
    watchlist = json.loads(WATCHLIST_PATH.read_text())
    previous = load_previous()
    now_utc = datetime.now(timezone.utc)
    now_et = now_utc.astimezone(EASTERN)
    results: list[dict[str, Any]] = []
    errors: list[str] = []

    for item in watchlist:
        symbol = str(item.get("symbol", "")).strip().upper()
        if not symbol:
            continue
        normalized = {"symbol": symbol, "name": str(item.get("name") or symbol)}
        try:
            results.append(fetch_symbol(normalized, now_et))
        except Exception as exc:  # one failed quote should not blank the dashboard
            errors.append(f"{symbol}: {type(exc).__name__}: {str(exc)[:180]}")
            if symbol in previous:
                fallback = dict(previous[symbol])
                fallback["status"] = "stale"
                results.append(fallback)
            else:
                results.append(
                    {
                        "symbol": symbol,
                        "name": normalized["name"],
                        "status": "unavailable",
                        "price": None,
                        "regularPrice": None,
                        "previousClose": None,
                        "weekAgoClose": None,
                        "premarketPrice": None,
                        "afterHoursPrice": None,
                        "sparkline": [],
                        "currency": "USD",
                    }
                )

    healthy = sum(1 for item in results if item.get("status") == "ok")
    overnight = build_overnight(now_utc, errors)
    payload = {
        "generatedAt": now_utc.isoformat().replace("+00:00", "Z"),
        "mode": "live" if healthy == len(results) and results else "degraded",
        "source": "Yahoo Finance via yfinance",
        "cadenceMinutes": 15,
        "session": session_for(now_et),
        "symbols": results,
        "overnight": overnight,
        "errors": errors,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"Wrote {len(results)} symbols ({healthy} fresh, {len(errors)} errors)")


if __name__ == "__main__":
    main()
