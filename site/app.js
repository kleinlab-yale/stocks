const STORAGE_KEY = "tickerquest:holdings:v2";
const LEGACY_STORAGE_KEY = "tickerquest:holdings:v1";
const Portfolio = window.TickerQuestPortfolio;
let lotSequence = 0;

const state = { data: null, holdings: [], period: "day", openLots: new Set() };

const elements = {
  form: document.querySelector("#ticker-form"),
  ticker: document.querySelector("#ticker-input"),
  shares: document.querySelector("#shares-input"),
  price: document.querySelector("#price-input"),
  formNote: document.querySelector("#form-note"),
  grid: document.querySelector("#stock-grid"),
  sessionChip: document.querySelector("#session-chip"),
  sessionLabel: document.querySelector("#session-label"),
  freshness: document.querySelector("#freshness-badge"),
  score: document.querySelector("#portfolio-score"),
  scoreOrbit: document.querySelector("#score-orbit"),
  scoreRank: document.querySelector("#score-rank"),
  scoreNote: document.querySelector("#score-note"),
  portfolioSparkline: document.querySelector("#portfolio-sparkline"),
  xpFill: document.querySelector("#xp-fill"),
  xpLabel: document.querySelector("#xp-label"),
  level: document.querySelector("#level-label"),
  marketValue: document.querySelector("#market-value"),
  positionCount: document.querySelector("#position-count"),
  totalReturn: document.querySelector("#total-return"),
  totalReturnPercent: document.querySelector("#total-return-percent"),
  costBasis: document.querySelector("#cost-basis"),
  costCoverage: document.querySelector("#cost-coverage"),
  dayPnl: document.querySelector("#day-pnl"),
  dayPnlPercent: document.querySelector("#day-pnl-percent"),
  daySignal: document.querySelector("#day-signal"),
  weekPnl: document.querySelector("#week-pnl"),
  weekPnlPercent: document.querySelector("#week-pnl-percent"),
  weekSignal: document.querySelector("#week-signal"),
  costCoverageFill: document.querySelector("#cost-coverage-fill"),
  overnightStatus: document.querySelector("#overnight-status"),
  overnightScore: document.querySelector("#overnight-score"),
  overnightLabel: document.querySelector("#overnight-label"),
  overnightCopy: document.querySelector("#overnight-copy"),
  overnightPortfolio: document.querySelector("#overnight-portfolio"),
  overnightPortfolioMove: document.querySelector("#overnight-portfolio-move"),
  overnightAsia: document.querySelector("#overnight-asia"),
  overnightAsiaMove: document.querySelector("#overnight-asia-move"),
  overnightNews: document.querySelector("#overnight-news"),
  overnightNewsCount: document.querySelector("#overnight-news-count"),
  overnightStories: document.querySelector("#overnight-stories"),
  updatedTime: document.querySelector("#updated-time"),
  source: document.querySelector("#source-label"),
  count: document.querySelector("#holding-count"),
  questCount: document.querySelector("#quest-count"),
  questCopy: document.querySelector("#quest-copy"),
  questFill: document.querySelector("#quest-fill"),
  badges: document.querySelector("#badges"),
};

const finite = Portfolio.finite;

function newLotId() {
  lotSequence += 1;
  return `lot-${Date.now().toString(36)}-${lotSequence.toString(36)}`;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function safeURL(value) {
  try {
    const url = new URL(String(value));
    return ["http:", "https:"].includes(url.protocol) ? url.href : "#";
  } catch (_) {
    return "#";
  }
}

function money(value, currency = "USD", signed = false) {
  if (!Number.isFinite(value)) return "—";
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: Math.abs(value) < 100 ? 2 : 0,
  }).format(Math.abs(value));
  if (!signed) return formatted;
  return `${value >= 0 ? "+" : "−"}${formatted}`;
}

function percent(value) {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}%`;
}

function formatShares(value) {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 }).format(value);
}

function change(price, reference) {
  if (!Number.isFinite(price) || !Number.isFinite(reference) || reference === 0) return { amount: null, percent: null };
  return { amount: price - reference, percent: ((price - reference) / reference) * 100 };
}

function momentumScore(day, week) {
  if (!Number.isFinite(day) || !Number.isFinite(week)) return null;
  return Math.round(Math.max(0, Math.min(100, 50 + 25 * Math.tanh(day / 3) + 25 * Math.tanh(week / 7))));
}

function scoreTier(score) {
  if (score >= 85) return ["Legendary run", "Both horizons are pulling hard in the same direction."];
  if (score >= 70) return ["Powering up", "Your lineup has strong positive momentum."];
  if (score >= 55) return ["Climbing", "Momentum is positive, with room to build."];
  if (score >= 45) return ["Holding steady", "Your daily and weekly signals are balanced."];
  if (score >= 30) return ["Rebuild mode", "Momentum is soft; the next session can reset the board."];
  return ["Reset zone", "Short- and medium-term momentum are under pressure."];
}

function overnightTier(score) {
  if (score >= 70) return "Risk-on setup";
  if (score >= 58) return "Constructive setup";
  if (score >= 43) return "Mixed setup";
  if (score >= 30) return "Defensive setup";
  return "Risk-off setup";
}

function classFor(value) {
  return value > 0 ? "positive" : value < 0 ? "negative" : "";
}

function loadHoldings(symbols) {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!Array.isArray(saved)) saved = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY));
  } catch (_) {
    saved = null;
  }
  return Portfolio.normalizeHoldings(saved, symbols, newLotId);
}

function persistHoldings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.holdings));
}

function setSession(session) {
  const label = session?.label || "Market status unknown";
  elements.sessionLabel.textContent = label;
  elements.sessionChip.classList.toggle("closed", label.includes("closed"));
  elements.sessionChip.classList.toggle("extended", label.includes("Pre") || label.includes("After"));
}

function renderFreshness() {
  const generated = new Date(state.data.generatedAt);
  const ageMinutes = Math.max(0, Math.floor((Date.now() - generated.getTime()) / 60000));
  const mode = state.data.mode;
  const stale = ageMinutes > 45;
  const badge = mode === "demo" ? "Demo data" : mode === "degraded" ? "Partial feed" : stale ? "Delayed" : "Fresh";
  elements.freshness.textContent = badge;
  elements.freshness.className = `data-badge ${mode === "live" && !stale ? "live" : mode === "demo" ? "" : "degraded"}`;
  elements.updatedTime.textContent = Number.isNaN(generated.getTime()) ? "Time unavailable" : generated.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  elements.source.textContent = mode === "demo" ? "Preview snapshot" : `${ageMinutes} min old · ${state.data.source}`;
}

function drawSparkline(canvas, values, positive) {
  const points = values.map(Number).filter(Number.isFinite);
  if (points.length < 2) return;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const x = (index) => 2 + (index / (points.length - 1)) * (width - 4);
  const y = (value) => height - 4 - ((value - min) / span) * (height - 8);
  const isPortfolio = canvas.id === "portfolio-sparkline";
  const color = positive ? (isPortfolio ? "#b8ff65" : "#5bb82b") : (isPortfolio ? "#ff8a70" : "#df654e");
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, positive ? (isPortfolio ? "rgba(184,255,101,.3)" : "rgba(117,214,59,.22)") : "rgba(255,138,112,.2)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.beginPath();
  ctx.moveTo(x(0), y(points[0]));
  points.slice(1).forEach((value, index) => ctx.lineTo(x(index + 1), y(value)));
  ctx.lineTo(x(points.length - 1), height);
  ctx.lineTo(x(0), height);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x(0), y(points[0]));
  points.slice(1).forEach((value, index) => ctx.lineTo(x(index + 1), y(value)));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke();
}

function aggregatePortfolioTrend(rows) {
  const seriesRows = rows.flatMap(({ holding, stock }) => {
    const price = finite(stock?.price);
    const shares = Portfolio.totalShares(holding);
    if (!price || !shares) return [];
    const supplied = Array.isArray(stock.sparkline) ? stock.sparkline.map(Number).filter(Number.isFinite) : [];
    const values = supplied.length >= 2 ? supplied : [finite(stock.previousClose) || price, price];
    values[values.length - 1] = price;
    return [{ shares, values }];
  });
  if (!seriesRows.length) return [];
  const length = Math.max(...seriesRows.map((row) => row.values.length));
  return Array.from({ length }, (_, index) => seriesRows.reduce((total, row) => {
    const sourceIndex = Math.max(0, index - (length - row.values.length));
    return total + row.values[sourceIndex] * row.shares;
  }, 0));
}

function extendedHoursSignal(rows) {
  const session = state.data.session?.label || "";
  let basis = 0;
  let movement = 0;
  let observations = 0;
  rows.forEach(({ holding, stock }) => {
    if (!stock) return;
    const premarket = finite(stock.premarketPrice);
    const afterHours = finite(stock.afterHoursPrice);
    const usePremarket = session === "Pre-market" || (!afterHours && premarket);
    const extendedPrice = usePremarket ? premarket : afterHours || premarket;
    const reference = usePremarket ? finite(stock.previousClose) : finite(stock.regularPrice) || finite(stock.previousClose);
    const shares = Portfolio.totalShares(holding);
    if (!extendedPrice || !reference || !shares) return;
    basis += reference * shares;
    movement += (extendedPrice - reference) * shares;
    observations += 1;
  });
  const changePercent = basis > 0 ? (movement / basis) * 100 : null;
  const score = changePercent === null ? 50 : Math.round(Math.max(0, Math.min(100, 50 + 30 * Math.tanh(changePercent / 2))));
  return { score, changePercent, observations };
}

function renderOvernight(rows) {
  const overnight = state.data.overnight || {};
  const portfolio = extendedHoursSignal(rows);
  const asia = overnight.asia || {};
  const news = overnight.news || {};
  const asiaScore = Number.isFinite(finite(asia.score)) ? finite(asia.score) : 50;
  const newsScore = Number.isFinite(finite(news.score)) ? finite(news.score) : 50;
  const composite = Math.round(0.5 * portfolio.score + 0.25 * asiaScore + 0.25 * newsScore);
  const stories = Array.isArray(news.stories) ? news.stories.slice(0, 2) : [];
  const articleCount = Number.isFinite(finite(news.articleCount)) ? finite(news.articleCount) : 0;
  const asiaMove = finite(asia.averageChangePercent);
  const available = portfolio.observations > 0 || overnight.status === "ok" || overnight.status === "partial";

  elements.overnightScore.textContent = available ? composite : "—";
  elements.overnightScore.className = classFor(composite - 50);
  elements.overnightLabel.textContent = available ? overnightTier(composite) : "Overnight inputs unavailable";
  elements.overnightCopy.textContent = available
    ? `Holdings ${percent(portfolio.changePercent)} extended · Asia ${percent(asiaMove)} · ${articleCount} recent stories. Not a forecast.`
    : "The next scheduled snapshot will retry the overnight sources.";
  elements.overnightPortfolio.textContent = portfolio.observations ? portfolio.score : "—";
  elements.overnightPortfolio.className = classFor(portfolio.score - 50);
  elements.overnightPortfolioMove.textContent = portfolio.changePercent === null ? "No extended quote" : `${percent(portfolio.changePercent)} extended`;
  elements.overnightAsia.textContent = asia.status === "unavailable" || !overnight.asia ? "—" : asiaScore;
  elements.overnightAsia.className = classFor(asiaScore - 50);
  elements.overnightAsiaMove.textContent = asiaMove === null ? "Asia unavailable" : `${percent(asiaMove)} weighted`;
  elements.overnightNews.textContent = news.status === "unavailable" || !overnight.news ? "—" : newsScore;
  elements.overnightNews.className = classFor(newsScore - 50);
  elements.overnightNewsCount.textContent = articleCount ? `${articleCount} stories / 18h` : "News scan unavailable";
  elements.overnightStatus.textContent = overnight.status === "ok" ? "Fresh" : available ? "Partial" : "Waiting";
  elements.overnightStatus.className = `data-badge ${overnight.status === "ok" ? "live" : "degraded"}`;
  elements.overnightStories.innerHTML = stories.length
    ? stories.map((story) => `<li><span class="story-tag">${escapeHTML(story.category || "Driver")}</span><a href="${escapeHTML(safeURL(story.url))}" target="_blank" rel="noopener noreferrer">${escapeHTML(story.title || "Open story")} · ${escapeHTML(story.source || "Source")}</a></li>`).join("")
    : "<li>News scan unavailable; market components still contribute to the score.</li>";
}

function lotsPanel(holding, currency = "USD") {
  const symbol = escapeHTML(holding.symbol);
  const summary = Portfolio.summarizeHolding(holding, null);
  const lotCount = holding.lots.length;
  const needsPrice = summary.pricedShares < summary.shares;
  const open = state.openLots.has(holding.symbol) ? " open" : "";
  const rows = holding.lots.map((lot, index) => {
    const lotCost = finite(lot.price) ? lot.shares * lot.price : null;
    return `
      <div class="lot-row">
        <span class="lot-number">${String(index + 1).padStart(2, "0")}</span>
        <label><span>Shares</span><input type="number" min="0.001" step="any" value="${lot.shares}" inputmode="decimal" aria-label="Shares in ${symbol} purchase ${index + 1}" data-lot-shares="${escapeHTML(lot.id)}" /></label>
        <label><span>Price paid</span><div class="money-input compact"><span aria-hidden="true">$</span><input type="number" min="0.001" step="any" value="${lot.price ?? ""}" placeholder="0.00" inputmode="decimal" aria-label="Price paid for ${symbol} purchase ${index + 1}" data-lot-price="${escapeHTML(lot.id)}" /></div></label>
        <div class="lot-cost"><span>Cost</span><strong>${money(lotCost, currency)}</strong></div>
        <button class="lot-remove" type="button" aria-label="Remove ${symbol} purchase ${index + 1}" data-remove-lot="${escapeHTML(lot.id)}">Remove</button>
      </div>`;
  }).join("");

  return `
    <details class="lots-panel" data-lots-panel="${symbol}"${open}>
      <summary><span>Purchase history</span><span>${lotCount} ${lotCount === 1 ? "lot" : "lots"} · ${needsPrice ? "Add price" : `${money(summary.averageCost, currency)} avg`}</span></summary>
      <div class="lot-list">${rows}</div>
      <form class="add-lot-form" data-add-lot="${symbol}">
        <strong>Add another purchase</strong>
        <label><span>Shares</span><input name="shares" type="number" min="0.001" step="any" value="1" inputmode="decimal" aria-label="Shares in new ${symbol} purchase" required /></label>
        <label><span>Price paid</span><div class="money-input compact"><span aria-hidden="true">$</span><input name="price" type="number" min="0.001" step="any" placeholder="0.00" inputmode="decimal" aria-label="Price paid for new ${symbol} purchase" required /></div></label>
        <button type="submit">Add lot</button>
      </form>
      <button class="remove-stock" type="button" data-remove-stock="${symbol}">Remove ${symbol} from portfolio</button>
    </details>`;
}

function renderPendingStock(holding) {
  const summary = Portfolio.summarizeHolding(holding, null);
  const card = document.createElement("article");
  card.className = "stock-card pending-card";
  card.dataset.symbol = holding.symbol;
  card.innerHTML = `
    <div class="stock-top">
      <div class="stock-symbol"><span class="ticker-avatar">${escapeHTML(holding.symbol.slice(0, 3))}</span><div><h3>${escapeHTML(holding.symbol)}</h3><p>Waiting for market data</p></div></div>
      <span class="score-pill">— pts</span>
    </div>
    <div class="pending-copy"><strong>${formatShares(summary.shares)} shares saved</strong><p>Add this ticker to the repository watchlist to include it in scheduled quotes.</p><a href="https://github.com/kleinlab-yale/stocks/edit/main/config/watchlist.json">Sync on GitHub ↗</a></div>
    ${lotsPanel(holding)}`;
  return card;
}

function renderStock(holding, stock, totalValue) {
  if (!stock || !Number.isFinite(finite(stock.price))) return renderPendingStock(holding);

  const price = finite(stock.price);
  const performance = Portfolio.summarizeHolding(holding, price);
  const day = change(price, finite(stock.previousClose));
  const week = change(price, finite(stock.weekAgoClose));
  const score = momentumScore(day.percent, week.percent);
  const ranking = state.period === "day" ? day.percent : week.percent;
  const scoreClass = score >= 65 ? "high" : score < 40 ? "low" : "";
  const initials = stock.symbol.slice(0, 3);
  const portfolioWeight = totalValue > 0 ? (performance.marketValue / totalValue) * 100 : 0;
  const extended = [];
  const pre = finite(stock.premarketPrice);
  const after = finite(stock.afterHoursPrice);
  const preMove = change(pre, finite(stock.previousClose)).percent;
  const afterMove = change(after, finite(stock.regularPrice)).percent;
  if (pre) extended.push(`<span class="extended-chip">Pre ${money(pre, stock.currency)} · ${percent(preMove)}</span>`);
  if (after) extended.push(`<span class="extended-chip">After ${money(after, stock.currency)} · ${percent(afterMove)}</span>`);
  if (!extended.length) extended.push('<span class="extended-chip">Regular session</span>');
  const returnLabel = performance.returnPercent === null ? "Add purchase price" : `${money(performance.unrealized, stock.currency, true)} unrealized`;

  const card = document.createElement("article");
  card.className = "stock-card";
  card.dataset.symbol = holding.symbol;
  card.innerHTML = `
    <div class="stock-top">
      <div class="stock-symbol"><span class="ticker-avatar">${escapeHTML(initials)}</span><div><h3>${escapeHTML(stock.symbol)}</h3><p>${escapeHTML(stock.name || stock.symbol)}</p></div></div>
      <span class="score-pill ${scoreClass}" title="Momentum score">${score ?? "—"} pts</span>
    </div>
    <div class="price-row">
      <div class="price-main"><span>Current price</span><strong>${money(price, stock.currency)}</strong></div>
      <canvas class="sparkline" aria-label="Seven-session price trend" role="img"></canvas>
    </div>
    <div class="stock-metrics">
      <div class="stock-metric"><span class="metric-label">Today</span><strong class="${classFor(day.percent)}">${percent(day.percent)}</strong><small>${money(day.amount, stock.currency, true)} / share</small></div>
      <div class="stock-metric"><span class="metric-label">Week</span><strong class="${classFor(week.percent)}">${percent(week.percent)}</strong><small>${money(week.amount, stock.currency, true)} / share</small></div>
      <div class="stock-metric return-metric"><span class="metric-label">Total return</span><strong class="${classFor(performance.returnPercent)}">${percent(performance.returnPercent)}</strong><small>${returnLabel}</small></div>
    </div>
    <div class="extended-row">${extended.join("")}</div>
    <div class="position-grid">
      <div><span>Position</span><strong>${money(performance.marketValue, stock.currency)}</strong></div>
      <div><span>Shares</span><strong>${formatShares(performance.shares)}</strong></div>
      <div><span>Weight</span><strong>${portfolioWeight.toFixed(1)}%</strong></div>
      <div><span>Avg cost</span><strong>${money(performance.averageCost, stock.currency)}</strong></div>
      <div><span>Cost basis</span><strong>${performance.costBasis ? money(performance.costBasis, stock.currency) : "—"}</strong></div>
      <div class="weight-track" aria-hidden="true"><span style="width:${Math.min(portfolioWeight, 100)}%"></span></div>
    </div>
    ${lotsPanel(holding, stock.currency)}`;
  requestAnimationFrame(() => drawSparkline(card.querySelector("canvas"), stock.sparkline || [], (ranking ?? 0) >= 0));
  return card;
}

function renderSummary(rows) {
  const valid = rows.filter((row) => Number.isFinite(finite(row.stock?.price)));
  let marketValue = 0;
  let totalCost = 0;
  let pricedMarketValue = 0;
  let allShares = 0;
  let coveredShares = 0;
  let dayPnl = 0;
  let weekPnl = 0;
  let dayBasis = 0;
  let weekBasis = 0;
  let weightedScore = 0;
  let scoreWeight = 0;
  let weeklyWinners = 0;
  let dailyWinners = 0;

  valid.forEach(({ holding, stock }) => {
    const price = finite(stock.price);
    const performance = Portfolio.summarizeHolding(holding, price);
    const day = change(price, finite(stock.previousClose));
    const week = change(price, finite(stock.weekAgoClose));
    const score = momentumScore(day.percent, week.percent);
    marketValue += performance.marketValue;
    totalCost += performance.costBasis;
    pricedMarketValue += price * performance.pricedShares;
    allShares += performance.shares;
    coveredShares += performance.pricedShares;
    dayPnl += (day.amount || 0) * performance.shares;
    weekPnl += (week.amount || 0) * performance.shares;
    if (finite(stock.previousClose) > 0) dayBasis += finite(stock.previousClose) * performance.shares;
    if (finite(stock.weekAgoClose) > 0) weekBasis += finite(stock.weekAgoClose) * performance.shares;
    if ((week.percent || 0) > 0) weeklyWinners += 1;
    if ((day.percent || 0) > 0) dailyWinners += 1;
    if (score !== null) { weightedScore += score * performance.marketValue; scoreWeight += performance.marketValue; }
  });

  const totalReturn = coveredShares ? pricedMarketValue - totalCost : null;
  const totalReturnPercent = totalReturn === null || totalCost <= 0 ? null : (totalReturn / totalCost) * 100;
  const dayPnlPercent = dayBasis > 0 ? (dayPnl / dayBasis) * 100 : null;
  const weekPnlPercent = weekBasis > 0 ? (weekPnl / weekBasis) * 100 : null;
  const score = scoreWeight ? Math.round(weightedScore / scoreWeight) : 0;
  const [rank, note] = scoreTier(score);
  const level = Math.max(1, Math.floor(score / 10) + 1);
  const xp = score * 10;
  const questPercent = valid.length ? Math.round((weeklyWinners / valid.length) * 100) : 0;

  elements.score.textContent = valid.length ? score : "—";
  elements.scoreOrbit.style.setProperty("--score", score);
  elements.scoreRank.textContent = valid.length ? rank : "No positions yet";
  elements.scoreNote.textContent = valid.length ? note : "Add a purchase at the bottom to begin.";
  elements.xpFill.style.width = `${score}%`;
  elements.xpLabel.textContent = `${xp} XP`;
  elements.level.textContent = `Level ${level}`;
  elements.marketValue.textContent = money(marketValue);
  elements.positionCount.textContent = `${valid.length} ${valid.length === 1 ? "position" : "positions"} · ${formatShares(allShares)} shares`;
  elements.totalReturn.textContent = money(totalReturn, "USD", true);
  elements.totalReturn.className = classFor(totalReturn);
  elements.totalReturnPercent.textContent = totalReturnPercent === null ? "Add purchase prices" : `${percent(totalReturnPercent)} on priced shares`;
  elements.totalReturnPercent.className = classFor(totalReturnPercent);
  elements.costBasis.textContent = totalCost > 0 ? money(totalCost) : "—";
  elements.costCoverage.textContent = !coveredShares ? "No purchase prices yet" : Math.abs(coveredShares - allShares) < 1e-9 ? `All ${formatShares(allShares)} shares priced` : `${formatShares(coveredShares)} of ${formatShares(allShares)} shares priced`;
  elements.dayPnl.textContent = money(dayPnl, "USD", true);
  elements.weekPnl.textContent = money(weekPnl, "USD", true);
  elements.dayPnl.className = classFor(dayPnl);
  elements.weekPnl.className = classFor(weekPnl);
  elements.dayPnlPercent.textContent = dayPnlPercent === null ? "Weighted P&L" : `${percent(dayPnlPercent)} weighted`;
  elements.weekPnlPercent.textContent = weekPnlPercent === null ? "Weighted P&L" : `${percent(weekPnlPercent)} weighted`;
  elements.dayPnlPercent.className = classFor(dayPnlPercent);
  elements.weekPnlPercent.className = classFor(weekPnlPercent);
  elements.daySignal.style.width = `${dayPnlPercent === null ? 0 : Math.min(100, Math.max(Math.abs(dayPnlPercent) * 18, 7))}%`;
  elements.weekSignal.style.width = `${weekPnlPercent === null ? 0 : Math.min(100, Math.max(Math.abs(weekPnlPercent) * 12, 7))}%`;
  elements.daySignal.className = classFor(dayPnlPercent);
  elements.weekSignal.className = classFor(weekPnlPercent);
  elements.costCoverageFill.style.width = `${allShares > 0 ? Math.min(100, (coveredShares / allShares) * 100) : 0}%`;
  const trend = aggregatePortfolioTrend(rows);
  requestAnimationFrame(() => drawSparkline(elements.portfolioSparkline, trend, trend.length < 2 || trend.at(-1) >= trend[0]));
  renderOvernight(rows);
  elements.questCount.textContent = `${weeklyWinners} / ${valid.length}`;
  elements.questFill.style.width = `${questPercent}%`;
  elements.questCopy.textContent = valid.length ? `${weeklyWinners} of ${valid.length} positions are above their weekly line.` : "Positive weekly momentum earns the Weekly Winner badge.";
  const badges = [
    ["Weekly winner", weeklyWinners === valid.length && valid.length > 0],
    ["Green screen", dailyWinners === valid.length && valid.length > 0],
    ["Power 70", score >= 70],
  ];
  elements.badges.innerHTML = badges.map(([label, unlocked]) => `<span class="badge ${unlocked ? "unlocked" : ""}">${unlocked ? "✓ " : "○ "}${label}</span>`).join("");
}

function render() {
  const lookup = new Map(state.data.symbols.map((stock) => [stock.symbol, stock]));
  const rows = state.holdings.map((holding) => ({ holding, stock: lookup.get(holding.symbol) }));
  const totalValue = rows.reduce((sum, row) => sum + (finite(row.stock?.price) || 0) * Portfolio.totalShares(row.holding), 0);
  const sorted = [...rows].sort((a, b) => {
    const refA = state.period === "day" ? a.stock?.previousClose : a.stock?.weekAgoClose;
    const refB = state.period === "day" ? b.stock?.previousClose : b.stock?.weekAgoClose;
    return (change(finite(b.stock?.price), finite(refB)).percent ?? -999) - (change(finite(a.stock?.price), finite(refA)).percent ?? -999);
  });

  elements.grid.replaceChildren();
  if (!sorted.length) {
    elements.grid.innerHTML = '<div class="empty-state"><strong>Your portfolio is empty.</strong><a href="#add-heading">Record a purchase at the bottom</a> to begin.</div>';
  } else {
    sorted.forEach(({ holding, stock }) => elements.grid.appendChild(renderStock(holding, stock, totalValue)));
  }
  const count = state.holdings.length;
  elements.count.textContent = `${count} ${count === 1 ? "holding" : "holdings"}`;
  renderSummary(rows);
}

function addHolding(event) {
  event.preventDefault();
  const symbol = elements.ticker.value.trim().toUpperCase();
  const shares = finite(elements.shares.value);
  const price = finite(elements.price.value);
  elements.formNote.classList.remove("error");
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    elements.formNote.textContent = "Use a valid ticker such as AAPL or BRK.B.";
    elements.formNote.classList.add("error");
    return;
  }
  if (!shares || shares <= 0 || !price || price <= 0) {
    elements.formNote.textContent = "Enter both a share count and purchase price greater than zero.";
    elements.formNote.classList.add("error");
    return;
  }
  const lot = { id: newLotId(), shares, price };
  const existing = state.holdings.find((item) => item.symbol === symbol);
  if (existing) existing.lots.push(lot);
  else state.holdings.push({ symbol, lots: [lot] });
  state.openLots.add(symbol);
  persistHoldings();
  elements.form.reset();
  elements.shares.value = "1";
  const covered = state.data.symbols.some((item) => item.symbol === symbol);
  elements.formNote.textContent = covered ? `${symbol} purchase recorded.` : `${symbol} was saved locally; sync it on GitHub for market updates.`;
  render();
  document.querySelector(`[data-symbol="${CSS.escape(symbol)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
}

elements.form.addEventListener("submit", addHolding);
elements.ticker.addEventListener("input", () => { elements.ticker.value = elements.ticker.value.toUpperCase().replace(/[^A-Z0-9.-]/g, ""); });

elements.grid.addEventListener("toggle", (event) => {
  const details = event.target.closest("[data-lots-panel]");
  if (!details) return;
  if (details.open) state.openLots.add(details.dataset.lotsPanel);
  else state.openLots.delete(details.dataset.lotsPanel);
}, true);

elements.grid.addEventListener("click", (event) => {
  const stockButton = event.target.closest("[data-remove-stock]");
  if (stockButton) {
    state.holdings = state.holdings.filter((item) => item.symbol !== stockButton.dataset.removeStock);
    state.openLots.delete(stockButton.dataset.removeStock);
    persistHoldings();
    render();
    return;
  }
  const lotButton = event.target.closest("[data-remove-lot]");
  if (!lotButton) return;
  const card = lotButton.closest("[data-symbol]");
  const holding = state.holdings.find((item) => item.symbol === card?.dataset.symbol);
  if (!holding) return;
  state.openLots.add(holding.symbol);
  holding.lots = holding.lots.filter((lot) => lot.id !== lotButton.dataset.removeLot);
  if (!holding.lots.length) state.holdings = state.holdings.filter((item) => item !== holding);
  persistHoldings();
  render();
});

elements.grid.addEventListener("change", (event) => {
  const input = event.target.closest("[data-lot-shares], [data-lot-price]");
  if (!input) return;
  const card = input.closest("[data-symbol]");
  const holding = state.holdings.find((item) => item.symbol === card?.dataset.symbol);
  if (!holding) return;
  const lotId = input.dataset.lotShares || input.dataset.lotPrice;
  const lot = holding.lots.find((item) => item.id === lotId);
  if (!lot) return;
  state.openLots.add(holding.symbol);
  const value = finite(input.value);
  if (input.dataset.lotShares !== undefined) {
    if (!value || value <= 0) { render(); return; }
    lot.shares = value;
  } else {
    if (value !== null && value <= 0) { render(); return; }
    lot.price = value;
  }
  persistHoldings();
  render();
});

elements.grid.addEventListener("submit", (event) => {
  const form = event.target.closest("[data-add-lot]");
  if (!form) return;
  event.preventDefault();
  const holding = state.holdings.find((item) => item.symbol === form.dataset.addLot);
  const shares = finite(form.elements.shares.value);
  const price = finite(form.elements.price.value);
  if (!holding || !shares || shares <= 0 || !price || price <= 0) return;
  holding.lots.push({ id: newLotId(), shares, price });
  state.openLots.add(holding.symbol);
  persistHoldings();
  render();
});

document.querySelectorAll("[data-period]").forEach((button) => button.addEventListener("click", () => {
  state.period = button.dataset.period;
  document.querySelectorAll("[data-period]").forEach((item) => item.classList.toggle("active", item === button));
  render();
}));

fetch(`./data/market.json?v=${Date.now()}`)
  .then((response) => {
    if (!response.ok) throw new Error(`Market snapshot returned ${response.status}`);
    return response.json();
  })
  .then((data) => {
    state.data = data;
    state.holdings = loadHoldings(data.symbols || []);
    persistHoldings();
    setSession(data.session);
    renderFreshness();
    render();
  })
  .catch((error) => {
    elements.grid.innerHTML = `<div class="empty-state"><strong>Market snapshot unavailable.</strong>${escapeHTML(error.message)}. Try refreshing in a moment.</div>`;
    elements.freshness.textContent = "Offline";
    elements.freshness.className = "data-badge degraded";
    elements.sessionLabel.textContent = "Feed unavailable";
    elements.sessionChip.classList.add("closed");
  });
