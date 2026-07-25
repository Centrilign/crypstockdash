import os
import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed

import pandas as pd
import yfinance as yf
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# ---------------------------------------------------------------------------
# Every route in this file returns data straight from Yahoo Finance via
# yfinance. There is no synthetic, seeded, or randomly generated fallback
# anywhere in this service. If live data can't be fetched, the route returns
# an error and the frontend shows that honestly instead of inventing a number.
# ---------------------------------------------------------------------------

_CACHE = {}
_CACHE_LOCK = threading.Lock()


def cache_get(key):
    with _CACHE_LOCK:
        entry = _CACHE.get(key)
        if not entry:
            return None
        value, expires_at = entry
        if time.time() > expires_at:
            _CACHE.pop(key, None)
            return None
        return value


def cache_set(key, value, ttl):
    with _CACHE_LOCK:
        _CACHE[key] = (value, time.time() + ttl)


# Interval -> real yfinance (period, interval) mapping. Each horizon maps to
# genuine OHLC bar granularity, not a resampled or invented series.
INTERVAL_MAP = {
    "1D": {"period": "1d", "interval": "5m"},
    "1W": {"period": "5d", "interval": "30m"},
    "1M": {"period": "1mo", "interval": "1d"},
    "6M": {"period": "6mo", "interval": "1d"},
    "1Y": {"period": "1y", "interval": "1wk"},
    "5Y": {"period": "5y", "interval": "1mo"},
}


def clean_symbol(raw):
    return (raw or "").strip().upper()


@app.route("/")
def health():
    return jsonify({"status": "ok", "service": "CrypStockDash API"})


@app.route("/api/history/<symbol>/<horizon>")
def get_history(symbol, horizon):
    symbol = clean_symbol(symbol)
    params = INTERVAL_MAP.get(horizon)
    if not params:
        return jsonify({"error": f"Unsupported interval '{horizon}'."}), 400

    cache_key = f"history:{symbol}:{horizon}"
    cached = cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)

    try:
        df = yf.Ticker(symbol).history(
            period=params["period"], interval=params["interval"], auto_adjust=True
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    if df.empty:
        return jsonify({"error": f"No market data returned for '{symbol}'."}), 404

    df = df.dropna(subset=["Open", "High", "Low", "Close"])
    if df.empty:
        return jsonify({"error": f"No usable OHLC bars for '{symbol}'."}), 404

    candles = []
    for ts, row in df.iterrows():
        candles.append({
            "t": int(ts.timestamp() * 1000),
            "o": round(float(row["Open"]), 6),
            "h": round(float(row["High"]), 6),
            "l": round(float(row["Low"]), 6),
            "c": round(float(row["Close"]), 6),
            "v": int(row["Volume"]) if "Volume" in row and pd.notna(row["Volume"]) else 0,
        })

    payload = {"symbol": symbol, "interval": horizon, "candles": candles}
    cache_set(cache_key, payload, ttl=25)
    return jsonify(payload)


def _resolve_price(info, ticker):
    """Real live price + previous close. Falls back to real daily bars only
    when Yahoo's info payload is missing the live quote fields, never to a
    made-up number."""
    price = info.get("currentPrice") or info.get("regularMarketPrice")
    previous_close = info.get("previousClose") or info.get("regularMarketPreviousClose")

    if price is not None and previous_close is not None:
        return float(price), float(previous_close)

    df = ticker.history(period="5d", interval="1d", auto_adjust=True)
    df = df.dropna(subset=["Close"])
    if df.empty:
        return price, previous_close

    closes = df["Close"].tolist()
    if price is None:
        price = float(closes[-1])
    if previous_close is None:
        previous_close = float(closes[-2]) if len(closes) > 1 else None

    return price, previous_close


def fetch_quote(symbol):
    ticker = yf.Ticker(symbol)
    info = {}
    try:
        info = ticker.info or {}
    except Exception:
        info = {}

    price, previous_close = _resolve_price(info, ticker)
    if price is None:
        return None

    change = None
    change_percent = None
    if previous_close:
        change = price - previous_close
        change_percent = (change / previous_close) * 100

    officers = info.get("companyOfficers") or []
    ceo = None
    if isinstance(officers, list) and officers:
        ceo = officers[0].get("name")

    hq_parts = [info.get("city"), info.get("state"), info.get("country")]
    hq = ", ".join([p for p in hq_parts if p]) or None

    is_crypto = info.get("quoteType") == "CRYPTOCURRENCY" or symbol.endswith("-USD")

    return {
        "symbol": symbol,
        "name": info.get("longName") or info.get("shortName") or symbol,
        "exchange": info.get("fullExchangeName") or info.get("exchange"),
        "quoteType": info.get("quoteType"),
        "sector": info.get("sector") or ("Cryptocurrency" if is_crypto else None),
        "currency": info.get("currency"),
        "price": round(float(price), 6),
        "previousClose": round(float(previous_close), 6) if previous_close else None,
        "change": round(change, 6) if change is not None else None,
        "changePercent": round(change_percent, 4) if change_percent is not None else None,
        "dayHigh": info.get("dayHigh") or info.get("regularMarketDayHigh"),
        "dayLow": info.get("dayLow") or info.get("regularMarketDayLow"),
        "fiftyTwoWeekHigh": info.get("fiftyTwoWeekHigh"),
        "fiftyTwoWeekLow": info.get("fiftyTwoWeekLow"),
        "volume": info.get("volume") or info.get("regularMarketVolume"),
        "averageVolume": info.get("averageVolume"),
        "marketCap": info.get("marketCap"),
        "peRatio": info.get("trailingPE"),
        "targetHigh": info.get("targetHighPrice"),
        "targetLow": info.get("targetLowPrice"),
        "targetMedian": info.get("targetMedianPrice"),
        "targetMean": info.get("targetMeanPrice"),
        "recommendationKey": info.get("recommendationKey"),
        "numberOfAnalystOpinions": info.get("numberOfAnalystOpinions"),
        "hq": hq,
        "ceo": ceo,
        "employees": info.get("fullTimeEmployees"),
        "description": info.get("longBusinessSummary"),
    }


@app.route("/api/quote/<symbol>")
def get_quote(symbol):
    symbol = clean_symbol(symbol)
    cache_key = f"quote:{symbol}"
    cached = cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)

    try:
        payload = fetch_quote(symbol)
    except Exception as e:
        return jsonify({"error": str(e)}), 502

    if payload is None:
        return jsonify({"error": f"'{symbol}' could not be resolved to a live quote."}), 404

    cache_set(cache_key, payload, ttl=15)
    return jsonify(payload)


@app.route("/api/quotes")
def get_quotes_batch():
    raw = request.args.get("symbols", "")
    symbols = [clean_symbol(s) for s in raw.split(",") if s.strip()]
    symbols = list(dict.fromkeys(symbols))  # de-dupe, keep order

    if not symbols:
        return jsonify({"error": "Provide at least one symbol via ?symbols=AAPL,MSFT"}), 400
    if len(symbols) > 30:
        return jsonify({"error": "Maximum 30 symbols per batch request."}), 400

    cache_key = f"batch:{','.join(sorted(symbols))}"
    cached = cache_get(cache_key)
    if cached is not None:
        return jsonify(cached)

    quotes = {}
    with ThreadPoolExecutor(max_workers=min(10, len(symbols))) as executor:
        future_to_symbol = {executor.submit(fetch_quote, sym): sym for sym in symbols}
        for future in as_completed(future_to_symbol):
            sym = future_to_symbol[future]
            try:
                q = future.result()
                quotes[sym] = q if q is not None else {"error": True}
            except Exception:
                quotes[sym] = {"error": True}

    payload = {"quotes": quotes}
    cache_set(cache_key, payload, ttl=20)
    return jsonify(payload)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    debug = os.environ.get("FLASK_DEBUG", "0") == "1"
    app.run(host="0.0.0.0", port=port, debug=debug)
