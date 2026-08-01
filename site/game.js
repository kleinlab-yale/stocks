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
  let tradeSymbol = "";
  let refreshTimer = null;
  let refreshInFlight = false;
  let trendSelection = "all";
  let trendRange = "day";
  let trendResizeTimer = null;
  let serviceCapabilities = null;
  const checkedQuotes = new Map();
  const PLAYER_CHARACTERS = {
    grandpa: {
      nickname: "The Wise",
      image: "./assets/players/grandpa-the-wise.jpg",
    },
    grandma: {
      nickname: "The Queen",
      image: "./assets/players/grandma-the-queen.jpg",
    },
    cher: {
      nickname: "Golden State",
      image: "./assets/players/cher-golden-state.jpg",
    },
    henry: {
      nickname: "Merica First",
      image: "./assets/players/henry-merica-first.jpg",
    },
    may: {
      nickname: "$",
      image: "./assets/players/may-money-mind.jpg",
    },
    daryl: {
      nickname: "AI",
      image: "./assets/players/daryl-ai.jpg",
    },
  };

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

  function normalizedPlayerName(value) {
    return String(value ?? "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
  }

  function playerCharacter(playerName) {
    const normalized = normalizedPlayerName(playerName);
    const compact = normalized.replace(/[^a-z0-9]/g, "");

    if (compact.includes("daryl") || /(^|[^a-z0-9])ai([^a-z0-9]|$)/.test(normalized)) {
      return PLAYER_CHARACTERS.daryl;
    }

    const familyName = ["grandpa", "grandma", "cher", "henry", "may"].find((name) =>
      new RegExp(`(^|[^a-z0-9])${name}([^a-z0-9]|$)`).test(normalized),
    );
    return familyName ? PLAYER_CHARACTERS[familyName] : null;
  }

  function renderPlayerAvatar(playerName, className = "") {
    const character = playerCharacter(playerName);
    const classes = `player-avatar${className ? ` ${className}` : ""}`;
    if (character) {
      return `<img class="${classes}" src="${character.image}" alt="" loading="lazy" decoding="async">`;
    }
    const initial = String(playerName ?? "+").trim().charAt(0).toUpperCase() || "+";
    return `<span class="${classes} avatar-fallback" aria-hidden="true">${escapeHtml(initial)}</span>`;
  }

  function renderPlayerNickname(playerName) {
    const nickname = playerCharacter(playerName)?.nickname;
    const normalizedName = normalizedPlayerName(playerName);
    const normalizedNickname = normalizedPlayerName(nickname);
    const nicknameAlreadyShown =
      nickname === "$"
        ? String(playerName ?? "").includes("$")
        : normalizedNickname && normalizedName.includes(normalizedNickname);
    return nickname
      ? nicknameAlreadyShown
        ? ""
        : `<em class="player-nickname">“${escapeHtml(nickname)}”</em>`
      : "";
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

  function compactMoney(cents) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(Number(cents || 0) / 100);
  }

  function shares(value) {
    return Number(value || 0).toLocaleString("en-US", {
      maximumFractionDigits: 6,
    });
  }

  function dollars(value) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    }).format(Number(value || 0));
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

  function gameLength(game) {
    if (game.targetValueCents) {
      return `First to ${money(game.targetValueCents)}`;
    }
    if (Number(game.durationDays) === 0) return "No-end game";
    if (Number(game.durationDays) === 365) return "One-year game";
    if (Number(game.durationDays) === 30) return "One-month game";
    return "One-week game";
  }

  function countdown(game) {
    if (game.status === "lobby") return gameLength(game);
    if (game.status === "ended") return "Final standings";
    if (game.targetValueCents) {
      return `Race to ${money(game.targetValueCents)}`;
    }
    if (!game.endsAt) return "No time limit";
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
    if (gameId && tokenFor(role)) syncPrivateUrl();
    updateRoleSwitch();
  }

  function updateRoleSwitch() {
    const hasBoth = Boolean(getStored("host") && getStored("player"));
    roleSwitch.hidden = !hasBoth;
    if (hasBoth) {
      roleSwitch.textContent =
        currentRole === "host" ? "Switch to player" : "Host controls";
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
    const extendedDurations =
      serviceCapabilities?.durationDays?.includes(365) &&
      serviceCapabilities?.durationDays?.includes(0);
    const configurableStartingCash =
      serviceCapabilities?.configurableStartingCash === true;
    const targetValueEnd =
      serviceCapabilities?.targetValueEnd === true;
    setSession("Family league", true);
    roleSwitch.hidden = true;
    root.innerHTML = `
      <section class="gateway">
        <div class="gateway-hero">
          <div>
            <p class="eyebrow">Private family portfolio league</p>
            <h1>Eight seats.<br>One champion.</h1>
            <p>Give everyone the same starting bankroll, trade real market prices, and race for a week, month, year, forever, or to a winning portfolio value.</p>
          </div>
          <div class="gateway-rules">
            <span><strong>${configurableStartingCash ? "Your amount" : "$10,000"}</strong><small>Equal simulated starting cash</small></span>
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
              <span>How the game ends</span>
              <select name="endCondition">
                <option value="7">One week</option>
                <option value="30" selected>One month</option>
                ${extendedDurations ? '<option value="365">One year</option><option value="0">No end date</option>' : ""}
                ${targetValueEnd ? '<option value="goal">First to a portfolio value</option>' : ""}
              </select>
            </label>
            ${
              configurableStartingCash
                ? `<label class="game-field">
                    <span>Starting cash per player</span>
                    <input name="startingCash" type="number" min="100" max="100000000" step="100" value="10000" inputmode="decimal" required>
                  </label>`
                : '<input name="startingCash" type="hidden" value="10000">'
            }
            ${
              targetValueEnd
                ? `<label class="game-field goal-value-field" hidden>
                    <span>Winning portfolio value</span>
                    <input name="targetValue" type="number" min="101" max="1000000000" step="1000" value="1000000" inputmode="decimal">
                    <small>Must be higher than the starting cash.</small>
                  </label>`
                : ""
            }
            <button class="primary-action mint" type="submit">Create eight-seat game</button>
            <p class="form-status"></p>
          </form>
          <p class="fine-print">This is a private educational simulation. Prices can be delayed, and the tax rules are simplified game mechanics—not financial or tax advice.</p>
        </div>
      </section>
    `;
    updateCreateGoalFields();
  }

  function updateCreateGoalFields() {
    const form = document.querySelector("#create-game-form");
    if (!form) return;
    const goalField = form.querySelector(".goal-value-field");
    const targetInput = form.elements.targetValue;
    if (!goalField || !targetInput) return;
    const isGoal = form.elements.endCondition.value === "goal";
    goalField.hidden = !isGoal;
    targetInput.required = isGoal;
    const startingCash = Number(form.elements.startingCash?.value || 0);
    if (Number.isFinite(startingCash) && startingCash > 0) {
      targetInput.min = String(startingCash + 1);
      if (isGoal && Number(targetInput.value) <= startingCash) {
        targetInput.value = String(
          Math.min(1_000_000_000, startingCash * 10),
        );
      }
    }
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
            <button class="primary-action mint" type="submit">Join with ${money(data.game.startingCashCents)}</button>
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
          <p>The host will start the game after at least one more family member joins. Format: ${gameLength(data.game).toLowerCase()}.</p>
          <div class="lobby-progress"><span style="width:${width}%"></span></div>
          <p class="fine-print">${joined} of 8 seats claimed · This page refreshes automatically</p>
          <button class="secondary-action" type="button" data-action="refresh" style="width:100%;margin-top:16px">Check the lobby</button>
        </div>
      </section>
    `;
  }

  function privateSessionUrl(role, token = tokenFor(role)) {
    if (!token) return "";
    const url = new URL("./game.html", window.location.href);
    url.search = "";
    url.searchParams.set("game", gameId);
    url.searchParams.set(role === "host" ? "host" : "invite", token);
    return url.href;
  }

  function syncPrivateUrl() {
    const link = privateSessionUrl(currentRole);
    if (link) history.replaceState({}, "", link);
  }

  function inviteUrl(token) {
    return privateSessionUrl("player", token);
  }

  function hostUrl() {
    return privateSessionUrl("host");
  }

  function renderHostRecoveryLink() {
    const link = hostUrl();
    if (!link) return "";
    return `
      <div class="host-recovery">
        <div>
          <strong>Private host recovery link</strong>
          <span>Save this complete link to open Host controls in another browser. Anyone with it can manage the league.</span>
        </div>
        <div class="invite-tools">
          <input class="invite-link" value="${escapeHtml(link)}" readonly aria-label="Private host recovery link">
          <button class="copy-action" type="button" data-action="copy" data-link="${escapeHtml(link)}">Copy host link</button>
        </div>
      </div>
    `;
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
              link
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
          <p>${gameLength(data.game)} · ${money(data.game.startingCashCents)} per player · 24% simulated short-term tax</p>
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
      ${renderHostRecoveryLink()}
      <section class="seat-grid">${cards}</section>
      ${renderRules(data.game.periodBonusesEnabled === true, data.game.dividendsEnabled === true)}
    `;
  }

  function renderHostControls(data) {
    if (currentRole !== "host") return "";
    const tokens = invitationTokens();
    const cards = data.seats
      .map((seat) => {
        const token = tokens[String(seat.seatNumber)];
        const link = token ? inviteUrl(token) : "";
        return `
          <article class="seat-card${seat.joined ? " claimed" : ""}">
            <div class="seat-card-top">
              <div class="seat-card-person">
                ${renderPlayerAvatar(seat.playerName, "seat-avatar")}
                <div>
                  <strong>${seat.joined ? escapeHtml(seat.playerName) : `Seat ${seat.seatNumber}`}</strong>
                  <span>${seat.joined ? `${renderPlayerNickname(seat.playerName)} · Seat ${seat.seatNumber}` : "Open for a new player"}</span>
                </div>
              </div>
              <span class="seat-status">${seat.joined ? "Joined" : "Open"}</span>
            </div>
            ${
              link
                ? `<div class="invite-tools">
                    <input class="invite-link" value="${escapeHtml(link)}" readonly aria-label="${seat.joined ? escapeHtml(seat.playerName) : `Seat ${seat.seatNumber}`} private player link">
                    <button class="copy-action" type="button" data-action="copy" data-link="${escapeHtml(link)}">${seat.joined ? "Copy link" : "Invite"}</button>
                  </div>`
                : `<p class="missing-link">This device does not have the original private link. Make a replacement below; the portfolio and game history will stay intact.</p>`
            }
            <div class="seat-actions">
              <button class="secondary-action" type="button" data-action="replace-seat-link" data-seat="${seat.seatNumber}">
                ${link ? "Replace private link" : seat.joined ? "Recover private link" : "Create invite link"}
              </button>
            </div>
          </article>
        `;
      })
      .join("");
    return `
      <section class="panel host-panel">
        <div class="panel-heading host-panel-heading">
          <div>
            <p class="eyebrow">Host-only access</p>
            <h2>Players & private links</h2>
          </div>
          <span class="host-lock">Host token verified</span>
        </div>
        <p class="host-note">Resend a player’s existing link, or invite someone into any open seat. Replacing a link never changes that seat’s cash, trades, holdings, tax, dividends, or rank—but the old link will stop working.</p>
        ${renderHostRecoveryLink()}
        <div class="seat-grid host-seat-grid">${cards}</div>
        ${
          data.game.status === "active"
            ? `<div class="host-danger-zone">
                <div><strong>End this game</strong><span>Locks trading and records the final standings for everyone.</span></div>
                <button class="danger-action" type="button" data-action="end-game">End game now</button>
              </div>`
            : ""
        }
      </section>
    `;
  }

  function renderRules(bonusEnabled = false, dividendsEnabled = false) {
    return `
      <section class="panel rules-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">Game accounting</p><h2>Tap for the fine print</h2></div>
        </div>
        <div class="rules-grid">
          <details class="rule-item"><summary><strong>After-tax value</strong></summary><span>Cash + current holdings − reserved tax. This determines rank.</span></details>
          <details class="rule-item"><summary><strong>Tax reserve</strong></summary><span>24% of cumulative net realized gains, plus the game tax tracked on dividend income. A losing sale adds no capital-gains tax and can release tax reserved from earlier gains. Reserved cash cannot fund a new purchase.</span></details>
          <details class="rule-item"><summary><strong>FIFO basis</strong></summary><span>When shares are sold, the oldest purchase lots are treated as sold first.</span></details>
          <details class="rule-item"><summary><strong>Wash sales</strong></summary><span>A loss followed by a repurchase of the same ticker within 30 days is deferred into the new lot’s cost basis.</span></details>
          ${
            bonusEnabled
              ? "<details class=\"rule-item\"><summary><strong>Period bonuses</strong></summary><span>Completed New York-time periods award $100 daily, $1,000 weekly, and $10,000 monthly. Bonuses become spendable game cash and remain in the lifetime Bonus bank. Tied periods pay no bonus.</span></details>"
              : ""
          }
          ${
            dividendsEnabled
              ? "<details class=\"rule-item\"><summary><strong>Dividends</strong></summary><span>Cash dividends are credited on the payment date using the shares held before the ex-dividend date. A 24% game-tax reserve is withheld. Ex-dividend dates before this feature was enabled are not paid retroactively.</span></details>"
              : ""
          }
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
          `<option value="${escapeHtml(quote.symbol)}">${escapeHtml(quote.name)}</option>`,
      )
      .join("");
    if (!tradeSymbol) {
      tradeSymbol =
        data.you?.holdings?.[0]?.symbol ??
        data.market.symbols?.[0]?.symbol ??
        "";
    }
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
                <label class="game-field">
                  <span>Any U.S. stock or ETF ticker</span>
                  <div class="ticker-entry">
                    <input name="symbol" list="game-ticker-options" maxlength="10" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="AAPL" value="${escapeHtml(tradeSymbol)}" required>
                    <button class="secondary-action" type="button" data-action="get-quote">Check price</button>
                  </div>
                  <datalist id="game-ticker-options">${symbolOptions}</datalist>
                </label>
                <label class="game-field"><span>Shares</span><input name="shares" type="number" min="0.000001" step="0.000001" inputmode="decimal" placeholder="0" required></label>
                <div class="market-closed" data-quote-context>Enter any ticker, then check its newest available price.</div>
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
    const winnerSeat = data.game.winnerSeatId || "";
    return `<div class="leaderboard-list">${data.leaderboard
      .map(
        (player) => `
          <details class="leaderboard-row${player.seatId === youSeat ? " you" : ""}">
            <summary>
              <span class="rank-number">${player.rank}</span>
              ${renderPlayerAvatar(player.playerName, "leader-avatar")}
              <span class="leader-name"><strong>${escapeHtml(player.playerName)} ${renderPlayerNickname(player.playerName)}${player.seatId === youSeat ? " · You" : ""}${player.seatId === winnerSeat ? " · Champion" : ""}</strong><span>${player.holdings.length} position${player.holdings.length === 1 ? "" : "s"}${player.bonusCents ? ` · ${money(player.bonusCents)} bonuses` : ""}${player.dividendIncomeCents ? ` · ${money(player.dividendIncomeCents)} dividends` : ""} · Tap to view</span></span>
              <span class="leader-metric"><span>After tax</span><strong>${money(player.afterTaxCents)}</strong></span>
              <span class="leader-metric cash"><span>Cash</span><strong>${money(player.spendableCashCents)}</strong></span>
              <span class="leader-metric tax"><span>Return</span><strong class="${gainClass(player.returnPercent)}">${percent(player.returnPercent)}</strong></span>
            </summary>
            <div class="leader-expanded">
              <div class="leader-expanded-profile">
                ${renderPlayerAvatar(player.playerName, "leader-expanded-avatar")}
                <div>
                  <span>Player portfolio</span>
                  <strong>${escapeHtml(player.playerName)}</strong>
                  <small>${money(player.afterTaxCents)} after tax · ${percent(player.returnPercent)} return</small>
                </div>
              </div>
              <div class="leader-expanded-positions">
                <div class="leader-expanded-heading">
                  <strong>Current positions</strong>
                  <span>${player.holdings.length ? `${player.holdings.length} holding${player.holdings.length === 1 ? "" : "s"}` : "No holdings"}</span>
                </div>
                <div class="leader-position-grid">
                  ${
                    player.holdings.length
                      ? player.holdings
                          .map(
                            (holding) => `
                              <article class="leader-position-card">
                                <div class="leader-position-title">
                                  <strong>${escapeHtml(holding.symbol)}</strong>
                                  <span>${escapeHtml(holding.name)}</span>
                                </div>
                                <div class="leader-position-metrics">
                                  <span>Shares<strong>${shares(holding.shares)}</strong></span>
                                  <span>Value<strong>${money(holding.marketValueCents)}</strong></span>
                                  <span>Gain<strong class="${gainClass(holding.unrealizedCents)}">${signedMoney(holding.unrealizedCents)}</strong></span>
                                </div>
                              </article>
                            `,
                          )
                          .join("")
                      : `<div class="leader-all-cash">All ${money(player.spendableCashCents)} is currently held as spendable cash.</div>`
                  }
                </div>
              </div>
            </div>
          </details>
        `,
      )
      .join("")}</div>`;
  }

  function renderPlayerTrends(data) {
    const trends = data.playerTrends ?? [];
    if (!trends.length) return "";
    if (
      trendSelection !== "all" &&
      !trends.some((trend) => trend.seatId === trendSelection)
    ) {
      trendSelection = "all";
    }
    const rangeFor = (trend) =>
      trend.ranges?.[trendRange] ?? {
        points: trend.points ?? [],
        changeCents: trend.changeCents ?? 0,
        changePercent: trend.changePercent ?? 0,
        direction: trend.direction ?? "up",
      };
    const supportsRanges = trends.some((trend) => trend.ranges);
    const playerButtons = trends
      .map((trend) => {
        const range = rangeFor(trend);
        return `
          <button
            class="trend-chip ${range.direction}${trendSelection === trend.seatId ? " active" : ""}"
            type="button"
            data-action="trend-player"
            data-seat="${escapeHtml(trend.seatId)}"
            aria-pressed="${trendSelection === trend.seatId}"
          >
            ${renderPlayerAvatar(trend.playerName, "trend-avatar")}
            <span>${escapeHtml(trend.playerName)}</span>
            <strong>${percent(range.changePercent)}</strong>
          </button>
        `;
      })
      .join("");
    const rangeButtons = [
      ["day", "Day"],
      ["week", "Week"],
      ["month", "Month"],
      ["max", "Max"],
    ]
      .map(
        ([value, label]) => `
          <button
            class="${trendRange === value ? "active" : ""}"
            type="button"
            data-action="trend-range"
            data-range="${value}"
            aria-pressed="${trendRange === value}"
          >${label}</button>
        `,
      )
      .join("");
    const supportsBonuses =
      data.game.periodBonusesEnabled === true;
    const periodLeader = (label, leader, bonus) =>
      leader
        ? `<div class="period-leader">
            <span>${label} · ${supportsBonuses ? `${bonus} bonus` : "live"}</span>
            <strong>${escapeHtml(leader.playerName)}</strong>
            <small class="${gainClass(leader.changePercent)}">${percent(leader.changePercent)}</small>
          </div>`
        : "";
    const selectedRankings = data.periodRankings?.[trendRange] ?? [];
    const rangeLabel = {
      day: "Daily",
      week: "Weekly",
      month: "Monthly",
      max: "Overall period",
    }[trendRange];
    const rankings = selectedRankings.length
      ? `<div class="period-ranking">
          <div class="period-ranking-title">
            <strong>${rangeLabel} rankings</strong>
            <span>Ranked by percentage growth</span>
          </div>
          <div class="period-ranking-list">
            ${selectedRankings
              .map(
                (player) => `
                  <div class="period-ranking-row">
                    <span>${player.rank}</span>
                    <strong>${escapeHtml(player.playerName)}</strong>
                    <small class="${gainClass(player.changePercent)}">${percent(player.changePercent)} · ${signedMoney(player.changeCents)}</small>
                  </div>`,
              )
              .join("")}
          </div>
        </div>`
      : "";
    return `
      <section class="panel trend-panel">
        <div class="panel-heading trend-heading">
          <div>
            <p class="eyebrow">Portfolio history</p>
            <h2>Player trends</h2>
          </div>
          <p>After-tax value · updated every 30 minutes</p>
        </div>
        ${
          data.periodLeaders?.day ||
          data.periodLeaders?.week ||
          data.periodLeaders?.month
            ? `<div class="period-leaders">
                ${periodLeader("Daily leader", data.periodLeaders?.day, "$100")}
                ${periodLeader("Weekly leader", data.periodLeaders?.week, "$1K")}
                ${periodLeader("Monthly leader", data.periodLeaders?.month, "$10K")}
              </div>`
            : ""
        }
        ${
          supportsRanges
            ? `<div class="trend-range-tabs" role="group" aria-label="Choose trend time range">${rangeButtons}</div>`
            : ""
        }
        <div class="trend-toolbar" role="group" aria-label="Choose player trend lines">
          <button
            class="trend-chip all${trendSelection === "all" ? " active" : ""}"
            type="button"
            data-action="trend-player"
            data-seat="all"
            aria-pressed="${trendSelection === "all"}"
          >
            <span class="trend-chip-stack" aria-hidden="true"></span>
            <span>All players</span>
          </button>
          ${playerButtons}
        </div>
        <div class="trend-chart-shell">
          <canvas
            class="trend-canvas"
            id="player-trend-chart"
            role="img"
            aria-label="After-tax portfolio value trend lines for the family game"
          ></canvas>
        </div>
        ${rankings}
        <p class="trend-note"><span class="trend-key up"></span> Green gained over the selected period. <span class="trend-key down"></span> Red declined. Tap a player to isolate their line.</p>
      </section>
    `;
  }

  function renderBonusBank(data) {
    if (
      data.game.periodBonusesEnabled !== true ||
      !Array.isArray(data.bonusAwards)
    ) {
      return "";
    }
    const players = [...data.leaderboard].sort(
      (left, right) =>
        Number(right.bonusCents || 0) - Number(left.bonusCents || 0),
    );
    const totals = players
      .map(
        (player) => `
          <div class="bonus-total-row">
            <strong>${escapeHtml(player.playerName)}</strong>
            <span>${money(player.bonusCents || 0)}</span>
          </div>`,
      )
      .join("");
    const history = data.bonusAwards.length
      ? `<details class="bonus-history">
          <summary>All award history (${data.bonusAwards.length})</summary>
          <div class="bonus-history-list">
            ${data.bonusAwards
              .map(
                (award) => `
                  <div class="bonus-award-row">
                    <span><strong>${escapeHtml(award.playerName)}</strong> won the ${escapeHtml(award.periodType)}</span>
                    <span>${escapeHtml(award.periodKey)}</span>
                    <strong>${money(award.bonusCents)}</strong>
                  </div>`,
              )
              .join("")}
          </div>
        </details>`
      : '<div class="empty-compact">No completed period bonuses yet.</div>';
    return `
      <section class="panel bonus-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">Lifetime rewards</p><h2>Bonus bank</h2></div>
          <p>Bonuses stay recorded after they are spent</p>
        </div>
        <div class="bonus-total-list">${totals}</div>
        ${history}
      </section>
    `;
  }

  function renderDividendLedger(data) {
    if (
      data.game.dividendsEnabled !== true ||
      !Array.isArray(data.dividendPayments)
    ) {
      return "";
    }
    const totals = [...data.leaderboard]
      .sort(
        (left, right) =>
          Number(right.dividendIncomeCents || 0) -
          Number(left.dividendIncomeCents || 0),
      )
      .map(
        (player) => `
          <div class="bonus-total-row">
            <strong>${escapeHtml(player.playerName)}</strong>
            <span>${money(player.dividendIncomeCents || 0)}</span>
          </div>`,
      )
      .join("");
    const history = data.dividendPayments.length
      ? `<details class="bonus-history">
          <summary>All dividend payments (${data.dividendPayments.length})</summary>
          <div class="bonus-history-list">
            ${data.dividendPayments
              .map(
                (payment) => `
                  <div class="dividend-payment-row">
                    <span><strong>${escapeHtml(payment.playerName)}</strong> · ${escapeHtml(payment.symbol)}</span>
                    <span>${shares(payment.shares)} shares × ${dollars(payment.amountPerShare)}</span>
                    <span>Paid ${escapeHtml(payment.paymentDate)} · ${money(payment.taxCents)} tax reserved</span>
                    <strong>${money(payment.grossCents)}</strong>
                  </div>`,
              )
              .join("")}
          </div>
        </details>`
      : '<div class="empty-compact">No dividend payments yet. Eligible cash dividends will appear here automatically on their payment date.</div>';
    return `
      <section class="panel bonus-panel dividend-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">Portfolio income</p><h2>Dividend ledger</h2></div>
          <p>Gross cash credited · 24% game-tax reserve tracked separately</p>
        </div>
        <div class="bonus-total-list">${totals}</div>
        ${history}
      </section>
    `;
  }

  function drawPlayerTrends(data) {
    const canvas = document.querySelector("#player-trend-chart");
    if (!canvas) return;
    const allTrends = (data.playerTrends ?? []).map((trend) => ({
      ...trend,
      ...(trend.ranges?.[trendRange] ?? {
        points: trend.points ?? [],
        changeCents: trend.changeCents ?? 0,
        changePercent: trend.changePercent ?? 0,
        direction: trend.direction ?? "up",
      }),
    }));
    const trends =
      trendSelection === "all"
        ? allTrends
        : allTrends.filter((trend) => trend.seatId === trendSelection);
    const chartPoints = trends.flatMap((trend) => trend.points ?? []);
    if (!chartPoints.length) return;

    const bounds = canvas.getBoundingClientRect();
    const width = Math.max(280, Math.round(bounds.width));
    const height = Math.max(170, Math.round(bounds.height));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);

    const padding = { top: 16, right: 14, bottom: 25, left: 54 };
    const plotWidth = width - padding.left - padding.right;
    const plotHeight = height - padding.top - padding.bottom;
    const values = chartPoints.map((point) => Number(point.valueCents));
    const times = chartPoints.map((point) => Number(point.at));
    let minimum = Math.min(...values);
    let maximum = Math.max(...values);
    const valueRange = Math.max(maximum - minimum, 20_000);
    minimum -= valueRange * 0.1;
    maximum += valueRange * 0.1;
    const timeStart = Math.min(...times);
    const timeEnd = Math.max(...times);
    const timeRange = Math.max(timeEnd - timeStart, 1);
    const xFor = (at) =>
      padding.left + ((Number(at) - timeStart) / timeRange) * plotWidth;
    const yFor = (value) =>
      padding.top +
      ((maximum - Number(value)) / (maximum - minimum)) * plotHeight;

    context.font =
      '600 9px Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    context.textBaseline = "middle";
    for (let line = 0; line < 4; line += 1) {
      const progress = line / 3;
      const y = padding.top + plotHeight * progress;
      const value = maximum - (maximum - minimum) * progress;
      context.beginPath();
      context.strokeStyle = "rgba(207, 230, 220, 0.13)";
      context.lineWidth = 1;
      context.moveTo(padding.left, y);
      context.lineTo(width - padding.right, y);
      context.stroke();
      context.fillStyle = "rgba(202, 219, 211, 0.58)";
      context.textAlign = "right";
      context.fillText(compactMoney(value), padding.left - 8, y);
    }

    const dashPatterns = [[], [8, 4], [2, 3], [11, 4, 2, 4]];
    trends.forEach((trend, index) => {
      const points = trend.points ?? [];
      if (!points.length) return;
      const isYou = data.you?.seatId === trend.seatId;
      context.beginPath();
      points.forEach((point, pointIndex) => {
        const x = xFor(point.at);
        const y = yFor(point.valueCents);
        if (pointIndex === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.strokeStyle =
        trend.direction === "up" ? "#77e35a" : "#ff6472";
      context.globalAlpha =
        trendSelection !== "all" || isYou || !data.you ? 1 : 0.66;
      context.lineWidth = isYou && trendSelection === "all" ? 3.2 : 2.2;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.setLineDash(dashPatterns[index % dashPatterns.length]);
      context.stroke();

      const lastPoint = points.at(-1);
      context.setLineDash([]);
      context.beginPath();
      context.arc(
        xFor(lastPoint.at),
        yFor(lastPoint.valueCents),
        isYou ? 4 : 3,
        0,
        Math.PI * 2,
      );
      context.fillStyle =
        trend.direction === "up" ? "#77e35a" : "#ff6472";
      context.fill();
    });
    context.globalAlpha = 1;
    context.setLineDash([]);
    context.fillStyle = "rgba(202, 219, 211, 0.58)";
    context.textBaseline = "bottom";
    context.textAlign = "left";
    context.fillText(dateTime(timeStart), padding.left, height - 3);
    context.textAlign = "right";
    context.fillText(dateTime(timeEnd), width - padding.right, height - 3);
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
                  ? ` · <span class="${gainClass(trade.realizedGainCents)}" style="display:inline">${signedMoney(trade.realizedGainCents)} realized${trade.realizedGainCents < 0 ? " · no tax added" : trade.taxDeltaCents > 0 ? ` · ${money(trade.taxDeltaCents)} tax reserved` : " · offset by losses"}</span>`
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
      <div class="identity-banner ${you ? "player" : "host"}">
        ${you ? renderPlayerAvatar(you.playerName, "identity-avatar") : ""}
        <span>${you ? "Playing as" : "Private host session"}</span>
        <strong>${you ? `${escapeHtml(you.playerName)} ${renderPlayerNickname(you.playerName)}` : "HOST CONTROLS"}</strong>
        <small>${you ? `Seat ${you.seatNumber} · Only trades from this private link affect ${escapeHtml(you.playerName)}’s portfolio.` : "Only this verified host link can manage players or end the game. Player links never see these controls."}</small>
      </div>
      <div class="game-topline">
        <div class="game-title">
          <span class="state-pill ${stateClass}">${escapeHtml(data.game.status)}</span>
          <h1>${escapeHtml(data.game.name)}</h1>
          <p>${countdown(data.game)} · ${joined} player${joined === 1 ? "" : "s"} · Quotes updated ${dateTime(data.market.generatedAt)}</p>
        </div>
        <div class="game-actions">
          <button class="secondary-action" type="button" data-action="refresh">Refresh</button>
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
          <small>${you ? "Capital gains + dividend tax" : "Up to eight family members"}</small>
        </div>
        <div class="game-board-cell game-board-metric rank">
          <span>${you ? "Your rank" : "Time left"}</span>
          <strong>${you ? `#${you.rank} / ${joined}` : countdown(data.game)}</strong>
          <small>${
            data.game.status === "ended"
              ? "Game complete"
              : data.game.targetValueCents
                ? `Ends at ${money(data.game.targetValueCents)}`
                : data.game.endsAt
                  ? `Ends ${dateTime(data.game.endsAt)}`
                  : "No scheduled end"
          }</small>
        </div>
      </section>
      ${renderHostControls(data)}
      ${renderPlayerTrends(data)}
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
      ${renderBonusBank(data)}
      ${renderDividendLedger(data)}
      ${
        you
          ? `<section class="panel leaderboard-panel"><div class="panel-heading"><div><p class="eyebrow">League tape</p><h2>Recent activity</h2></div></div>${renderActivity(data.recentTrades)}</section>`
          : ""
      }
      ${renderRules(data.game.periodBonusesEnabled === true, data.game.dividendsEnabled === true)}
    `;
    updateTradePreview();
    drawPlayerTrends(data);
  }

  function updateTradePreview() {
    const form = document.querySelector("#trade-form");
    if (!form || !snapshot) return;
    const symbol = form.elements.symbol.value.trim().toUpperCase();
    tradeSymbol = symbol;
    const quantity = Number(form.elements.shares.value || 0);
    const quote =
      checkedQuotes.get(symbol) ??
      snapshot.market.symbols.find((item) => item.symbol === symbol);
    const holding = snapshot.you?.holdings?.find((item) => item.symbol === symbol);
    form.querySelector("[data-trade-price]").textContent = quote?.priceCents
      ? money(quote.priceCents)
      : "Check price";
    form.querySelector("[data-quote-context]").textContent = quote
      ? `${quote.name ?? symbol} · ${quote.source ?? snapshot.market.sessionLabel} · ${dateTime(quote.generatedAt ?? snapshot.market.generatedAt)}`
      : "Enter any U.S.-listed stock or ETF ticker, then check its newest available price.";
    form.querySelector("[data-trade-value]").textContent =
      quote?.priceCents && quantity > 0
        ? money(Math.round(quote.priceCents * quantity))
        : money(0);
    form.querySelector("[data-trade-limit]").textContent =
      tradeSide === "buy"
        ? money(snapshot.you?.spendableCashCents)
        : `${shares(holding?.shares)} shares`;
  }

  function rememberQuote(quote) {
    tradeSymbol = quote.symbol;
    checkedQuotes.set(quote.symbol, quote);
    const existingIndex = snapshot.market.symbols.findIndex(
      (item) => item.symbol === quote.symbol,
    );
    if (existingIndex >= 0) {
      snapshot.market.symbols[existingIndex] = quote;
    } else {
      snapshot.market.symbols.push(quote);
    }
  }

  async function refresh({ quiet = false } = {}) {
    if (quiet && refreshInFlight) return;
    if (!gameId) {
      try {
        const health = await apiRequest("POST", { action: "health" });
        serviceCapabilities = health.capabilities ?? null;
      } catch {
        serviceCapabilities = null;
      }
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
          <p>This address identifies the league but does not grant access. Ask the host for your complete private player link, or use the complete host recovery link saved from Host controls.</p>
          <a class="secondary-action" href="./game.html" style="display:grid;place-items:center;text-decoration:none">Start a new game</a>
        </div></section>`;
      return;
    }
    refreshInFlight = true;
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
    } finally {
      refreshInFlight = false;
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
        const endCondition = String(values.get("endCondition") ?? "30");
        const result = await apiRequest(
          "POST",
          {
            action: "create",
            name: values.get("name"),
            startingCash: values.get("startingCash"),
            endCondition: endCondition === "goal" ? "goal" : "duration",
            durationDays:
              endCondition === "goal" ? 0 : Number(endCondition),
            targetValue:
              endCondition === "goal" ? values.get("targetValue") : null,
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
        const symbol = String(values.get("symbol") ?? "")
          .trim()
          .toUpperCase();
        const knownQuote =
          checkedQuotes.get(symbol) ??
          snapshot.market.symbols.find((item) => item.symbol === symbol);
        if (!knownQuote) {
          const quoted = await apiRequest("POST", {
            action: "quote",
            gameId,
            symbol,
          });
          rememberQuote(quoted.quote);
          form.elements.symbol.value = quoted.quote.symbol;
          updateTradePreview();
          setFormStatus(
            form,
            `${quoted.quote.name} is ${money(quoted.quote.priceCents)} as of ${dateTime(quoted.quote.generatedAt)}. Review it, then press ${tradeSide === "buy" ? "Buy" : "Sell"} again.`,
          );
          return;
        }
        const result = await apiRequest("POST", {
          action: "trade",
          gameId,
          side: tradeSide,
          symbol,
          shares: values.get("shares"),
        });
        await refresh({ quiet: true });
        const saleTaxNote =
          tradeSide !== "sell"
            ? ""
            : result.trade.realizedGainCents < 0
              ? ` Realized loss: ${signedMoney(result.trade.realizedGainCents)}. No tax added${
                  result.trade.taxDeltaCents < 0
                    ? `; ${money(Math.abs(result.trade.taxDeltaCents))} was released from the tax reserve`
                    : ""
                }.`
              : result.trade.taxDeltaCents > 0
                ? ` Realized gain: ${signedMoney(result.trade.realizedGainCents)}; ${money(result.trade.taxDeltaCents)} added to the tax reserve.`
                : ` Realized gain: ${signedMoney(result.trade.realizedGainCents)}; prior losses offset the tax.`;
        showToast(
          `${tradeSide === "buy" ? "Bought" : "Sold"} ${shares(result.trade.shares)} ${result.trade.symbol} at ${money(result.trade.priceCents)}.${saleTaxNote}`,
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
    if (event.target.name === "symbol") {
      event.target.value = event.target.value.toUpperCase();
    }
    if (event.target.closest("#trade-form")) updateTradePreview();
    if (event.target.name === "startingCash") updateCreateGoalFields();
  });

  root.addEventListener("change", (event) => {
    if (event.target.closest("#trade-form")) updateTradePreview();
    if (event.target.name === "endCondition") updateCreateGoalFields();
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
        showToast("Private link copied.");
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
        const priorToken = tokens[String(seatNumber)];
        tokens[String(seatNumber)] = result.token;
        saveInvitationTokens(tokens);
        if (priorToken && getStored("player") === priorToken) {
          setStored("player", result.token);
        }
        await refresh({ quiet: true });
        showToast(`Seat ${seatNumber} now has a new private link.`);
      } else if (action === "replace-seat-link") {
        const seatNumber = Number(button.dataset.seat);
        const seat = snapshot.seats.find((item) => item.seatNumber === seatNumber);
        const warning = seat?.joined
          ? `Replace ${seat.playerName}’s private link? Their old link will stop working, but their complete portfolio and game history will stay unchanged.`
          : `Replace the invitation for open seat ${seatNumber}? The older invitation will stop working.`;
        if (!window.confirm(warning)) return;
        button.disabled = true;
        const result = await apiRequest("POST", {
          action: "replaceSeatLink",
          gameId,
          seatNumber,
        });
        const tokens = invitationTokens();
        const priorToken = tokens[String(seatNumber)];
        tokens[String(seatNumber)] = result.token;
        saveInvitationTokens(tokens);
        if (priorToken && getStored("player") === priorToken) {
          setStored("player", result.token);
        }
        await refresh({ quiet: true });
        showToast(
          `${seat?.playerName || `Seat ${seatNumber}`} now has a new private link. The portfolio was not changed.`,
        );
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
      } else if (action === "trend-player") {
        trendSelection = button.dataset.seat || "all";
        document.querySelectorAll(".trend-chip").forEach((chip) => {
          const isActive = chip.dataset.seat === trendSelection;
          chip.classList.toggle("active", isActive);
          chip.setAttribute("aria-pressed", String(isActive));
        });
        drawPlayerTrends(snapshot);
      } else if (action === "trend-range") {
        trendRange = ["day", "week", "month", "max"].includes(
          button.dataset.range,
        )
          ? button.dataset.range
          : "day";
        renderGame(snapshot);
      } else if (action === "get-quote") {
        const form = button.closest("#trade-form");
        const symbol = form?.elements.symbol.value.trim().toUpperCase();
        if (!symbol) throw new Error("Enter a ticker first.");
        button.disabled = true;
        setFormStatus(form, `Checking the latest price for ${symbol}…`);
        const result = await apiRequest("POST", {
          action: "quote",
          gameId,
          symbol,
        });
        tradeSymbol = result.quote.symbol;
        form.elements.symbol.value = result.quote.symbol;
        rememberQuote(result.quote);
        updateTradePreview();
        setFormStatus(
          form,
          `${result.quote.name} · ${money(result.quote.priceCents)} as of ${dateTime(result.quote.generatedAt)}.`,
        );
        button.disabled = false;
      } else if (action === "sell-holding") {
        tradeSide = "sell";
        tradeSymbol = button.dataset.symbol;
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
    syncPrivateUrl();
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
    if (trendResizeTimer) window.clearTimeout(trendResizeTimer);
  });

  window.addEventListener("resize", () => {
    if (trendResizeTimer) window.clearTimeout(trendResizeTimer);
    trendResizeTimer = window.setTimeout(() => {
      if (snapshot) drawPlayerTrends(snapshot);
    }, 120);
  });
})();
