// End-to-end check of clop-sheet-sync.user.js in a real Chromium.
//
// The game is a fake served from fixtures (the page markup is the live game's) that remembers which
// nation the session is on, the sheet is a fake Apps Script endpoint loaded from the two TSV
// exports in fixtures/, and Tampermonkey's GM_* API is shimmed. Run with:  node test/run.mjs
//
// The script spaces its game requests a second apart, so a full run takes a couple of minutes.
// Needs Playwright. It is resolved from the project, then from the global npm root.

import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(here, "fixtures", name), "utf8");
const userscript = readFileSync(path.join(here, "..", "clop-sheet-sync.user.js"), "utf8");

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require("playwright");
  } catch {
    const root = execSync("npm root -g").toString().trim();
    return require(path.join(root, "playwright"));
  }
}
const { chromium } = loadPlaywright();

// ---------------------------------------------------------------------------------------------
// Fake sheet

function parseTsv(source) {
  return source.replace(/\r/g, "").split("\n").filter((line, i, all) => i < all.length - 1 || line)
    .map((line) => line.split("\t").map((raw) => {
      const value = raw.trim();
      if (/\d/.test(value) && /^-?[\d ]+$/.test(value)) return Number(value.replace(/ /g, ""));
      return value;
    }));
}

const columnIndex = (letters) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
function bounds(a1) {
  const [start, end = start] = a1.split(":");
  const parse = (ref) => {
    const [, letters, digits] = /^([A-Z]+)(\d+)$/.exec(ref);
    return [Number(digits) - 1, columnIndex(letters)];
  };
  const [r0, c0] = parse(start);
  const [r1, c1] = parse(end);
  return { r0, c0, r1, c1 };
}

class FakeSheet {
  constructor(tabs, { batch = true } = {}) {
    this.tabs = tabs;
    this.batch = batch;
    this.log = [];
  }
  get(tab, a1) {
    const { r0, c0 } = bounds(a1);
    const value = this.tabs[tab][r0] && this.tabs[tab][r0][c0];
    return value === undefined ? "" : value;
  }
  set(tab, a1, value) {
    const grid = this.tabs[tab];
    const { r0, c0 } = bounds(a1);
    while (grid.length <= r0) grid.push([]);
    grid[r0][c0] = value;
  }
  runOne(op) {
    const grid = this.tabs[op.tab];
    if (!grid) return { ok: false, error: "no such tab: " + op.tab };
    const { r0, c0, r1, c1 } = bounds(op.range);
    if (op.action === "read") {
      const values = [];
      for (let r = r0; r <= r1; r++) {
        const line = [];
        for (let c = c0; c <= c1; c++) {
          const v = grid[r] && grid[r][c];
          line.push(v === undefined ? "" : v);
        }
        values.push(line);
      }
      return { ok: true, values };
    }
    if (op.action === "write") {
      if (op.values.length !== r1 - r0 + 1 || op.values.some((line) => line.length !== c1 - c0 + 1)) {
        return { ok: false, error: "The number of rows in the data does not match the range" };
      }
      this.log.push(op);
      op.values.forEach((line, i) => line.forEach((v, j) => {
        while (grid.length <= r0 + i) grid.push([]);
        // Sheets consumes the leading apostrophe and stores text.
        grid[r0 + i][c0 + j] = typeof v === "string" && v.startsWith("'") ? v.slice(1) : v;
      }));
      return { ok: true, values: op.values };
    }
    return { ok: false, error: "unknown action: " + op.action };
  }
  handle(request) {
    if (request.action === "batch") {
      if (!this.batch) return { ok: false, error: "no such tab: undefined" }; // what the old script says
      return { ok: true, results: request.ops.map((op) => this.runOne(op)) };
    }
    const single = this.runOne(request);
    return single.ok ? { ok: true, values: single.values } : single;
  }
}

function freshSheet(options) {
  return new FakeSheet({
    "Dashboard-Stockpile": parseTsv(fixture("dashboard-stockpile.tsv")),
    VladihoofstockZ: parseTsv(fixture("nation-tab.tsv")),
    LanathesisZ: parseTsv(fixture("nation-tab.tsv")),
  }, options);
}

// ---------------------------------------------------------------------------------------------
// Fake game: one session, which remembers its active nation like the real one

const SERVER_TIME = "2026-10-21 00:43:34";
const VLAD = { id: 16, name: "Vladihoofstock" };
const LANA = { id: 3, name: "Lanathesis" };

/** Lanathesis's overview: the same page shape, with its own name, id and apples. */
const overviewFor = (nation) => nation.id === VLAD.id
  ? fixture("overview.content.html")
  : fixture("overview.content.html")
    .replace("<h3>Vladihoofstock</h3>", `<h3>${nation.name}</h3>`)
    .replace("nation_id=16", `nation_id=${nation.id}`)
    .replace('<span class="text-success">20,868</span>', '<span class="text-success">11,111</span>');

class FakeGame {
  constructor({ nations = [VLAD], loggedOut = false, extraForces = false, deals = (html) => html } = {}) {
    this.nations = nations;
    this.active = nations[0].id;
    this.loggedOut = loggedOut;
    this.extraForces = extraForces;
    this.deals = deals;
    this.log = [];
  }
  get activeNation() {
    return this.nations.find((nation) => nation.id === this.active);
  }
  page(title, content, { loggedIn = true } = {}) {
    const nationLine = this.nations.length === 1
      ? `<li><a>${this.activeNation.name}</a></li>`
      : `<li><a><form action="" method="post"><select name="switchnation_id" onchange='this.form.submit()'>` +
        this.nations.map((n) => `<option value="${n.id}"${n.id === this.active ? " selected " : ""}>${n.name}</option>`).join("") +
        `</select></form></a></li>`;
    let html = fixture("chrome.html")
      .replace("{{TITLE}}", title)
      .replace("{{NATIONLINE}}", nationLine)
      .replace("{{SERVERTIME}}", SERVER_TIME)
      .replace("{{CONTENT}}", content);
    if (!loggedIn) html = html.replace('<li><a href="logout.php">Logout</a></li>', "");
    return html;
  }
  /** Answer one request: {contentType, body}. A POSTed switchnation_id switches, as allfunctions.php does. */
  handle(method, url, body) {
    const name = new URL(url).pathname.replace(/^\//, "");
    const form = new URLSearchParams(body || "");
    if (name.endsWith(".php")) this.log.push({ at: Date.now(), method, name, form: Object.fromEntries(form) });
    const switchTo = parseInt(form.get("switchnation_id"), 10);
    if (method === "POST" && this.nations.some((nation) => nation.id === switchTo)) this.active = switchTo;

    const html = (text) => ({ contentType: "text/html", body: text });
    if (name === "api/public/v1.php") return { contentType: "application/json", body: fixture("api.json") };
    if (this.loggedOut && name === "overview.php") return html(this.page("Login", "<center>Please log in.</center>", { loggedIn: false }));
    if (name === "overview.php") return html(this.page("Overview", overviewFor(this.activeNation)));
    if (name === "deals.php") return html(this.page("Deals", this.deals(fixture("deals.content.html"))));
    if (name === "groupforces.php") {
      return html(this.page("Group Forces", fixture(this.extraForces ? "groupforces-extra.content.html" : "groupforces.content.html")));
    }
    if (name === "userinfo.php") return html(this.page("User Info", fixture("userinfo.content.html")));
    return html(this.page("News", "<center>news</center>"));
  }
}

// ---------------------------------------------------------------------------------------------
// Harness

const shims = `
  (() => {
    const store = () => JSON.parse(localStorage.getItem("__gm") || "{}");
    const listeners = {};
    window.GM_getValue = (key, fallback) => (key in store() ? store()[key] : fallback);
    window.GM_setValue = (key, value) => {
      const all = store();
      const old = all[key];
      all[key] = value;
      localStorage.setItem("__gm", JSON.stringify(all));
      for (const listener of listeners[key] || []) listener(key, old, value, false);
    };
    window.GM_addValueChangeListener = (key, listener) => (listeners[key] = listeners[key] || []).push(listener);
    window.GM_xmlhttpRequest = (details) => {
      const call = /script\\.google/.test(details.url)
        ? window.__sheetCall(details.data).then((body) => ({ status: 200, body }))
        : window.__gameCall(details.method, details.url, details.data || "");
      call.then(
        (reply) => details.onload({ status: reply.status, responseText: reply.body, finalUrl: details.url }),
        () => details.onerror({}));
    };
  })();
  document.addEventListener("DOMContentLoaded", () => { ${userscript} });
`;

async function open(browser, sheet, game = new FakeGame()) {
  const context = await browser.newContext();
  const tab = await context.newPage();
  tab.on("pageerror", (error) => console.error("page error:", error));
  await tab.exposeFunction("__sheetCall", (data) => JSON.stringify(sheet.handle(JSON.parse(data))));
  await tab.exposeFunction("__gameCall", (method, url, data) => ({ status: 200, body: game.handle(method, url, data).body }));
  await tab.addInitScript(shims);
  await context.route("https://4clop.org/**", (route) => {
    const request = route.request();
    const reply = game.handle(request.method(), request.url(), request.postData());
    return route.fulfill({ contentType: reply.contentType, body: reply.body });
  });
  await context.route("https://example.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body><p>Some other site</p></body></html>" }));
  return tab;
}

/** Fill the User Info form: {nation: [dashboardColumn, sheetName]}. */
async function configure(tab, rows) {
  await tab.goto("https://4clop.org/userinfo.php");
  for (const [nation, [column, sheetName]] of Object.entries(rows)) {
    await tab.fill(`#clop-sheet-sync-form tr[data-nation="${nation}"] input[name="dashboardColumn"]`, column);
    await tab.fill(`#clop-sheet-sync-form tr[data-nation="${nation}"] input[name="sheetName"]`, sheetName);
  }
  await tab.click('#clop-sheet-sync-form input[type="submit"]');
  return waitForResult(tab, Object.keys(rows).length);
}
const VLAD_ROWS = { Vladihoofstock: ["Vladihoofstock(Z)", "VladihoofstockZ"] };

/** Wait until the round is over and `count` nations report a result (or the round failed). */
async function waitForResult(tab, count = 1) {
  await tab.waitForFunction((n) => {
    const t = document.getElementById("clop-sheet-sync-status")?.textContent || "";
    if (/Syncing/.test(t)) return false;
    return (t.match(/synced at|failed/g) || []).length >= n || /Not logged in|Sync failed/.test(t);
  }, count, { timeout: 60000 });
  return tab.textContent("#clop-sheet-sync-status");
}

/** Every cell that differs between two grids. */
function diff(before, after) {
  const changes = [];
  for (let r = 0; r < Math.max(before.length, after.length); r++) {
    const a = before[r] || [], b = after[r] || [];
    for (let c = 0; c < Math.max(a.length, b.length); c++) {
      if ((a[c] ?? "") !== (b[c] ?? "")) changes.push(`${String.fromCharCode(65 + c)}${r + 1}`);
    }
  }
  return changes;
}

const clone = (grid) => JSON.parse(JSON.stringify(grid));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------------------------
// Tests

test("full sync writes buildings, stock, troops, dashboard, deals and market -- and nothing else", async (browser) => {
  const sheet = freshSheet();
  // Make a few cells wrong so there is something to correct.
  sheet.set("VladihoofstockZ", "B9", 0);       // Basic Mine have (game: 138)
  sheet.set("VladihoofstockZ", "B58", 5);      // Basic Mine disabled (game: 2)
  sheet.set("VladihoofstockZ", "R12", 1);      // oil HAVE (game: 29816)
  sheet.set("VladihoofstockZ", "R41", 0);      // Pegasi Have (game: 1)
  sheet.set("VladihoofstockZ", "R39", 4);      // Cavalry Have (game: 0)
  sheet.set("Dashboard-Stockpile", "J21", "#REF!"); // Oil (game: 29816)
  sheet.set("Dashboard-Stockpile", "J9", 99);  // Oil - tick (game: 16)
  const before = { dash: clone(sheet.tabs["Dashboard-Stockpile"]), nation: clone(sheet.tabs.VladihoofstockZ) };

  const game = new FakeGame();
  const tab = await open(browser, sheet, game);
  const status = await configure(tab, VLAD_ROWS);
  assert.match(status, /Vladihoofstock synced at .* \(\d+ cell/, status);

  const get = (t, a1) => sheet.get(t, a1);
  const D = "Dashboard-Stockpile", N = "VladihoofstockZ";
  // Buildings
  assert.equal(get(N, "B9"), 138);
  assert.equal(get(N, "B58"), 2);
  assert.equal(get(N, "B94"), 3);   // Moon Worship disabled
  assert.equal(get(N, "B85"), 120); // Toy & Candy disabled
  // STOCK block and its stamp
  assert.equal(get(N, "R12"), 29816);
  assert.equal(get(N, "W10"), SERVER_TIME);
  // TROOPS block (R39:R44)
  assert.equal(get(N, "R39"), 0);   // Cavalry
  assert.equal(get(N, "R41"), 1);   // Pegasi
  assert.equal(get(N, "R43"), 0);   // Navy (the game's "Naval")
  assert.equal(get(N, "S41"), 1);   // Want column left alone
  // Dashboard main block
  assert.equal(get(D, "J3"), SERVER_TIME);
  assert.equal(get(D, "J4"), "2500 (4)");
  assert.equal(get(D, "J5"), "958 (0)");
  assert.equal(get(D, "J6"), "-1000 (-1)");
  assert.equal(get(D, "J9"), 16);
  assert.equal(get(D, "J16"), 81097601);
  assert.equal(get(D, "J21"), 29816);
  // Deals: outgoing offered bits and goods only; requested and incoming are not ours
  assert.equal(get(D, "J52"), 5000);
  assert.equal(get(D, "J54"), 0);    // Energy
  assert.equal(get(D, "J55"), 250);  // Apples
  assert.equal(get(D, "J57"), 1024); // Oil, two deals
  assert.equal(get(D, "J59"), 0);    // Gems: only requested / offered to us
  assert.equal(get(D, "J80"), 15);   // DNA - Saddle - North
  assert.equal(get(D, "J72"), "");   // spacer where Forbidden Research / Apotheosis Serum would be
  // Market: sell orders, and bits held by buy orders at State Controlled's 1.2
  assert.equal(get(D, "J86"), 100 * 1000 * 1.2 + 2 * 5000 * 1.2);
  assert.equal(get(D, "J91"), 23848 + 73);
  assert.equal(get(D, "J90"), 0);    // Coffee: a buy order, not goods we hold

  // Nothing outside our own cells moved.
  const dashChanged = diff(before.dash, sheet.tabs[D]);
  assert.ok(dashChanged.every((a1) => a1.startsWith("J")), `dashboard cells outside J: ${dashChanged}`);
  assert.ok(!dashChanged.includes("J2"), "Ticks Since Recorded row was written");
  const nationChanged = diff(before.nation, sheet.tabs[N]);
  assert.ok(nationChanged.every((a1) => /^(B|R|W)\d+$/.test(a1)), `nation cells outside B/R/W: ${nationChanged}`);

  // A page load soon after, with nothing changed in the game, does not sync again.
  const writes = sheet.log.length;
  const requests = game.log.length;
  await tab.goto("https://4clop.org/news.php");
  await tab.waitForTimeout(1500);
  assert.equal(game.log.length, requests + 1, `a page load within the minute started another round: ${game.log.slice(requests).map((e) => e.method + " " + e.name)}`);
  assert.equal(sheet.log.length, writes);

  // The badge opens to a Sync now button, which forces a round: only the two timestamps move.
  await tab.click("#clop-sheet-sync-badge button");                // the collapsed pill
  await tab.click("#clop-sheet-sync-badge button:has-text('Sync now')");
  await tab.waitForFunction(() => /Sync now/.test(document.getElementById("clop-sheet-sync-badge").textContent));
  const extra = sheet.log.slice(writes).map((op) => `${op.tab}!${op.range}`);
  assert.deepEqual(extra.sort(), ["Dashboard-Stockpile!J3:J3", "VladihoofstockZ!W10:W10"], `forced resync wrote ${extra}`);
  // ...and collapses again, remembering it.
  await tab.click("#clop-sheet-sync-badge button[title='Collapse']");
  await tab.reload();
  await tab.waitForSelector("#clop-sheet-sync-badge");
  assert.match(await tab.textContent("#clop-sheet-sync-badge"), /^✓ Sheet$/);
  await tab.context().close();
});

test("game requests are spaced at least a second apart", async (browser) => {
  const game = new FakeGame({ nations: [VLAD, LANA] });
  const tab = await open(browser, freshSheet(), game);
  await configure(tab, { ...VLAD_ROWS, Lanathesis: ["Lanathesis(Z)", "LanathesisZ"] });
  const times = game.log.map((entry) => entry.at);
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  // Your userinfo.php load, then 8 from the script: overview, deals, forces; switch, deals, forces;
  // switch back; the API.
  assert.equal(game.log.length, 9, game.log.map((e) => `${e.method} ${e.name}`).join(", "));
  assert.ok(Math.min(...gaps) >= 950, `gaps: ${gaps}`);
  await tab.context().close();
});

test("every nation in the empire gets its own row and is synced by switching and switching back", async (browser) => {
  const sheet = freshSheet();
  const game = new FakeGame({ nations: [VLAD, LANA] });
  const tab = await open(browser, sheet, game);
  await tab.goto("https://4clop.org/userinfo.php");
  const rows = await tab.$$eval("#clop-sheet-sync-form tr[data-nation]", (trs) => trs.map((tr) => tr.cells[0].textContent));
  assert.deepEqual(rows, ["Vladihoofstock", "Lanathesis"]);

  const status = await configure(tab, { ...VLAD_ROWS, Lanathesis: ["Lanathesis(Z)", "LanathesisZ"] });
  assert.match(status, /Vladihoofstock synced at/, status);
  assert.match(status, /Lanathesis synced at/, status);
  // You pressed it while looking, so you were told, and told when it finished.
  await tab.waitForFunction(() => /Done! Synced/.test(document.getElementById("clop-sheet-sync-wait")?.textContent || ""));
  assert.equal(sheet.get("Dashboard-Stockpile", "J19"), 20868);   // Vladihoofstock's apples
  assert.equal(sheet.get("Dashboard-Stockpile", "M19"), 11111);   // Lanathesis's apples
  assert.equal(sheet.get("LanathesisZ", "R11"), 11111);
  assert.equal(game.active, VLAD.id, "the session was not switched back");
  const switches = game.log.filter((entry) => entry.form.switchnation_id).map((entry) => Number(entry.form.switchnation_id));
  assert.deepEqual(switches, [LANA.id, VLAD.id]);
  await tab.context().close();
});

test("tabbing in mid-visit says Working! (and lets nothing through), then Done! Synced", async (browser) => {
  const game = new FakeGame({ nations: [VLAD, LANA] });
  const tab = await open(browser, freshSheet(), game);
  await configure(tab, VLAD_ROWS);
  await tab.goto("https://4clop.org/news.php");
  // Another tab is reading Lanathesis right now.
  await tab.evaluate(() => {
    GM_setValue("lock", Date.now() + 30000);
    GM_setValue("rotation", { home: { id: 16, name: "Vladihoofstock" }, current: "Lanathesis", started: Date.now(), beat: Date.now() });
  });
  await tab.waitForFunction(() => /Working! Don't do anything/.test(document.getElementById("clop-sheet-sync-wait")?.textContent));
  assert.match(await tab.textContent("#clop-sheet-sync-wait"), /reading Lanathesis\. You'll be back on Vladihoofstock/);
  const posts = game.log.filter((entry) => entry.method === "POST").length;
  await tab.evaluate(() => document.forms[0] && document.forms[0].requestSubmit());
  await tab.waitForTimeout(500);
  assert.equal(game.log.filter((entry) => entry.method === "POST").length, posts, "a form went through mid-visit");

  // Switched back; the sheet is still being written.
  await tab.evaluate(() => GM_setValue("rotation", null));
  await tab.waitForFunction(() => document.getElementById("clop-sheet-sync-wait")?.dataset.kind === "writing");
  // The round ends.
  await tab.evaluate(() => GM_setValue("lock", 0));
  await tab.waitForFunction(() => /Done! Synced/.test(document.getElementById("clop-sheet-sync-wait")?.textContent));
  await tab.waitForFunction(() => !document.getElementById("clop-sheet-sync-wait"), null, { timeout: 5000 });
  await tab.context().close();
});

test("while a 4clop tab is on screen, timed rounds leave the other nations alone", async (browser) => {
  const game = new FakeGame({ nations: [VLAD, LANA] });
  const tab = await open(browser, freshSheet(), game);
  await configure(tab, { ...VLAD_ROWS, Lanathesis: ["Lanathesis(Z)", "LanathesisZ"] });
  const switches = () => game.log.filter((entry) => entry.form.switchnation_id).length;
  assert.equal(switches(), 2); // the Save above counts as a manual sync
  await tab.goto("https://4clop.org/news.php");
  // Make both the round and Lanathesis overdue, then let the timer run one.
  await tab.evaluate(() => {
    GM_setValue("round", { ...GM_getValue("round", {}), lastAttempt: 0 });
    const state = GM_getValue("state", {});
    state.Lanathesis.lastRead = 0;
    GM_setValue("state", state);
  });
  const before = game.log.length;
  await tab.waitForFunction((n) => GM_getValue("round", {}).lastAttempt > 0 && !(GM_getValue("lock", 0) > Date.now()), before, { timeout: 30000 });
  assert.ok(game.log.length > before + 1, "no timed round ran");
  assert.equal(switches(), 2, "a timed round switched nations while you were looking");
  await tab.context().close();
});

test("with no 4clop tab on screen, timed rounds visit the other nations too", async (browser) => {
  const sheet = freshSheet();
  const game = new FakeGame({ nations: [VLAD, LANA] });
  const tab = await open(browser, sheet, game);
  await tab.goto("https://example.com/");
  await tab.evaluate(() => GM_setValue("settings", {
    Vladihoofstock: { dashboardColumn: "Vladihoofstock(Z)", sheetName: "VladihoofstockZ" },
    Lanathesis: { dashboardColumn: "Lanathesis(Z)", sheetName: "LanathesisZ" },
  }));
  await tab.reload();
  await tab.waitForFunction(() => (GM_getValue("state", {}).Lanathesis || {}).checkedAt, null, { timeout: 30000 });
  assert.equal(sheet.get("LanathesisZ", "R11"), 11111);
  assert.equal(game.active, VLAD.id);
  await tab.context().close();
});

test("a visit abandoned mid-way (tab closed) is switched back by the next tab", async (browser) => {
  const game = new FakeGame({ nations: [VLAD, LANA] });
  const tab = await open(browser, freshSheet(), game);
  await configure(tab, VLAD_ROWS);
  game.active = LANA.id; // as if a tab closed while it was on Lanathesis
  await tab.evaluate(() => GM_setValue("rotation", { home: { id: 16, name: "Vladihoofstock" }, started: Date.now() - 60000, beat: Date.now() - 60000 }));
  await tab.evaluate(() => GM_setValue("lock", 0));
  await tab.goto("https://4clop.org/news.php");
  await tab.waitForFunction(() => GM_getValue("rotation", null) === null, null, { timeout: 30000 });
  assert.equal(game.active, VLAD.id);
  await tab.context().close();
});

test("it syncs from a tab on another site, and shows nothing there", async (browser) => {
  const sheet = freshSheet();
  sheet.set("VladihoofstockZ", "B9", 0);
  const tab = await open(browser, sheet);
  await tab.goto("https://example.com/");
  await tab.evaluate(() => GM_setValue("settings", { Vladihoofstock: { dashboardColumn: "Vladihoofstock(Z)", sheetName: "VladihoofstockZ" } }));
  await tab.reload();
  await tab.waitForFunction(() => (GM_getValue("state", {}).Vladihoofstock || {}).checkedAt, null, { timeout: 30000 });
  assert.equal(sheet.get("VladihoofstockZ", "B9"), 138);
  assert.equal(await tab.$("#clop-sheet-sync-badge"), null);
  await tab.context().close();
});

test("an older endpoint without batch still gets the same writes, one call each", async (browser) => {
  const batched = freshSheet();
  const single = freshSheet({ batch: false });
  for (const sheet of [batched, single]) {
    const tab = await open(browser, sheet);
    const status = await configure(tab, VLAD_ROWS);
    assert.match(status, /synced at/, status);
    await tab.context().close();
  }
  assert.deepEqual(single.tabs, batched.tabs);
});

test("a wrong Dashboard Column Name skips the dashboard but still updates the nation tab", async (browser) => {
  const sheet = freshSheet();
  sheet.set("VladihoofstockZ", "B9", 0);
  const dash = clone(sheet.tabs["Dashboard-Stockpile"]);
  const tab = await open(browser, sheet);
  const status = await configure(tab, { Vladihoofstock: ["Vladihoofstock", "VladihoofstockZ"] });
  assert.match(status, /1 problem/, status);
  assert.match(status, /no column in row 1 of Dashboard-Stockpile is named "Vladihoofstock"/);
  assert.deepEqual(sheet.tabs["Dashboard-Stockpile"], dash);
  assert.equal(sheet.get("VladihoofstockZ", "B9"), 138);
  await tab.context().close();
});

test("a deal whose direction can't be read is never counted as yours -- the Deals block is left alone", async (browser) => {
  // The incoming offer from Sunlit Fields (99 Gems) follows your outgoing deals. Reword its money
  // line, as a game update might: it must not inherit "outgoing" from the deal before it.
  const sheet = freshSheet();
  const game = new FakeGame({ deals: (html) => html.replace("offers 9,999 bits for this deal", "proposes 9,999 bits") });
  const tab = await open(browser, sheet, game);
  const status = await configure(tab, VLAD_ROWS);
  assert.match(status, /could not tell whether the deal with Sunlit Fields on deals\.php is yours or theirs/, status);
  assert.equal(sheet.get("Dashboard-Stockpile", "J52"), "");     // Deals block untouched
  assert.equal(sheet.get("Dashboard-Stockpile", "J59"), "");     // ...so the 99 Gems never land anywhere
  assert.equal(sheet.get("Dashboard-Stockpile", "J86"), 132000); // Market still written
  assert.equal(sheet.get("Dashboard-Stockpile", "J21"), 29816);  // and the main block
  await tab.context().close();
});

test("a real draft deal: offered bits and items count, requested items don't", async (browser) => {
  // A player's own deal, as deals.php showed it: 1,000 bits and 10 DNA offered, 100 DNA requested.
  const sheet = freshSheet();
  const game = new FakeGame({ deals: () => fixture("deals-example.content.html") });
  const tab = await open(browser, sheet, game);
  const status = await configure(tab, VLAD_ROWS);
  assert.match(status, /synced at/, status);
  const D = "Dashboard-Stockpile";
  assert.equal(sheet.get(D, "J52"), 1000); // Bits
  assert.equal(sheet.get(D, "J80"), 10);   // DNA - Saddle - North: offered, so it left the stockpile
  assert.equal(sheet.get(D, "J82"), 0);    // DNA - Zebrica - Central: requested, not ours
  for (const row of [54, 55, 56, 57, 58, 59, 73, 84]) assert.equal(sheet.get(D, `J${row}`), 0, `J${row}`);
  await tab.context().close();
});

test("an unknown section inside one of your deals leaves the Deals block alone", async (browser) => {
  const sheet = freshSheet();
  const game = new FakeGame({ deals: (html) => html.replace("<h4>Offered Items</h4>", "<h4>Offered Goods</h4>") });
  const tab = await open(browser, sheet, game);
  const status = await configure(tab, VLAD_ROWS);
  assert.match(status, /section "Offered Goods" the script does not know/, status);
  assert.equal(sheet.get("Dashboard-Stockpile", "J52"), "");
  await tab.context().close();
});

test("a duplicated label refuses only the block it is in", async (browser) => {
  const sheet = freshSheet();
  sheet.set("Dashboard-Stockpile", "A87", "Oil"); // a second "Oil" inside the Market block
  const tab = await open(browser, sheet);
  const status = await configure(tab, VLAD_ROWS);
  assert.match(status, /"Oil" appears 2 times in the Market block/, status);
  assert.equal(sheet.get("Dashboard-Stockpile", "J86"), "");     // market untouched
  assert.equal(sheet.get("Dashboard-Stockpile", "J52"), 5000);   // deals still written
  await tab.context().close();
});

test("troop counts that do not add up to overview's military upkeep leave the TROOPS block alone", async (browser) => {
  const sheet = freshSheet();
  sheet.set("VladihoofstockZ", "R40", 9);
  const tab = await open(browser, sheet, new FakeGame({ extraForces: true }));
  const status = await configure(tab, VLAD_ROWS);
  assert.match(status, /would use 10 gems, 15 gasoline but overview\.php says your military uses 0 gems, 0 gasoline/, status);
  assert.equal(sheet.get("VladihoofstockZ", "R40"), 9);          // untouched
  assert.equal(sheet.get("Dashboard-Stockpile", "J52"), 5000);   // everything else still synced
  await tab.context().close();
});

test("a logged-out session writes nothing", async (browser) => {
  const sheet = freshSheet();
  const tab = await open(browser, sheet, new FakeGame({ loggedOut: true }));
  const status = await configure(tab, VLAD_ROWS);
  assert.match(status, /Not logged in to 4clop\.org/, status);
  assert.equal(sheet.log.length, 0);
  await tab.context().close();
});

// ---------------------------------------------------------------------------------------------

const only = process.argv[2];
const browser = await chromium.launch();
let failed = 0;
for (const { name, fn } of tests.filter((t) => !only || t.name.includes(only))) {
  try {
    await fn(browser);
    console.log(`ok   - ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL - ${name}\n${error.stack}`);
  }
}
await browser.close();
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
