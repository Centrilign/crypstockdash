/* =========================================================================
   CrypStockDash frontend controller.
   Every number on this page comes from the /api/* endpoints in backend/app.py,
   which pull live data from Yahoo Finance via yfinance. Nothing here is
   randomly generated, seeded, or assumed. When live data isn't available for
   something, the UI says so ("N/A", "-", an inline error) instead of guessing.
   ========================================================================= */

// Point this at your deployed backend once it's live (Render, Railway, etc).
// Localhost is used automatically during local development.
const BASE_URL =
  window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
    ? "http://localhost:5000"
    : "https://your-backend-service.onrender.com";

// Directory of tickers for autocomplete only: names, not data. Any real
// ticker Yahoo Finance recognizes can still be looked up directly, whether
// or not it's in this list.
const SYMBOL_DIRECTORY = [
  { ticker: "AAPL", name: "Apple Inc." },
  { ticker: "MSFT", name: "Microsoft Corporation" },
  { ticker: "NVDA", name: "NVIDIA Corporation" },
  { ticker: "GOOGL", name: "Alphabet Inc." },
  { ticker: "META", name: "Meta Platforms, Inc." },
  { ticker: "AMZN", name: "Amazon.com, Inc." },
  { ticker: "TSLA", name: "Tesla, Inc." },
  { ticker: "AMD", name: "Advanced Micro Devices, Inc." },
  { ticker: "CRM", name: "Salesforce, Inc." },
  { ticker: "DIS", name: "The Walt Disney Company" },
  { ticker: "JPM", name: "JPMorgan Chase & Co." },
  { ticker: "V", name: "Visa Inc." },
  { ticker: "MA", name: "Mastercard Incorporated" },
  { ticker: "GS", name: "The Goldman Sachs Group, Inc." },
  { ticker: "PFE", name: "Pfizer Inc." },
  { ticker: "JNJ", name: "Johnson & Johnson" },
  { ticker: "UNH", name: "UnitedHealth Group Incorporated" },
  { ticker: "XOM", name: "Exxon Mobil Corporation" },
  { ticker: "CVX", name: "Chevron Corporation" },
  { ticker: "BTC-USD", name: "Bitcoin" },
  { ticker: "ETH-USD", name: "Ethereum" },
  { ticker: "SOL-USD", name: "Solana" },
  { ticker: "XRP-USD", name: "XRP" },
  { ticker: "DOGE-USD", name: "Dogecoin" },
];

const FEATURED_TAPE = ["AAPL", "MSFT", "NVDA", "TSLA", "BTC-USD", "ETH-USD", "GOOGL", "META", "AMZN", "JPM"];
const RECOMMENDATION_LABELS = {
  strong_buy: "STRONG BUY",
  buy: "BUY",
  hold: "HOLD",
  underperform: "UNDERPERFORM",
  sell: "SELL",
  strong_sell: "STRONG SELL",
};
const POLL_INTERVAL_MS = 20000;

// ---- state -----------------------------------------------------------
let activeChartInstance = null;
let currentSymbol = "";
let currentInterval = "6M";
let currentChartType = "candlestick";
let overlayRsiActive = false;
let localWatchlist = [];
let quoteCache = {};
let latestCandles = [];
let lastSyncedAt = null;
let livePollTimer = null;

// ---- boot --------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  try {
    if (localStorage.getItem("csd_theme") === "light") document.body.classList.add("light-mode");
  } catch (e) { /* no storage access, default theme stays */ }

  localWatchlist = loadWatchlist();
  document.getElementById("currentFooterYear").textContent = new Date().getFullYear();

  updateHeaderClock();
  setInterval(updateHeaderClock, 1000);

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".search-wrapper")) hideAutocomplete();
  });

  document.getElementById("tickerInput").addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      hideAutocomplete();
      loadStock();
    }
  });

  document.getElementById("filterSector").addEventListener("change", runScreener);
  document.getElementById("filterCap").addEventListener("change", runScreener);

  openSymbol("AAPL");
  startLivePolling();
});

function startLivePolling() {
  if (livePollTimer) clearInterval(livePollTimer);
  livePollTimer = setInterval(syncUniverse, POLL_INTERVAL_MS);
}

// ---- API layer -----------------------------------------------------------
async function fetchQuote(symbol) {
  const res = await fetch(`${BASE_URL}/api/quote/${encodeURIComponent(symbol)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function fetchHistory(symbol, interval) {
  const res = await fetch(`${BASE_URL}/api/history/${encodeURIComponent(symbol)}/${interval}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function fetchQuotesBatch(symbols) {
  if (!symbols.length) return {};
  const res = await fetch(`${BASE_URL}/api/quotes?symbols=${encodeURIComponent(symbols.join(","))}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data.quotes || {};
}

// ---- symbol loading --------------------------------------------------
async function openSymbol(rawSymbol) {
  const symbol = (rawSymbol || "").trim().toUpperCase();
  if (!symbol) return;

  document.getElementById("tickerInput").value = symbol;
  hideAutocomplete();
  setSearchError("");
  setHeroLoading(true);

  try {
    const [quote, history] = await Promise.all([
      fetchQuote(symbol),
      fetchHistory(symbol, currentInterval),
    ]);

    currentSymbol = symbol;
    latestCandles = history.candles || [];

    renderHero(quote);
    renderStats(quote);
    renderBio(quote);
    renderAnalyst(quote);
    renderChart(latestCandles, symbol);
    document.getElementById("stockHeroSection").style.display = "block";

    await syncUniverse();
  } catch (err) {
    console.error(err);
    setSearchError(err.message || `Couldn't load live data for "${symbol}".`);
  } finally {
    setHeroLoading(false);
  }
}

function loadStock() {
  const raw = document.getElementById("tickerInput").value;
  if (raw.trim()) openSymbol(raw);
}

function quickLoad(symbol) {
  openSymbol(symbol);
}

function selectSuggestion(ticker) {
  openSymbol(ticker);
}

// ---- search / autocomplete --------------------------------------------
function handleSearchInput(query) {
  const dropdown = document.getElementById("autocompleteDropdown");
  const parsed = query.trim().toUpperCase();

  if (!parsed) {
    hideAutocomplete();
    return;
  }

  const matches = SYMBOL_DIRECTORY.filter(
    (item) => item.ticker.includes(parsed) || item.name.toUpperCase().includes(parsed)
  ).slice(0, 6);

  if (!matches.length) {
    dropdown.innerHTML = `<div class="suggestion-row" style="cursor:default;color:var(--text-muted);">Not in the quick directory. Press Enter to look up "${escapeHtml(query.trim())}" live</div>`;
    dropdown.style.display = "block";
    return;
  }

  dropdown.innerHTML = matches
    .map(
      (item) => `
    <div class="suggestion-row" onclick="selectSuggestion('${item.ticker}')">
      <span class="comp-lbl">${escapeHtml(item.name)}</span>
      <span class="sym-badge">${item.ticker}</span>
    </div>`
    )
    .join("");
  dropdown.style.display = "block";
}

function hideAutocomplete() {
  document.getElementById("autocompleteDropdown").style.display = "none";
}

// ---- live universe sync (tape / trending / screener / watchlist / peers) --
async function syncUniverse() {
  const universe = new Set(SYMBOL_DIRECTORY.map((s) => s.ticker));
  localWatchlist.forEach((s) => universe.add(s));
  if (currentSymbol) universe.add(currentSymbol);

  try {
    quoteCache = await fetchQuotesBatch([...universe]);
    renderTickerTape();
    renderTrending();
    runScreener();
    renderWatchlist();
    renderComparison();

    const liveSelf = quoteCache[currentSymbol];
    if (liveSelf && !liveSelf.error) {
      renderHero(liveSelf);
      renderStats(liveSelf);
      renderAnalyst(liveSelf);
    }

    lastSyncedAt = Date.now();
  } catch (err) {
    console.error("Live sync failed:", err);
  }
}

// ---- render: hero / stats / bio / analyst -----------------------------
function renderHero(quote) {
  document.getElementById("heroCompanyName").textContent = quote.name || quote.symbol;
  document.getElementById("heroTickerSymbol").textContent = quote.symbol;
  document.getElementById("heroExchange").textContent =
    quote.exchange || (quote.quoteType === "CRYPTOCURRENCY" ? "CRYPTO" : "-");
  document.getElementById("heroSector").textContent = quote.sector || "-";
  document.getElementById("heroPrice").textContent = `$${formatPrice(quote.price)}`;

  const changeEl = document.getElementById("heroChange");
  if (typeof quote.change === "number" && typeof quote.changePercent === "number") {
    const positive = quote.change >= 0;
    const sign = positive ? "+" : "";
    changeEl.className = `price-change ${positive ? "up" : "down"}`;
    changeEl.textContent = `${sign}${quote.change.toFixed(2)} (${sign}${quote.changePercent.toFixed(2)}%)`;
  } else {
    changeEl.className = "price-change";
    changeEl.textContent = "Change unavailable";
  }
}

function renderStats(quote) {
  document.getElementById("stripMarketCap").textContent = formatLargeNumbers(quote.marketCap);
  document.getElementById("stripPERatio").textContent = quote.peRatio
    ? Number(quote.peRatio).toFixed(2)
    : "N/A";
  document.getElementById("stripVolume").textContent = formatLargeNumbers(quote.volume);

  if (quote.fiftyTwoWeekLow && quote.fiftyTwoWeekHigh) {
    document.getElementById("strip52Week").textContent =
      `$${formatPrice(quote.fiftyTwoWeekLow)} - $${formatPrice(quote.fiftyTwoWeekHigh)}`;
  } else {
    document.getElementById("strip52Week").textContent = "N/A";
  }
}

function renderBio(quote) {
  document.getElementById("profileBio").textContent =
    quote.description || `No public company profile is available for ${quote.name || quote.symbol} from the live data provider.`;
  document.getElementById("metaHQ").textContent = quote.hq || "N/A";
  document.getElementById("metaCEO").textContent = quote.ceo || "N/A";
  document.getElementById("metaEmployees").textContent = quote.employees
    ? Number(quote.employees).toLocaleString()
    : "N/A";
}

function renderAnalyst(quote) {
  const hasTargets = typeof quote.targetHigh === "number" && typeof quote.targetMedian === "number";
  document.getElementById("targetHigh").textContent = hasTargets ? `$${formatPrice(quote.targetHigh)}` : "N/A";
  document.getElementById("targetMedian").textContent = hasTargets ? `$${formatPrice(quote.targetMedian)}` : "N/A";

  const upsideEl = document.getElementById("targetUpside");
  if (hasTargets && quote.price) {
    const upside = ((quote.targetMedian - quote.price) / quote.price) * 100;
    const positive = upside >= 0;
    upsideEl.className = `text-right font-weight-bold ${positive ? "up" : "down"}`;
    upsideEl.textContent = `${positive ? "+" : ""}${upside.toFixed(2)}%`;
  } else {
    upsideEl.className = "text-right font-weight-bold";
    upsideEl.textContent = "N/A";
  }

  const ratingEl = document.getElementById("consensusRating");
  const key = (quote.recommendationKey || "").toLowerCase();
  if (RECOMMENDATION_LABELS[key]) {
    ratingEl.textContent = RECOMMENDATION_LABELS[key];
  } else if (quote.numberOfAnalystOpinions) {
    ratingEl.textContent = "MIXED";
  } else {
    ratingEl.textContent = "NO COVERAGE";
  }
}

// ---- render: ticker tape / trending / watchlist / screener / comparison --
function renderTickerTape() {
  const track = document.getElementById("tickerTape");
  const rowHtml = FEATURED_TAPE.map((ticker) => {
    const q = quoteCache[ticker];
    if (!q || q.error) {
      return `<div class="tape-item"><span>${ticker}</span><span class="text-muted">-</span></div>`;
    }
    const positive = q.changePercent >= 0;
    const sign = positive ? "+" : "";
    return `<div class="tape-item"><span>${ticker}</span><span class="${positive ? "up" : "down"}">$${formatPrice(q.price)} (${sign}${q.changePercent.toFixed(2)}%)</span></div>`;
  }).join("");
  // duplicated once so the CSS -50% scroll loop has no visible seam
  track.innerHTML = rowHtml + rowHtml;
}

function renderTrending() {
  const container = document.getElementById("trendingItemsContainer");
  const ranked = SYMBOL_DIRECTORY
    .map((item) => ({ item, q: quoteCache[item.ticker] }))
    .filter((x) => x.q && !x.q.error && typeof x.q.changePercent === "number")
    .sort((a, b) => Math.abs(b.q.changePercent) - Math.abs(a.q.changePercent))
    .slice(0, 3);

  if (!ranked.length) {
    container.innerHTML = `<div class="empty-state">Live movers unavailable right now.</div>`;
    return;
  }

  container.innerHTML = ranked
    .map(({ item, q }) => {
      const positive = q.changePercent >= 0;
      return `
      <div class="trending-item" onclick="openSymbol('${item.ticker}')">
        <div>
          <div class="symbol">${item.ticker}</div>
          <div class="name">${escapeHtml(q.name || item.name)}</div>
        </div>
        <div class="text-right">
          <div class="${positive ? "up" : "down"}">${positive ? "▲" : "▼"} ${Math.abs(q.changePercent).toFixed(2)}%</div>
        </div>
      </div>`;
    })
    .join("");
}

function renderWatchlist() {
  const container = document.getElementById("watchlistItems");
  if (!localWatchlist.length) {
    container.innerHTML = `<div class="empty-state">No stocks tracking currently.</div>`;
    return;
  }

  container.innerHTML = localWatchlist
    .map((symbol) => {
      const q = quoteCache[symbol];
      const hasData = q && !q.error;
      const priceLabel = hasData ? `$${formatPrice(q.price)}` : "-";
      const dirClass = hasData ? (q.changePercent >= 0 ? "up" : "down") : "";
      return `
      <div class="watchlist-card">
        <div class="watchlist-card-main" onclick="openSymbol('${symbol}')">
          <span class="font-weight-bold text-accent">${symbol}</span>
        </div>
        <div class="watchlist-card-actions">
          <span class="${dirClass}" style="font-size:12px;font-family:var(--font-mono);">${priceLabel}</span>
          <button class="btn-remove" title="Remove from watchlist" aria-label="Remove ${symbol} from watchlist" onclick="removeFromWatchlist('${symbol}', event)">&times;</button>
        </div>
      </div>`;
    })
    .join("");
}

function addToWatchlist() {
  if (!currentSymbol || localWatchlist.includes(currentSymbol)) return;
  localWatchlist.push(currentSymbol);
  persistWatchlist();
  renderWatchlist();
  syncUniverse();
}

function removeFromWatchlist(symbol, evt) {
  if (evt) evt.stopPropagation();
  localWatchlist = localWatchlist.filter((s) => s !== symbol);
  persistWatchlist();
  renderWatchlist();
}

function persistWatchlist() {
  try {
    localStorage.setItem("csd_watchlist", JSON.stringify(localWatchlist));
  } catch (e) { /* storage unavailable, watchlist stays in-memory for this session */ }
}

function loadWatchlist() {
  try {
    const raw = localStorage.getItem("csd_watchlist");
    if (raw) return JSON.parse(raw);
  } catch (e) { /* fall through to default */ }
  return ["AAPL", "MSFT", "NVDA"];
}

function runScreener() {
  const sector = document.getElementById("filterSector").value;
  const cap = document.getElementById("filterCap").value;
  const body = document.getElementById("screenerTableBody");

  const rows = SYMBOL_DIRECTORY
    .map((item) => ({ item, q: quoteCache[item.ticker] }))
    .filter(({ q }) => q && !q.error);

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="6" class="text-muted" style="text-align:center;padding:20px;">Loading live market data…</td></tr>`;
    return;
  }

  const filtered = rows.filter(({ q }) => {
    if (sector && (q.sector || "") !== sector) return false;
    if (cap === "mega" && !(q.marketCap >= 200e9)) return false;
    if (cap === "large" && !(q.marketCap >= 10e9 && q.marketCap < 200e9)) return false;
    return true;
  });

  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="6" class="text-muted" style="text-align:center;padding:20px;">No live matches for these filters.</td></tr>`;
    return;
  }

  body.innerHTML = filtered
    .map(({ item, q }) => {
      const positive = q.changePercent >= 0;
      return `
      <tr onclick="openSymbol('${item.ticker}')">
        <td class="text-accent font-weight-bold">${item.ticker}</td>
        <td>${escapeHtml(q.name || item.name)}</td>
        <td class="font-weight-bold">$${formatPrice(q.price)}</td>
        <td class="${positive ? "up" : "down"}">${positive ? "▲" : "▼"} ${Math.abs(q.changePercent).toFixed(2)}%</td>
        <td>${q.peRatio ? Number(q.peRatio).toFixed(1) : "N/A"}</td>
        <td>${formatLargeNumbers(q.marketCap)}</td>
      </tr>`;
    })
    .join("");
}

function renderComparison() {
  const target = quoteCache[currentSymbol];
  if (!target || target.error) return;

  const others = SYMBOL_DIRECTORY.map((s) => s.ticker).filter(
    (t) => t !== currentSymbol && quoteCache[t] && !quoteCache[t].error
  );
  const sameSector = others.filter((t) => quoteCache[t].sector === target.sector);
  const peers = [...sameSector, ...others.filter((t) => !sameSector.includes(t))].slice(0, 2);

  document.getElementById("compLabelTarget").textContent = currentSymbol;
  document.getElementById("compLabelPeer1").textContent = peers[0] || "-";
  document.getElementById("compLabelPeer2").textContent = peers[1] || "-";

  const columns = [
    { cap: "compCap0", pe: "compPE0", price: "compPrice0", symbol: currentSymbol },
    { cap: "compCap1", pe: "compPE1", price: "compPrice1", symbol: peers[0] },
    { cap: "compCap2", pe: "compPE2", price: "compPrice2", symbol: peers[1] },
  ];

  columns.forEach(({ cap, pe, price, symbol }) => {
    const q = symbol ? quoteCache[symbol] : null;
    document.getElementById(cap).textContent = q ? formatLargeNumbers(q.marketCap) : "N/A";
    document.getElementById(pe).textContent = q && q.peRatio ? Number(q.peRatio).toFixed(1) : "N/A";
    document.getElementById(price).textContent = q ? `$${formatPrice(q.price)}` : "N/A";
  });
}

// ---- chart ---------------------------------------------------------------
function timeUnitForInterval(interval) {
  switch (interval) {
    case "1D": return "hour";
    case "1W": return "day";
    case "1M": return "day";
    case "6M": return "week";
    case "1Y": return "month";
    case "5Y": return "year";
    default: return "day";
  }
}

// Standard 14-period Wilder RSI, computed from real closing prices.
function computeRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length <= period) return rsi;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function renderChart(candles, symbol) {
  const canvas = document.getElementById("mainIntelligenceChart");
  const ctx = canvas.getContext("2d");
  if (activeChartInstance) {
    activeChartInstance.destroy();
    activeChartInstance = null;
  }

  const emptyState = document.getElementById("chartEmptyState");
  if (!candles || !candles.length) {
    if (emptyState) emptyState.style.display = "flex";
    return;
  }
  if (emptyState) emptyState.style.display = "none";

  const styles = getComputedStyle(document.body);
  const accentUp = styles.getPropertyValue("--accent-color").trim() || "#00c076";
  const accentDown = styles.getPropertyValue("--accent-down").trim() || "#f23645";
  const textMuted = styles.getPropertyValue("--text-muted").trim() || "#848e9c";
  const textMain = styles.getPropertyValue("--text-main").trim() || "#eaecef";
  const gridColor = "rgba(255,255,255,0.04)";

  const closes = candles.map((c) => c.c);
  const lows = candles.map((c) => c.l);
  const highs = candles.map((c) => c.h);
  const minPrice = Math.min(...lows);
  const maxPrice = Math.max(...highs);
  const padding = (maxPrice - minPrice) * 0.08 || maxPrice * 0.02 || 1;

  const datasets = [];

  if (currentChartType === "candlestick") {
    datasets.push({
      label: symbol,
      type: "candlestick",
      yAxisID: "yPrice",
      data: candles.map((c) => ({ x: c.t, o: c.o, h: c.h, l: c.l, c: c.c })),
      color: { up: accentUp, down: accentDown, unchanged: textMuted },
      borderColor: { up: accentUp, down: accentDown, unchanged: textMuted },
    });
  } else {
    datasets.push({
      label: `${symbol} Close`,
      type: "line",
      yAxisID: "yPrice",
      data: candles.map((c) => ({ x: c.t, y: c.c })),
      borderColor: accentUp,
      backgroundColor: "rgba(0, 192, 118, 0.06)",
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.15,
      fill: true,
    });
  }

  if (overlayRsiActive) {
    const rsiValues = computeRSI(closes, 14);
    const rsiPoints = candles
      .map((c, i) => (rsiValues[i] === null ? null : { x: c.t, y: rsiValues[i] }))
      .filter(Boolean);

    if (rsiPoints.length) {
      datasets.push({
        label: "RSI (14)",
        type: "line",
        yAxisID: "yRsi",
        data: rsiPoints,
        borderColor: "#f59e0b",
        borderWidth: 1.5,
        pointRadius: 0,
        fill: false,
      });
    }
  }

  activeChartInstance = new Chart(ctx, {
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          type: "time",
          time: { unit: timeUnitForInterval(currentInterval) },
          ticks: { color: textMuted, maxTicksLimit: 10 },
          grid: { color: gridColor },
        },
        yPrice: {
          position: "left",
          min: minPrice - padding,
          max: maxPrice + padding,
          ticks: { color: textMuted },
          grid: { color: gridColor },
        },
        yRsi: {
          display: overlayRsiActive,
          position: "right",
          min: 0,
          max: 100,
          ticks: { color: "#f59e0b", stepSize: 20 },
          grid: { display: false },
        },
      },
      plugins: {
        legend: { labels: { color: textMain } },
        zoom: {
          zoom: { wheel: { enabled: true, speed: 0.1 }, pinch: { enabled: true }, mode: "xy" },
          pan: { enabled: true, mode: "xy", threshold: 10 },
        },
      },
    },
  });
}

async function reloadChartOnly() {
  if (!currentSymbol) return;
  try {
    const history = await fetchHistory(currentSymbol, currentInterval);
    latestCandles = history.candles || [];
  } catch (err) {
    console.error(err);
    latestCandles = [];
  }
  renderChart(latestCandles, currentSymbol);
}

function changeInterval(horizon) {
  currentInterval = horizon;
  document.querySelectorAll("[data-interval]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-interval") === horizon);
  });
  reloadChartOnly();
}

function changeChartType(type) {
  currentChartType = type;
  document.getElementById("typeLine").classList.toggle("active", type === "line");
  document.getElementById("typeCandle").classList.toggle("active", type === "candlestick");
  renderChart(latestCandles, currentSymbol);
}

function toggleIndicator(indicator) {
  if (indicator === "RSI") {
    overlayRsiActive = !overlayRsiActive;
    const btn = document.querySelector(".btn-indicator");
    if (btn) btn.classList.toggle("active", overlayRsiActive);
  }
  renderChart(latestCandles, currentSymbol);
}

// ---- market clock / status pill -----------------------------------------
function getNyTime() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
  const parts = {};
  fmt.formatToParts(new Date()).forEach((p) => (parts[p.type] = p.value));
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday);
  const minutesOfDay = parseInt(parts.hour, 10) * 60 + parseInt(parts.minute, 10);
  return { weekdayIndex, minutesOfDay, tz: parts.timeZoneName, hour: parts.hour, minute: parts.minute, second: parts.second };
}

// Regular NYSE session hours only (no holiday calendar, a genuine gap and
// not an assumption dressed up as fact).
function getMarketSession() {
  const { weekdayIndex, minutesOfDay } = getNyTime();
  const isWeekday = weekdayIndex >= 1 && weekdayIndex <= 5;
  if (!isWeekday) return "closed";

  const PRE_OPEN = 4 * 60;
  const OPEN = 9 * 60 + 30;
  const CLOSE = 16 * 60;
  const AFTER_CLOSE = 20 * 60;

  if (minutesOfDay >= OPEN && minutesOfDay < CLOSE) return "open";
  if (minutesOfDay >= PRE_OPEN && minutesOfDay < OPEN) return "pre-market";
  if (minutesOfDay >= CLOSE && minutesOfDay < AFTER_CLOSE) return "after-hours";
  return "closed";
}

function updateHeaderClock() {
  const { hour, minute, second, tz } = getNyTime();
  const pill = document.getElementById("marketStatusIndicator");
  const label = document.getElementById("liveTimestampLabel");
  if (!pill || !label) return;

  const isCrypto = currentSymbol && quoteCache[currentSymbol] && quoteCache[currentSymbol].quoteType === "CRYPTOCURRENCY";
  let sessionText;
  let stateClass;

  if (isCrypto) {
    sessionText = "CRYPTO · 24/7";
    stateClass = "open";
  } else {
    const session = getMarketSession();
    if (session === "open") { sessionText = "NYSE OPEN"; stateClass = "open"; }
    else if (session === "pre-market") { sessionText = "PRE-MARKET"; stateClass = "pending"; }
    else if (session === "after-hours") { sessionText = "AFTER HOURS"; stateClass = "pending"; }
    else { sessionText = "MARKET CLOSED"; stateClass = "closed"; }
  }

  pill.className = `market-status-pill ${stateClass}`;

  const syncSuffix = lastSyncedAt
    ? ` · synced ${Math.max(0, Math.round((Date.now() - lastSyncedAt) / 1000))}s ago`
    : " · syncing…";
  label.textContent = `${sessionText} (${tz}) | ${hour}:${minute}:${second}${syncSuffix}`;
}

// ---- misc helpers ---------------------------------------------------------
function setSearchError(message) {
  const el = document.getElementById("searchStatusMessage");
  if (!el) return;
  el.textContent = message || "";
  el.style.display = message ? "block" : "none";
}

function setHeroLoading(isLoading) {
  const el = document.getElementById("heroLoadingOverlay");
  if (el) el.style.display = isLoading ? "flex" : "none";
}

function formatPrice(value) {
  if (value === null || value === undefined || isNaN(value)) return "0.00";
  const decimals = Math.abs(value) < 1 ? 4 : 2;
  return Number(value).toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatLargeNumbers(val) {
  if (val === null || val === undefined || isNaN(val)) return "N/A";
  const num = Number(val);
  if (num >= 1e12) return (num / 1e12).toFixed(2) + "T";
  if (num >= 1e9) return (num / 1e9).toFixed(2) + "B";
  if (num >= 1e6) return (num / 1e6).toFixed(2) + "M";
  return num.toLocaleString();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function toggleTheme() {
  document.body.classList.toggle("light-mode");
  try {
    localStorage.setItem("csd_theme", document.body.classList.contains("light-mode") ? "light" : "dark");
  } catch (e) { /* no storage access, theme choice just won't persist */ }
  if (latestCandles.length) renderChart(latestCandles, currentSymbol);
}
