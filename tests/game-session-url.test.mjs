import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const gameSource = readFileSync(new URL("../site/game.js", import.meta.url), "utf8");
const gameId = "b42e9743-1f0c-4957-ad5c-83d490e12f65";

function bootGame({ search, stored = {} }) {
  const values = new Map(Object.entries(stored));
  const replacedUrls = [];
  const root = { addEventListener() {}, innerHTML: "" };
  const roleSwitch = { addEventListener() {}, hidden: true, textContent: "" };
  const sessionChip = { classList: { toggle() {} } };
  const sessionLabel = { textContent: "" };
  const href = `https://kleinlab-yale.github.io/stocks/game.html${search}`;

  const context = {
    URL,
    URLSearchParams,
    console,
    document: {
      visibilityState: "visible",
      querySelector(selector) {
        if (selector === "#game-root") return root;
        if (selector === "#role-switch") return roleSwitch;
        if (selector === "#game-session-chip") return sessionChip;
        if (selector === "#game-session-label") return sessionLabel;
        if (selector === 'meta[name="tickerquest-game-api"]') {
          return { getAttribute: () => "https://example.test/api/game" };
        }
        return null;
      },
    },
    fetch: () => new Promise(() => {}),
    history: {
      replaceState(_state, _title, url) {
        replacedUrls.push(String(url));
      },
    },
    localStorage: {
      getItem(key) {
        return values.get(key) ?? null;
      },
      removeItem(key) {
        values.delete(key);
      },
      setItem(key, value) {
        values.set(key, String(value));
      },
    },
    window: {
      addEventListener() {},
      clearInterval() {},
      clearTimeout() {},
      location: {
        href,
        hostname: "kleinlab-yale.github.io",
        protocol: "https:",
        search,
      },
      setInterval: () => 1,
      setTimeout: () => 1,
    },
  };

  vm.runInNewContext(gameSource, context);
  return { replacedUrls, values };
}

test("restores both creator credentials to a bare saved-game URL", () => {
  const hostToken = "private-host-token";
  const creatorToken = "seat-one-player-token";
  const { replacedUrls } = bootGame({
    search: `?game=${gameId}`,
    stored: {
      [`tickerquest:game:${gameId}:host`]: hostToken,
      [`tickerquest:game:${gameId}:player`]: creatorToken,
      [`tickerquest:game:${gameId}:role`]: "host",
    },
  });
  const privateUrl = new URL(replacedUrls.at(-1));

  assert.equal(privateUrl.searchParams.get("game"), gameId);
  assert.equal(privateUrl.searchParams.get("host"), hostToken);
  assert.equal(privateUrl.searchParams.get("creator"), creatorToken);
  assert.equal(privateUrl.searchParams.has("invite"), false);
});

test("a complete creator link saves both required credentials", () => {
  const hostToken = "private-host-token";
  const creatorToken = "seat-one-player-token";
  const { replacedUrls, values } = bootGame({
    search: `?game=${gameId}&host=${hostToken}&creator=${creatorToken}`,
  });
  const privateUrl = new URL(replacedUrls.at(-1));

  assert.equal(privateUrl.searchParams.get("host"), hostToken);
  assert.equal(privateUrl.searchParams.get("creator"), creatorToken);
  assert.equal(values.get(`tickerquest:game:${gameId}:host`), hostToken);
  assert.equal(values.get(`tickerquest:game:${gameId}:player`), creatorToken);
});

test("keeps a player invitation in the address bar and saves it for the league", () => {
  const inviteToken = "private-player-token";
  const { replacedUrls, values } = bootGame({
    search: `?game=${gameId}&invite=${inviteToken}`,
  });
  const privateUrl = new URL(replacedUrls.at(-1));

  assert.equal(privateUrl.searchParams.get("game"), gameId);
  assert.equal(privateUrl.searchParams.get("invite"), inviteToken);
  assert.equal(
    values.get(`tickerquest:game:${gameId}:player`),
    inviteToken,
  );
});
