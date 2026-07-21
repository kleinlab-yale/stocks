const STORAGE_KEY = "tickerquest:holdings:v1";
const state = { data: null, holdings: [], period: "day" };

const elements = {
  form: document.querySelector("#ticker-form"),
  ticker: document.querySelector("#ticker-input"),
  shares: document.querySelector("#shares-input"),
  formNote: document.querySelector("#form-note"),
  grid: document.querySelector("#stock-grid"),
  sessionChip: document.querySelector("#session-chip"),
  sessionLabel: document.querySelector("#session-label"),
  freshness: document.querySelector("#freshness-badge"),
  score: document.querySelector("#portfolio-score"),
  scoreOrbit: document.querySelector("#score-orbit"),
  scoreRank: document.querySelector("#score-rank"),
  scoreNote: document.querySelector("#score-note"),
  xpFill: document.querySelector("#xp-fill"),
  xpLabel: document.querySelector("#xp-label"),
  level: document.querySelector("#level-label"),
  marketValue: document.querySelector("#market-value"),
  dayPnl: document.querySelector("#day-pnl"),
  weekPnl: document.querySelector("#week-pnl"),
  updatedTime: document.querySelector("#updated-time"),
  source: document.querySelector("#source-label"),
  count: document.querySelector("#holding-count"),
  questCount: document.querySelector("#quest-count"),
  questCopy: document.querySelector("#quest-copy"),
  questFill: document.querySelector("#quest-fill"),
  badges: document.querySelector("#badges"),
};

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function escapeHTML(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function money(value, currency = "USD", signed = false) {
  if (!Number.isFinite(value)) return "—";
  const formatted = new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: Math.abs(value) < 100 ? 2 : 0 }).format(Math.abs(value));
  if (!signed) return formatted;
  return `${value >= 0 ? "+" : "−"}${formatted}`;
}

function percent(value) {
  if (!Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(2)}%`;
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

function classFor(value) {
  return value > 0 ? "positive" : value < 0 ? "negative" : "";
}

function loadHoldings(symbols) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved)) {
      const clean = saved.filter((item) => /^[A-Z][A-Z0-9.-]{0,9}$/.test(item.symbol)).map((item) => ({ symbol: item.symbol, shares: Math.max(0.001, finite(item.shares) || 1) }));
      return clean;
    }
  } catch (_) {}
  return symbols.map((item) => ({ symbol: item.symbol, shares: 1 }));
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
  elements.source.textContent = mode === "demo" ? "Preview snapshot—scheduled updates start after publishing." : `${state.data.source}. ${ageMinutes} min old.`;
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
  const color = positive ? "#5bb82b" : "#df654e";
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, positive ? "rgba(117,214,59,.22)" : "rgba(255,138,112,.2)");
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

function renderStock(holding, stock, totalValue) {
  if (!stock || !Number.isFinite(finite(stock.price))) {
    const template = document.querySelector("#pending-template");
    const node = template.content.firstElementChild.cloneNode(true);
    node.querySelector("h3").textContent = holding.symbol;
    const controls = document.createElement("div");
    controls.className = "holding-row";
    controls.innerHTML = `<label class="share-editor">Shares <input type="number" min="0.001" step="any" value="${holding.shares}" aria-label="Shares of ${escapeHTML(holding.symbol)}" data-shares="${escapeHTML(holding.symbol)}" /></label><button class="remove-button" type="button" data-remove="${escapeHTML(holding.symbol)}">Remove</button>`;
    node.appendChild(controls);
    return node;
  }

  const price = finite(stock.price);
  const day = change(price, finite(stock.previousClose));
  const week = change(price, finite(stock.weekAgoClose));
  const score = momentumScore(day.percent, week.percent);
  const ranking = state.period === "day" ? day.percent : week.percent;
  const scoreClass = score >= 65 ? "high" : score < 40 ? "low" : "";
  const initials = stock.symbol.slice(0, 3);
  const positionValue = price * holding.shares;
  const portfolioWeight = totalValue > 0 ? (positionValue / totalValue) * 100 : 0;
  const extended = [];
  const pre = finite(stock.premarketPrice);
  const after = finite(stock.afterHoursPrice);
  const preMove = change(pre, finite(stock.previousClose)).percent;
  const afterMove = change(after, finite(stock.regularPrice)).percent;
  if (pre) extended.push(`<span class="extended-chip">Pre ${money(pre, stock.currency)} · ${percent(preMove)}</span>`);
  if (after) extended.push(`<span class="extended-chip">After ${money(after, stock.currency)} · ${percent(afterMove)}</span>`);
  if (!extended.length) extended.push(`<span class="extended-chip">Regular session</span>`);

  const card = document.createElement("article");
  card.className = "stock-card";
  card.innerHTML = `
    <div class="stock-top">
      <div class="stock-symbol"><span class="ticker-avatar">${escapeHTML(initials)}</span><div><h3>${escapeHTML(stock.symbol)}</h3><p>${escapeHTML(stock.name || stock.symbol)}</p></div></div>
      <span class="score-pill ${scoreClass}" title="Momentum score">${score ?? "—"} pts</span>
    </div>
    <div class="price-row">
      <div class="price-main"><span>Last price</span><strong>${money(price, stock.currency)}</strong></div>
      <canvas class="sparkline" aria-label="Seven-session price trend" role="img"></canvas>
    </div>
    <div class="stock-metrics">
      <div class="stock-metric"><span class="metric-label">Today</span><strong class="${classFor(day.percent)}">${percent(day.percent)}</strong><small>${money(day.amount, stock.currency, true)} / share</small></div>
      <div class="stock-metric"><span class="metric-label">Week</span><strong class="${classFor(week.percent)}">${percent(week.percent)}</strong><small>${money(week.amount, stock.currency, true)} / share</small></div>
    </div>
    <div class="extended-row">${extended.join("")}</div>
    <div class="weight-row">
      <div><span>Position</span><strong>${money(positionValue, stock.currency)}</strong></div>
      <div class="weight-copy"><span>Portfolio weight</span><strong>${portfolioWeight.toFixed(1)}%</strong></div>
      <div class="weight-track" aria-hidden="true"><span style="width:${Math.min(portfolioWeight, 100)}%"></span></div>
    </div>
    <div class="holding-row">
      <label class="share-editor">Shares <input type="number" min="0.001" step="any" value="${holding.shares}" aria-label="Shares of ${escapeHTML(stock.symbol)}" data-shares="${escapeHTML(stock.symbol)}" /></label>
      <button class="remove-button" type="button" data-remove="${escapeHTML(stock.symbol)}">Remove</button>
    </div>`;
  requestAnimationFrame(() => drawSparkline(card.querySelector("canvas"), stock.sparkline || [], (ranking ?? 0) >= 0));
  return card;
}

function renderSummary(rows) {
  const valid = rows.filter((row) => Number.isFinite(finite(row.stock?.price)));
  let marketValue = 0;
  let dayPnl = 0;
  let weekPnl = 0;
  let weightedScore = 0;
  let scoreWeight = 0;
  let weeklyWinners = 0;
  let dailyWinners = 0;

  valid.forEach(({ holding, stock }) => {
    const price = finite(stock.price);
    const value = price * holding.shares;
    const day = change(price, finite(stock.previousClose));
    const week = change(price, finite(stock.weekAgoClose));
    const score = momentumScore(day.percent, week.percent);
    marketValue += value;
    dayPnl += (day.amount || 0) * holding.shares;
    weekPnl += (week.amount || 0) * holding.shares;
    if ((week.percent || 0) > 0) weeklyWinners += 1;
    if ((day.percent || 0) > 0) dailyWinners += 1;
    if (score !== null) { weightedScore += score * value; scoreWeight += value; }
  });

  const score = scoreWeight ? Math.round(weightedScore / scoreWeight) : 0;
  const [rank, note] = scoreTier(score);
  const level = Math.max(1, Math.floor(score / 10) + 1);
  const xp = score * 10;
  const questPercent = valid.length ? Math.round((weeklyWinners / valid.length) * 100) : 0;
  elements.score.textContent = valid.length ? score : "—";
  elements.scoreOrbit.style.setProperty("--score", score);
  elements.scoreRank.textContent = valid.length ? rank : "Add your first ticker";
  elements.scoreNote.textContent = valid.length ? note : "Build a lineup to unlock your momentum score.";
  elements.xpFill.style.width = `${score}%`;
  elements.xpLabel.textContent = `${xp} XP`;
  elements.level.textContent = `Level ${level}`;
  elements.marketValue.textContent = money(marketValue);
  elements.dayPnl.textContent = money(dayPnl, "USD", true);
  elements.weekPnl.textContent = money(weekPnl, "USD", true);
  elements.dayPnl.className = classFor(dayPnl);
  elements.weekPnl.className = classFor(weekPnl);
  elements.questCount.textContent = `${weeklyWinners} / ${valid.length}`;
  elements.questFill.style.width = `${questPercent}%`;
  elements.questCopy.textContent = valid.length ? `${weeklyWinners} of ${valid.length} holdings are above their weekly line.` : "Positive weekly momentum earns the Weekly Winner badge.";
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
  const totalValue = rows.reduce((sum, row) => sum + (finite(row.stock?.price) || 0) * row.holding.shares, 0);
  const sorted = [...rows].sort((a, b) => {
    const refA = state.period === "day" ? a.stock?.previousClose : a.stock?.weekAgoClose;
    const refB = state.period === "day" ? b.stock?.previousClose : b.stock?.weekAgoClose;
    return (change(finite(b.stock?.price), finite(refB)).percent ?? -999) - (change(finite(a.stock?.price), finite(refA)).percent ?? -999);
  });
  elements.grid.replaceChildren();
  if (!sorted.length) {
    elements.grid.innerHTML = '<div class="empty-state"><strong>Your lineup is empty.</strong>Use the form above to add a stock ticker.</div>';
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
  elements.formNote.classList.remove("error");
  if (!/^[A-Z][A-Z0-9.-]{0,9}$/.test(symbol)) {
    elements.formNote.textContent = "Use a valid ticker such as AAPL or BRK.B.";
    elements.formNote.classList.add("error");
    return;
  }
  if (!shares || shares <= 0) {
    elements.formNote.textContent = "Enter a share count greater than zero.";
    elements.formNote.classList.add("error");
    return;
  }
  const existing = state.holdings.find((item) => item.symbol === symbol);
  if (existing) existing.shares += shares;
  else state.holdings.push({ symbol, shares });
  persistHoldings();
  elements.form.reset();
  elements.shares.value = "1";
  const covered = state.data.symbols.some((item) => item.symbol === symbol);
  elements.formNote.textContent = covered ? `${symbol} joined your quest.` : `${symbol} was saved locally; sync it on GitHub for market updates.`;
  render();
}

elements.form.addEventListener("submit", addHolding);
elements.ticker.addEventListener("input", () => { elements.ticker.value = elements.ticker.value.toUpperCase().replace(/[^A-Z0-9.-]/g, ""); });
elements.grid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-remove]");
  if (!button) return;
  state.holdings = state.holdings.filter((item) => item.symbol !== button.dataset.remove);
  persistHoldings();
  render();
});
elements.grid.addEventListener("change", (event) => {
  const input = event.target.closest("[data-shares]");
  if (!input) return;
  const holding = state.holdings.find((item) => item.symbol === input.dataset.shares);
  const shares = finite(input.value);
  if (holding && shares && shares > 0) { holding.shares = shares; persistHoldings(); render(); }
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
