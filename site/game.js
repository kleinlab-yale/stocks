(() => {
  "use strict";

  const root = document.querySelector("#game-root");
  const roleSwitch = document.querySelector("#role-switch");
  const sessionChip = document.querySelector("#game-session-chip");
  const sessionLabel = document.querySelector("#game-session-label");
  const configuredApi = document
    .querySelector('meta[name="tickerquest-game-api"]')
    ?.getAttribute("content");
  const localApi = `${window.location.protocol}//${window.location.hostname}:3000/api/game`;
  const API =
    configuredApi && !configuredApi.includes("__GAME_API_URL__")
      ? configuredApi
      : ["localhost", "127.0.0.1"].includes(window.location.hostname)
        ? localApi
        : "";

  const params = new URLSearchParams(window.location.search);
  let gameId = params.get("game") || "";
  let currentRole = "player";
  let snapshot = null;
  let tradeSide = "buy";
  let refreshTimer = null;

  const storageKey = (kind) => `tickerquest:game:${gameId}:${kind}`;
  const getStored = (kind) => (gameId ? localStorage.getItem(storageKey(kind)) : null);
  const setStored = (kind, value) => {
    if (gameId && value) localStorage.setItem(storageKey(kind), value);
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function money(cents) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Number(cents || 0) / 100);
  }

  function signedMoney(cents) {
    const amount = Number(cents || 0);
    return `${amount >= 0 ? "+" : "−"}${money(Math.abs(amount))}`;
  }

  function percent(value) {
    const amount = Number(value || 0);
    return `${amount >= 0 ? "+" : "−"}${Math.abs(amount).toFixed(2)}%`;
  }

  function shares(value) {
    return Number(value || 0).toLocaleString("en-US", {
      maximumFractionDigits: 6,
    });
  }

  function dateTime(value) {
    if (!value) return "—";
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  }

  function countdown(game) {
    if (game.status === "lobby") return `${game.durationDays}-day game`;
    if (game.status === "ended") return "Final standings";
    const remaining = Math.max(0, Number(game.endsAt) - Date.now());
    const days = Math.floor(remaining / 86_400_000);
    const hours = Math.floor((remaining % 86_400_000) / 3_600_000);
    return days ? `${days}d ${hours}h remaining` : `${hours}h remaining`;
  }

  function gainClass(value) {
    return Number(value || 0) >= 0 ? "positive" : "negative";
  }

  function tokenFor(role = currentRole) {
    return getStored(role === "host" ? "host" : "player") || "";
  }

  function invitationTokens() {
    try {
      return JSON.parse(getStored("invites") || "{}");
    } catch {
      return {};
    }
  }

  function saveInvitationTokens(tokens) {
    setStored("invites", JSON.stringify(tokens));
  }

  function setRole(role) {
    currentRole = role;
    setStored("role", role);
    updateRoleSwitch();
  }

  function updateRoleSwitch() {
    const hasBoth = Boolean(getStored("host") && getStored("player"));
    roleSwitch.hidden = !hasBoth;
    if (hasBoth) {
      roleSwitch.textContent =
        currentRole === "host" ? "Player view" : "Host view";
    }
  }

  function setSession(label, marketIsOpen = false) {
    sessionLabel.textContent = label || "Family league";
    sessionChip.classList.toggle("closed", !marketIsOpen);
  }

  function showToast(message, isError = false) {
    document.querySelector(".toast")?.remove();
    const toast = document.createElement("div");
    toast.className = `toast${isError ? " error" : ""}`;
    toast.setAttribute("role", "status");
    toast.textContent = message;
    document.body.append(toast);
    window.setTimeout(() => toast.remove(), 4200);
  }

  function setFormStatus(form, message, isError = false) {
    const node = form.querySelector(".form-status");
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("error", isError);
  }

  async function apiRequest(method, body = null, role = currentRole) {
    if (!API) {
      throw new Error("The shared game service has not been connected yet.");
    }
    const headers = {
      Accept: "application/json",
      "X-Game-Role": role,
    };
    const token = tokenFor(role);
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body) headers["Content-Type"] = "application/json";
    const url =
      method === "GET"
        ? `${API}?gameId=${encodeURIComponent(gameId)}`
        : API;
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    let result;
    try {
      result = await response.json();
    } catch {
      result = {};
    }
    if (!response.ok) {
      throw new Error(result.error || "The family game service is unavailable.");
    }
    return result;
  }

  function renderGateway() {
    setSession("Family league", true);
    roleSwitch.hidden = true;
    root.innerHTML = `
      <section class="gateway">
        <div class="gateway-hero">
          <div>
            <p class="eyebrow">Private family portfolio league</p>
            <h1>Eight seats.<br>One champion.</h1>
            <p>Start everyone with the same $10,000, trade real market prices, and settle the leaderboard after a week or a month.</p>
          </div>
          <div class="gateway-rules">
            <span><strong>$10,000</strong><small>Simulated starting cash</small></span>
            <span><strong>8 seats</strong><small>One private link per player</small></span>
            <span><strong>24% tax</strong><small>Reserved on net realized gains</small></span>
            <span><strong>After tax</strong><small>Determines the leaderboard</small></span>
          </div>
        </div>
        <div class="gateway-card">
          <p class="eyebrow">Host a game</p>
          <h2>Make the family league.</h2>
          <p>No accounts or passwords. You will receive eight private invitation links to text to family members.</p>
          <form class="game-form" id="create-game-form">
            <label class="game-field">
              <span>Game name</span>
              <input name="name" maxlength="40" value="Family Portfolio League" required>
            </label>
            <label class="game-field">
              <span>Game length</span>
              <select name="durationDays">
                <option value="7">One week</option>
                <option value="30" selected>One month</option>
              </select>
            </label>
            <button class="primary-action mint" type="submit">Create eight-seat game</button>
            <p class="form-status"></p>
          </form>
          <p class="fine-print">This is a private educational simulation. Prices can be delayed, and the tax rules are simplified game mechanics—not financial or tax advice.</p>
        </div>
      </section>
    `;
  }

  function renderConfigurationError() {
    setSession("Setup incomplete", false);
    root.innerHTML = `
      <section class="join-wrap">
        <div class="join-card">
          <div class="seat-badge">TQ</div>
          <p class="eyebrow">Almost ready</p>
          <h1>The family game service is being connected.</h1>
          <p>Refresh this page shortly to continue into the family game.</p>
          <button class="primary-action" type="button" data-action="refresh" style="width:100%">Try again</button>
        </div>
      </section>
    `;
  }

  function renderJoin(data) {
    const seatNumber = data.you?.seatNumber || "—";
    setSession("Invitation ready", true);
    root.innerHTML = `
      <section class="join-wrap">
        <div class="join-card">
          <div class="seat-badge">#${escapeHtml(seatNumber)}</div>
          <p class="eyebrow">${escapeHtml(data.game.name)}</p>
          <h1>Claim your seat.</h1>
          <p>You have a private invitation. Choose the name your family will see on the leaderboard—nothing else is required.</p>
          <form class="game-form" id="join-game-form">
            <label class="game-field">
              <span>Player name</span>
              <input name="playerName" maxlength="20" autocomplete="nickname" placeholder="Your name" required autofocus>
            </label>
            <button class="primary-action mint" type="submit">Join with $10,000</button>
            <p class="form-status"></p>
          </form>
        </div>
      </section>
    `;
  }

  function renderPlayerLobby(data) {
    const joined = data.seats.filter((seat) => seat.joined).length;
    const width = Math.round((joined / 8) * 100);
    setSession(`${joined} of 8 joined`, false);
    root.innerHTML = `
      <section class="join-wrap">
        <div class="join-card">
          <div class="seat-badge">#${escapeHtml(data.you.seatNumber)}</div>
          <p class="eyebrow">${escapeHtml(data.game.name)}</p>
          <h1>You’re in, ${escapeHtml(data.you.playerName)}.</h1>
          <p>The host will start the ${data.game.durationDays}-day game after at least one more family member joins.</p>
          <div class="lobby-progress"><span style="width:${width}%"></span></div>
          <p class="fine-print">${joined} of 8 seats claimed · This page refreshes automatically</p>
          <button class="secondary-action" type="button" data-action="refresh" style="width:100%;margin-top:16px">Check the lobby</button>
        </div>
      </section>
    `;
  }

  function inviteUrl(token) {
    const url = new URL("./game.html", window.location.href);
    url.search = "";
    url.searchParams.set("game", gameId);
    url.searchParams.set("invite", token);
    return url.href;
  }

  function renderHostLobby(data) {
    const joined = data.seats.filter((seat) => seat.joined).length;
    const tokens = invitationTokens();
    setSession(`${joined} of 8 joined`, false);
    const cards = data.seats
      .map((seat) => {
        const token = tokens[String(seat.seatNumber)];
        const link = token ? inviteUrl(token) : "";
        return `
          <article class="seat-card${seat.joined ? " claimed" : ""}">
            <div class="seat-card-top">
              <strong>Seat ${seat.seatNumber}</strong>
              <span>${seat.joined ? escapeHtml(seat.playerName) : token ? "Invitation ready" : "Link not on this device"}</span>
            </div>
            ${
              !seat.joined && link
                ? `<div class="invite-tools">
                    <input class="invite-link" value="${escapeHtml(link)}" readonly aria-label="Seat ${seat.seatNumber} invitation link">
                    <button class="copy-action" type="button" data-action="copy" data-link="${escapeHtml(link)}">Copy</button>
                  </div>`
                : ""
            }
            <div class="seat-actions">
              ${
                !seat.joined && token
                  ? `<button class="secondary-action" type="button" data-action="join-seat" data-seat="${seat.seatNumber}">Join this seat</button>`
                  : ""
              }
              <button class="${seat.joined ? "danger-action" : "secondary-action"}" type="button" data-action="reset-seat" data-seat="${seat.seatNumber}">
                ${seat.joined ? "Clear player" : token ? "Reissue link" : "Create new link"}
              </button>
            </div>
          </article>
        `;
      })
      .join("");

    root.innerHTML = `
      <div class="game-topline">
        <div class="game-title">
          <span class="state-pill">Lobby</span>
          <h1>${escapeHtml(data.game.name)}</h1>
          <p>${data.game.durationDays}-day game · $10,000 per player · 24% simulated short-term tax</p>
        </div>
        <div class="game-actions">
          <button class="secondary-action" type="button" data-action="refresh">Refresh lobby</button>
          <button class="primary-action mint" type="button" data-action="start-game" ${joined < 2 ? "disabled" : ""}>Start game</button>
        </div>
      </div>
      <section class="lobby-board">
        <p class="eyebrow">Host controls</p>
        <h2>${joined} of 8 players are ready.</h2>
        <p>Copy each private link and send it to one family member. You can occupy a seat too while keeping this host view.</p>
        <div class="lobby-progress"><span style="width:${Math.round((joined / 8) * 100)}%"></span></div>
      </section>
      <section class="seat-grid">${cards}</section>
      ${renderRules()}
    `;
  }

  function renderRules() {
    return `
      <section class="panel rules-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">Game accounting</p><h2>Tap for the fine print</h2></div>
        </div>
        <div class="rules-grid">
          <details class="rule-item"><summary><strong>After-tax value</strong></summary><span>Cash + current holdings − reserved tax. This determines rank.</span></details>
          <details class="rule-item"><summary><strong>Tax reserve</strong></summary><span>24% of net realized gains. Reserved cash cannot fund a new purchase.</span></details>
          <details class="rule-item"><summary><strong>FIFO basis</strong></summary><span>When shares are sold, the oldest purchase lots are treated as sold first.</span></details>
          <details class="rule-item"><summary><strong>Wash sales</strong></summary><span>A loss followed by a repurchase of the same ticker within 30 days is deferred into the new lot’s cost basis.</span></details>
        </div>
      </section>
    `;
  }

  function renderHoldings(holdings, canSell) {
    if (!holdings?.length) {
      return `<div class="empty-compact">No positions yet. Your first purchase will appear here.</div>`;
    }
    return `<div class="holding-list">${holdings
      .map(
        (holding) => `
          <article class="holding-card">
            <div class="holding-symbol">
              <strong>${escapeHtml(holding.symbol)}</strong>
              <span>${escapeHtml(holding.name)}</span>
            </div>
            <div class="holding-metric"><span>Shares</span><strong>${shares(holding.shares)}</strong></div>
            <div class="holding-metric"><span>Value</span><strong>${money(holding.marketValueCents)}</strong></div>
            <div class="holding-metric"><span>Avg. cost</span><strong>${money(holding.averageCostCents)}</strong></div>
            <div class="holding-metric"><span>Unrealized</span><strong class="${gainClass(holding.unrealizedCents)}">${signedMoney(holding.unrealizedCents)}</strong></div>
            ${
              canSell
                ? `<button type="button" data-action="sell-holding" data-symbol="${escapeHtml(holding.symbol)}" data-shares="${holding.shares}">Sell</button>`
                : ""
            }
          </article>
        `,
      )
      .join("")}</div>`;
  }

  function renderTradePanel(data) {
    const canTrade =
      data.game.status === "active" &&
      data.market.canTrade &&
      currentRole === "player";
    const symbolOptions = data.market.symbols
      .filter((quote) => quote.priceCents)
      .map(
        (quote) =>
          `<option value="${escapeHtml(quote.symbol)}">${escapeHtml(quote.symbol)} · ${money(quote.priceCents)}</option>`,
      )
      .join("");
    return `
      <section class="panel trade-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">Order ticket</p><h2>Trade</h2></div>
        </div>
        ${
          canTrade
            ? `<form class="game-form trade-form" id="trade-form">
                <div class="trade-side">
                  <button class="${tradeSide === "buy" ? "active" : ""}" type="button" data-action="trade-side" data-side="buy">Buy</button>
                  <button class="${tradeSide === "sell" ? "active" : ""}" type="button" data-action="trade-side" data-side="sell">Sell</button>
                </div>
                <label class="game-field"><span>Ticker</span><select name="symbol">${symbolOptions}</select></label>
                <label class="game-field"><span>Shares</span><input name="shares" type="number" min="0.000001" step="0.000001" inputmode="decimal" placeholder="0" required></label>
                <div class="market-closed">Orders are available anytime using the newest shared quote: ${escapeHtml(data.market.sessionLabel)} · ${dateTime(data.market.generatedAt)}.</div>
                <div class="trade-quote"><span>Latest available quote</span><strong data-trade-price>—</strong></div>
                <div class="trade-summary">
                  <span>Estimated value<strong data-trade-value>$0.00</strong></span>
                  <span>${tradeSide === "buy" ? "Spendable cash" : "Owned shares"}<strong data-trade-limit>—</strong></span>
                </div>
                <button class="primary-action mint" type="submit">${tradeSide === "buy" ? "Buy shares" : "Sell shares"}</button>
                <p class="form-status"></p>
              </form>`
            : `<div class="market-closed">
                ${
                  data.game.status !== "active"
                    ? "Trading is closed because this game is not active."
                    : "The latest shared quote is unavailable or more than seven days old. Trading will reopen automatically when the price feed refreshes."
                }
              </div>`
        }
      </section>
    `;
  }

  function renderLeaderboard(data) {
    if (!data.leaderboard.length) {
      return `<div class="empty-compact">The leaderboard appears when players join.</div>`;
    }
    const youSeat = currentRole === "player" ? data.you?.seatId : "";
    return `<div class="leaderboard-list">${data.leaderboard
      .map(
        (player) => `
          <details class="leaderboard-row${player.seatId === youSeat ? " you" : ""}">
            <summary>
              <span class="rank-number">${player.rank}</span>
              <span class="leader-name"><strong>${escapeHtml(player.playerName)}${player.seatId === youSeat ? " · You" : ""}</strong><span>${player.holdings.length} position${player.holdings.length === 1 ? "" : "s"}</span></span>
              <span class="leader-metric"><span>After tax</span><strong>${money(player.afterTaxCents)}</strong></span>
              <span class="leader-metric cash"><span>Cash</span><strong>${money(player.spendableCashCents)}</strong></span>
              <span class="leader-metric tax"><span>Return</span><strong class="${gainClass(player.returnPercent)}">${percent(player.returnPercent)}</strong></span>
            </summary>
            <div class="leader-holdings">
              ${
                player.holdings.length
                  ? player.holdings
                      .map(
                        (holding) =>
                          `<span>${escapeHtml(holding.symbol)} · ${shares(holding.shares)} sh · ${money(holding.marketValueCents)}</span>`,
                      )
                      .join("")
                  : "<span>All cash</span>"
              }
            </div>
          </details>
        `,
      )
      .join("")}</div>`;
  }

  function renderActivity(trades) {
    if (!trades.length) {
      return `<div class="empty-compact">Trades will appear here for the whole family.</div>`;
    }
    return `<div class="activity-list">${trades
      .map(
        (trade) => `
          <div class="activity-row">
            <div>
              <strong>${escapeHtml(trade.playerName)} ${trade.side === "buy" ? "bought" : "sold"} ${shares(trade.shares)} ${escapeHtml(trade.symbol)}</strong>
              <span>${money(trade.priceCents)} per share${
                trade.side === "sell"
                  ? ` · <span class="${gainClass(trade.realizedGainCents)}" style="display:inline">${signedMoney(trade.realizedGainCents)} realized</span>`
                  : ""
              }</span>
            </div>
            <time datetime="${new Date(trade.createdAt).toISOString()}">${dateTime(trade.createdAt)}</time>
          </div>
        `,
      )
      .join("")}</div>`;
  }

  function renderGame(data) {
    const isPlayer = currentRole === "player";
    const you = isPlayer ? data.you : null;
    const leader = data.leaderboard[0] || null;
    const featured = you || leader;
    const joined = data.leaderboard.length;
    const canSell = Boolean(isPlayer && data.market.canTrade && data.game.status === "active");
    const stateClass = data.game.status === "active" ? "active" : data.game.status === "ended" ? "ended" : "";
    setSession(
      data.market.sessionLabel,
      data.market.sessionLabel === "Market open",
    );

    root.innerHTML = `
      <div class="game-topline">
        <div class="game-title">
          <span class="state-pill ${stateClass}">${escapeHtml(data.game.status)}</span>
          <h1>${escapeHtml(data.game.name)}</h1>
          <p>${countdown(data.game)} · ${joined} player${joined === 1 ? "" : "s"} · Quotes updated ${dateTime(data.market.generatedAt)}</p>
        </div>
        <div class="game-actions">
          <button class="secondary-action" type="button" data-action="refresh">Refresh</button>
          ${
            currentRole === "host" && data.game.status === "active"
              ? `<button class="danger-action" type="button" data-action="end-game">End game now</button>`
              : ""
          }
        </div>
      </div>
      <section class="game-board">
        <div class="game-board-cell game-board-main">
          <span>${you ? "Your after-tax value" : "Current leader"}</span>
          <strong>${featured ? money(featured.afterTaxCents) : money(data.game.startingCashCents)}</strong>
          <small>${featured ? `${escapeHtml(featured.playerName)} · ${percent(featured.returnPercent)}` : "No players yet"}</small>
        </div>
        <div class="game-board-cell game-board-metric">
          <span>${you ? "Spendable cash" : "Leading return"}</span>
          <strong>${you ? money(you.spendableCashCents) : leader ? percent(leader.returnPercent) : "—"}</strong>
          <small>${you ? "Cash after reserved tax" : "After simulated taxes"}</small>
        </div>
        <div class="game-board-cell game-board-metric tax">
          <span>${you ? "Tax reserve" : "Players"}</span>
          <strong>${you ? money(you.taxReserveCents) : joined}</strong>
          <small>${you ? "24% of net realized gains" : "Up to eight family members"}</small>
        </div>
        <div class="game-board-cell game-board-metric rank">
          <span>${you ? "Your rank" : "Time left"}</span>
          <strong>${you ? `#${you.rank} / ${joined}` : countdown(data.game)}</strong>
          <small>${data.game.status === "ended" ? "Game complete" : `Ends ${dateTime(data.game.endsAt)}`}</small>
        </div>
      </section>
      <div class="game-layout">
        <div>
          ${
            you
              ? `<section class="panel">
                  <div class="panel-heading"><div><p class="eyebrow">Your portfolio</p><h2>Positions</h2></div><p>${money(you.marketValueCents)} invested</p></div>
                  ${renderHoldings(you.holdings, canSell)}
                </section>`
              : `<section class="panel">
                  <div class="panel-heading"><div><p class="eyebrow">Host view</p><h2>Family activity</h2></div></div>
                  ${renderActivity(data.recentTrades)}
                </section>`
          }
        </div>
        ${
          you
            ? renderTradePanel(data)
            : `<section class="panel"><div class="panel-heading"><div><p class="eyebrow">Timing</p><h2>${countdown(data.game)}</h2></div></div><div class="market-closed">The host can watch every portfolio and end the game. Switch to your player view to trade.</div></section>`
        }
      </div>
      <section class="panel leaderboard-panel">
        <div class="panel-heading"><div><p class="eyebrow">After-tax standings</p><h2>Leaderboard</h2></div><p>Tap a player to see holdings</p></div>
        ${renderLeaderboard(data)}
      </section>
      ${
        you
          ? `<section class="panel leaderboard-panel"><div class="panel-heading"><div><p class="eyebrow">League tape</p><h2>Recent activity</h2></div></div>${renderActivity(data.recentTrades)}</section>`
          : ""
      }
      ${renderRules()}
    `;
    updateTradePreview();
  }

  function updateTradePreview() {
    const form = document.querySelector("#trade-form");
    if (!form || !snapshot) return;
    const symbol = form.elements.symbol.value;
    const quantity = Number(form.elements.shares.value || 0);
    const quote = snapshot.market.symbols.find((item) => item.symbol === symbol);
    const holding = snapshot.you?.holdings?.find((item) => item.symbol === symbol);
    form.querySelector("[data-trade-price]").textContent = quote?.priceCents
      ? money(quote.priceCents)
      : "Unavailable";
    form.querySelector("[data-trade-value]").textContent =
      quote?.priceCents && quantity > 0
        ? money(Math.round(quote.priceCents * quantity))
        : money(0);
    form.querySelector("[data-trade-limit]").textContent =
      tradeSide === "buy"
        ? money(snapshot.you?.spendableCashCents)
        : `${shares(holding?.shares)} shares`;
  }

  async function refresh({ quiet = false } = {}) {
    if (!gameId) {
      renderGateway();
      return;
    }
    if (!tokenFor(currentRole)) {
      const alternative = currentRole === "host" ? "player" : "host";
      if (tokenFor(alternative)) setRole(alternative);
    }
    if (!tokenFor(currentRole)) {
      root.innerHTML = `
        <section class="join-wrap"><div class="join-card">
          <div class="seat-badge">!</div><p class="eyebrow">Private game</p>
          <h1>This link is missing its invitation.</h1>
          <p>Ask the host to send you the complete private player link.</p>
          <a class="secondary-action" href="./game.html" style="display:grid;place-items:center;text-decoration:none">Start a new game</a>
        </div></section>`;
      return;
    }
    try {
      const data = await apiRequest("GET");
      snapshot = data;
      updateRoleSwitch();
      if (currentRole === "player" && !data.you?.playerName) {
        renderJoin(data);
      } else if (data.game.status === "lobby") {
        currentRole === "host" ? renderHostLobby(data) : renderPlayerLobby(data);
      } else {
        renderGame(data);
      }
      if (!quiet) window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      if (quiet) {
        showToast(error.message, true);
        return;
      }
      root.innerHTML = `
        <section class="join-wrap"><div class="join-card">
          <div class="seat-badge">!</div><p class="eyebrow">Could not load game</p>
          <h1>${escapeHtml(error.message)}</h1>
          <p>The private link may have been reissued, or the service may be refreshing.</p>
          <button class="primary-action" type="button" data-action="refresh" style="width:100%">Try again</button>
        </div></section>`;
    }
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    input.select();
    document.execCommand("copy");
    input.remove();
  }

  root.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type="submit"]');
    if (button) button.disabled = true;
    try {
      if (form.id === "create-game-form") {
        setFormStatus(form, "Creating eight private seats…");
        const values = new FormData(form);
        const result = await apiRequest(
          "POST",
          {
            action: "create",
            name: values.get("name"),
            durationDays: Number(values.get("durationDays")),
          },
          "host",
        );
        gameId = result.gameId;
        setStored("host", result.hostToken);
        saveInvitationTokens(
          Object.fromEntries(
            result.invitations.map((item) => [String(item.seatNumber), item.token]),
          ),
        );
        setRole("host");
        const cleanUrl = new URL(window.location.href);
        cleanUrl.search = "";
        cleanUrl.searchParams.set("game", gameId);
        history.replaceState({}, "", cleanUrl);
        await refresh();
        showToast("Game created. Send each private link to one player.");
      } else if (form.id === "join-game-form") {
        setFormStatus(form, "Claiming your seat…");
        const values = new FormData(form);
        await apiRequest("POST", {
          action: "join",
          gameId,
          inviteToken: tokenFor("player"),
          playerName: values.get("playerName"),
        });
        await refresh();
        showToast("Seat claimed. You are in the game.");
      } else if (form.id === "trade-form") {
        setFormStatus(form, "Checking the live game quote…");
        const values = new FormData(form);
        const result = await apiRequest("POST", {
          action: "trade",
          gameId,
          side: tradeSide,
          symbol: values.get("symbol"),
          shares: values.get("shares"),
        });
        await refresh({ quiet: true });
        showToast(
          `${tradeSide === "buy" ? "Bought" : "Sold"} ${shares(result.trade.shares)} ${result.trade.symbol} at ${money(result.trade.priceCents)}.`,
        );
      }
    } catch (error) {
      setFormStatus(form, error.message, true);
      showToast(error.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  });

  root.addEventListener("input", (event) => {
    if (event.target.closest("#trade-form")) updateTradePreview();
  });

  root.addEventListener("change", (event) => {
    if (event.target.closest("#trade-form")) updateTradePreview();
  });

  root.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = button.dataset.action;
    try {
      if (action === "refresh") {
        button.disabled = true;
        await refresh({ quiet: true });
        showToast("Game refreshed.");
      } else if (action === "copy") {
        await copyText(button.dataset.link);
        button.textContent = "Copied";
        showToast("Private invitation copied.");
      } else if (action === "join-seat") {
        const tokens = invitationTokens();
        const token = tokens[String(button.dataset.seat)];
        if (!token) throw new Error("Reissue this seat’s invitation first.");
        setStored("player", token);
        setRole("player");
        await refresh();
      } else if (action === "reset-seat") {
        const seatNumber = Number(button.dataset.seat);
        const seat = snapshot.seats.find((item) => item.seatNumber === seatNumber);
        if (
          seat?.joined &&
          !window.confirm(`Clear ${seat.playerName} from seat ${seatNumber}?`)
        ) {
          return;
        }
        button.disabled = true;
        const result = await apiRequest("POST", {
          action: "resetSeat",
          gameId,
          seatNumber,
        });
        const tokens = invitationTokens();
        tokens[String(seatNumber)] = result.token;
        saveInvitationTokens(tokens);
        await refresh({ quiet: true });
        showToast(`Seat ${seatNumber} now has a new private link.`);
      } else if (action === "start-game") {
        button.disabled = true;
        await apiRequest("POST", { action: "start", gameId });
        await refresh();
        showToast("The market game has started.");
      } else if (action === "end-game") {
        if (!window.confirm("End the game now and lock the final standings?")) return;
        button.disabled = true;
        await apiRequest("POST", { action: "end", gameId });
        await refresh();
        showToast("The final standings are locked.");
      } else if (action === "trade-side") {
        tradeSide = button.dataset.side === "sell" ? "sell" : "buy";
        renderGame(snapshot);
      } else if (action === "sell-holding") {
        tradeSide = "sell";
        renderGame(snapshot);
        const form = document.querySelector("#trade-form");
        if (form) {
          form.elements.symbol.value = button.dataset.symbol;
          form.elements.shares.value = button.dataset.shares;
          updateTradePreview();
          form.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    } catch (error) {
      showToast(error.message, true);
      button.disabled = false;
    }
  });

  roleSwitch.addEventListener("click", async () => {
    setRole(currentRole === "host" ? "player" : "host");
    await refresh();
  });

  function capturePrivateLinks() {
    if (!gameId) return;
    const invite = params.get("invite");
    const host = params.get("host");
    if (invite) {
      setStored("player", invite);
      setRole("player");
    } else if (host) {
      setStored("host", host);
      setRole("host");
    } else {
      const preferred = getStored("role");
      setRole(preferred === "host" ? "host" : "player");
      if (!tokenFor(currentRole) && getStored("host")) setRole("host");
    }
    if (invite || host) {
      const cleanUrl = new URL(window.location.href);
      cleanUrl.search = "";
      cleanUrl.searchParams.set("game", gameId);
      history.replaceState({}, "", cleanUrl);
    }
  }

  capturePrivateLinks();
  if (!API && !["localhost", "127.0.0.1"].includes(window.location.hostname)) {
    renderConfigurationError();
  } else {
    refresh();
    refreshTimer = window.setInterval(() => {
      if (document.visibilityState === "visible" && gameId) refresh({ quiet: true });
    }, 60_000);
  }

  window.addEventListener("beforeunload", () => {
    if (refreshTimer) window.clearInterval(refreshTimer);
  });
})();
