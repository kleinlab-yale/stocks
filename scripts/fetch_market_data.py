#!/usr/bin/env python3
"""Build the static market snapshot consumed by TickerQuest."""

from __future__ import annotations

import json
import math
from datetime import datetime, time, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import yfinance as yf


ROOT = Path(__file__).resolve().parents[1]
WATCHLIST_PATH = ROOT / "config" / "watchlist.json"
OUTPUT_PATH = ROOT / "site" / "data" / "market.json"
EASTERN = ZoneInfo("America/New_York")


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
    payload = {
        "generatedAt": now_utc.isoformat().replace("+00:00", "Z"),
        "mode": "live" if healthy == len(results) and results else "degraded",
        "source": "Yahoo Finance via yfinance",
        "cadenceMinutes": 15,
        "session": session_for(now_et),
        "symbols": results,
        "errors": errors,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"Wrote {len(results)} symbols ({healthy} fresh, {len(errors)} errors)")


if __name__ == "__main__":
    main()
