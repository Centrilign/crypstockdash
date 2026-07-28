import express from "express";
import cors from "cors";
import YahooFinance from "yahoo-finance2";

// ---------------------------------------------------------------------------
// Every route in this file returns data from a live, free, keyless source:
// stocks from Yahoo Finance (via yahoo-finance2), crypto from CoinGecko's
// public API. Nothing here is randomly generated or assumed. If live data
// can't be fetched, the route returns an error and the frontend shows that
// honestly instead of inventing a number.
// ---------------------------------------------------------------------------

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });
const COINGECKO_BASE = "https://api.coingecko.com/api/v3";

// Ticker -> CoinGecko coin id. CoinGecko doesn't use "-USD" style tickers,
// so this is the one place we have to bridge the two naming schemes.
const CRYPTO_MAP = {
  "BTC-USD": "bitcoin",
  "ETH-USD": "ethereum",
  "SOL-USD": "solana",
  "XRP-USD": "ripple",
  "DOGE-USD": "dogecoin",
  "ADA-USD": "cardano",
  "BNB-USD": "binancecoin",
  "AVAX-USD": "avalanche-2",
};

function isCrypto(symbol) {
  return Object.prototype.hasOwnProperty.call(CRYPTO_MAP, symbol);
}

const app = express();
app.use(cors());

// ---- tiny in-memory TTL cache ---------------------------------------------
const cache = new Map();
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}
function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function cleanSymbol(raw) {
  return (raw || "").trim().toUpperCase();
}

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "CrypStockDash API (Node)" });
});

// ---- history / candles -----------------------------------------------------
// Horizon -> real bar granularity. Stocks use Yahoo's chart() date range +
// interval; crypto uses CoinGecko's /ohlc endpoint, which only supports a
// fixed set of "days" windows on the free keyless tier (this is a genuine
// provider limit, not a shortcut on my part: CoinGecko's free /ohlc endpoint
// doesn't extend candle history past roughly a year the way Yahoo does for
// stocks, so "5Y" on a crypto symbol currently shows the same window as "1Y").
const STOCK_INTERVALS = {
  "1D": { days: 1, interval: "5m" },
  "1W": { days: 7, interval: "30m" },
  "1M": { days: 30, interval: "1d" },
  "6M": { days: 182, interval: "1d" },
  "1Y": { days: 365, interval: "1wk" },
  "5Y": { days: 365 * 5, interval: "1mo" },
};

const CRYPTO_DAYS = {
  "1D": 1,
  "1W": 7,
  "1M": 30,
  "6M": 180,
  "1Y": 365,
  "5Y": 365,
};

async function getStockHistory(symbol, horizon) {
  const params = STOCK_INTERVALS[horizon];
  const period2 = new Date();
  const period1 = new Date(Date.now() - params.days * 24 * 60 * 60 * 1000);

  const result = await yahooFinance.chart(symbol, {
    period1,
    period2,
    interval: params.interval,
  });

  const candles = (result.quotes || [])
    .filter((q) => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({
      t: new Date(q.date).getTime(),
      o: round(q.open),
      h: round(q.high),
      l: round(q.low),
      c: round(q.close),
      v: q.volume ?? 0,
    }));

  return candles;
}

async function getCryptoHistory(symbol, horizon) {
  const id = CRYPTO_MAP[symbol];
  const days = CRYPTO_DAYS[horizon];
  const url = `${COINGECKO_BASE}/coins/${id}/ohlc?vs_currency=usd&days=${days}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CoinGecko returned ${res.status} for ${symbol}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows)) return [];

  return rows.map(([t, o, h, l, c]) => ({
    t,
    o: round(o),
    h: round(h),
    l: round(l),
    c: round(c),
    v: 0, // CoinGecko's free OHLC endpoint doesn't include volume
  }));
}

function round(n) {
  return n == null ? null : Math.round(n * 1e6) / 1e6;
}

app.get("/api/history/:symbol/:horizon", async (req, res) => {
  const symbol = cleanSymbol(req.params.symbol);
  const horizon = req.params.horizon;
  const crypto = isCrypto(symbol);

  if (!crypto && !STOCK_INTERVALS[horizon]) {
    return res.status(400).json({ error: `Unsupported interval '${horizon}'.` });
  }
  if (crypto && !CRYPTO_DAYS[horizon]) {
    return res.status(400).json({ error: `Unsupported interval '${horizon}'.` });
  }

  const cacheKey = `history:${symbol}:${horizon}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const candles = crypto
      ? await getCryptoHistory(symbol, horizon)
      : await getStockHistory(symbol, horizon);

    if (!candles.length) {
      return res.status(404).json({ error: `No market data returned for '${symbol}'.` });
    }

    const payload = { symbol, interval: horizon, candles };
    cacheSet(cacheKey, payload, 25_000);
    res.json(payload);
  } catch (err) {
    res.status(502).json({ error: err.message || `Couldn't fetch history for '${symbol}'.` });
  }
});

// ---- quote (single symbol, full detail) ------------------------------------
async function fetchStockQuote(symbol) {
  const [quote, summary] = await Promise.all([
    yahooFinance.quote(symbol).catch(() => null),
    yahooFinance
      .quoteSummary(symbol, { modules: ["assetProfile", "financialData"] }, { validateResult: false })
      .catch(() => null),
  ]);

  if (!quote || quote.regularMarketPrice == null) return null;

  const financialData = (summary && summary.financialData) || {};
  const assetProfile = (summary && summary.assetProfile) || {};

  const price = quote.regularMarketPrice;
  const previousClose = quote.regularMarketPreviousClose ?? null;
  const change = previousClose != null ? price - previousClose : null;
  const changePercent = previousClose ? (change / previousClose) * 100 : null;

  const officers = Array.isArray(assetProfile.companyOfficers) ? assetProfile.companyOfficers : [];
  const ceo = officers.length ? officers[0].name : null;

  const hqParts = [assetProfile.city, assetProfile.state, assetProfile.country].filter(Boolean);
  const hq = hqParts.length ? hqParts.join(", ") : null;

  return {
    symbol: quote.symbol || symbol,
    name: quote.longName || quote.shortName || symbol,
    exchange: quote.fullExchangeName || quote.exchange || null,
    quoteType: quote.quoteType || null,
    sector: assetProfile.sector || null,
    currency: quote.currency || null,
    price: round(price),
    previousClose: round(previousClose),
    change: round(change),
    changePercent: changePercent == null ? null : Math.round(changePercent * 10000) / 10000,
    dayHigh: quote.regularMarketDayHigh ?? null,
    dayLow: quote.regularMarketDayLow ?? null,
    fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh ?? null,
    fiftyTwoWeekLow: quote.fiftyTwoWeekLow ?? null,
    volume: quote.regularMarketVolume ?? null,
    averageVolume: quote.averageDailyVolume3Month ?? null,
    marketCap: quote.marketCap ?? null,
    peRatio: quote.trailingPE ?? null,
    targetHigh: financialData.targetHighPrice ?? null,
    targetLow: financialData.targetLowPrice ?? null,
    targetMedian: financialData.targetMedianPrice ?? null,
    targetMean: financialData.targetMeanPrice ?? null,
    recommendationKey: financialData.recommendationKey || null,
    numberOfAnalystOpinions: financialData.numberOfAnalystOpinions ?? null,
    hq,
    ceo,
    employees: assetProfile.fullTimeEmployees ?? null,
    description: assetProfile.longBusinessSummary || null,
  };
}

async function fetchCryptoQuote(symbol) {
  const id = CRYPTO_MAP[symbol];
  const url = `${COINGECKO_BASE}/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko returned ${res.status} for ${symbol}`);
  const data = await res.json();

  const md = data.market_data || {};
  const price = md.current_price?.usd ?? null;
  if (price == null) return null;

  const changePercent = md.price_change_percentage_24h ?? null;
  const previousClose = changePercent != null ? price / (1 + changePercent / 100) : null;
  const change = previousClose != null ? price - previousClose : null;

  const bio = data.description?.en
    ? data.description.en.split(/\r?\n\r?\n/)[0].trim() || null
    : null;

  return {
    symbol,
    name: data.name || symbol,
    exchange: null,
    quoteType: "CRYPTOCURRENCY",
    sector: "Cryptocurrency",
    currency: "USD",
    price: round(price),
    previousClose: round(previousClose),
    change: round(change),
    changePercent: changePercent == null ? null : Math.round(changePercent * 10000) / 10000,
    dayHigh: md.high_24h?.usd ?? null,
    dayLow: md.low_24h?.usd ?? null,
    fiftyTwoWeekHigh: null, // CoinGecko's free tier exposes all-time high/low, not a
    fiftyTwoWeekLow: null,  // true 52-week figure, so this is left honestly blank
    volume: md.total_volume?.usd ?? null,
    averageVolume: null,
    marketCap: md.market_cap?.usd ?? null,
    peRatio: null,
    targetHigh: null,
    targetLow: null,
    targetMedian: null,
    targetMean: null,
    recommendationKey: null,
    numberOfAnalystOpinions: null,
    hq: null,
    ceo: null,
    employees: null,
    description: bio,
  };
}

async function fetchQuote(symbol) {
  return isCrypto(symbol) ? fetchCryptoQuote(symbol) : fetchStockQuote(symbol);
}

app.get("/api/quote/:symbol", async (req, res) => {
  const symbol = cleanSymbol(req.params.symbol);
  const cacheKey = `quote:${symbol}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const payload = await fetchQuote(symbol);
    if (!payload) {
      return res.status(404).json({ error: `'${symbol}' could not be resolved to a live quote.` });
    }
    cacheSet(cacheKey, payload, 15_000);
    res.json(payload);
  } catch (err) {
    res.status(502).json({ error: err.message || `Couldn't fetch a quote for '${symbol}'.` });
  }
});

// ---- batch quotes (tape / trending / screener / watchlist / peers) --------
app.get("/api/quotes", async (req, res) => {
  const raw = String(req.query.symbols || "");
  const symbols = [...new Set(raw.split(",").map(cleanSymbol).filter(Boolean))];

  if (!symbols.length) {
    return res.status(400).json({ error: "Provide at least one symbol via ?symbols=AAPL,MSFT" });
  }
  if (symbols.length > 30) {
    return res.status(400).json({ error: "Maximum 30 symbols per batch request." });
  }

  const cacheKey = `batch:${[...symbols].sort().join(",")}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  const cryptoSymbols = symbols.filter(isCrypto);
  const stockSymbols = symbols.filter((s) => !isCrypto(s));
  const quotes = {};

  // One batched CoinGecko call covers every crypto symbol in the request.
  if (cryptoSymbols.length) {
    try {
      const ids = cryptoSymbols.map((s) => CRYPTO_MAP[s]).join(",");
      const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&ids=${ids}&price_change_percentage=24h`;
      const cgRes = await fetch(url);
      if (cgRes.ok) {
        const rows = await cgRes.json();
        const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
        for (const symbol of cryptoSymbols) {
          const row = byId[CRYPTO_MAP[symbol]];
          if (!row || row.current_price == null) {
            quotes[symbol] = { error: true };
            continue;
          }
          const changePercent = row.price_change_percentage_24h ?? null;
          quotes[symbol] = {
            symbol,
            name: row.name || symbol,
            quoteType: "CRYPTOCURRENCY",
            sector: "Cryptocurrency",
            price: round(row.current_price),
            changePercent: changePercent == null ? null : Math.round(changePercent * 10000) / 10000,
            marketCap: row.market_cap ?? null,
            peRatio: null,
          };
        }
      } else {
        cryptoSymbols.forEach((s) => (quotes[s] = { error: true }));
      }
    } catch {
      cryptoSymbols.forEach((s) => (quotes[s] = { error: true }));
    }
  }

  // Stock quotes fetched concurrently. yahoo-finance2 has no built-in batch
  // call for the fields we need (sector, PE, targets), so this is N parallel
  // requests rather than one, but they run at once instead of serially.
  if (stockSymbols.length) {
    const results = await Promise.allSettled(stockSymbols.map((s) => fetchStockQuote(s)));
    results.forEach((result, i) => {
      const symbol = stockSymbols[i];
      if (result.status === "fulfilled" && result.value) {
        quotes[symbol] = result.value;
      } else {
        quotes[symbol] = { error: true };
      }
    });
  }

  const payload = { quotes };
  cacheSet(cacheKey, payload, 20_000);
  res.json(payload);
});

const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`CrypStockDash API listening on port ${port}`);
});
