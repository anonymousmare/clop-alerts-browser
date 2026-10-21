// End-to-end check of clop-sheet-sync.user.js in a real Chromium.
//
// The game is served from fixtures (the page markup is the live game's), the sheet is a fake
// Apps Script endpoint loaded from the two TSV exports in fixtures/, and Tampermonkey's GM_* API is
// shimmed. Run with:  node test/run.mjs
//
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
    const grid = this.tabs[tab];
    const { r0, c0 } = bounds(a1);
    const value = grid[r0] && grid[r0][c0];
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
  }, options);
}

// ---------------------------------------------------------------------------------------------
// Fake game

const SERVER_TIME = "2026-10-21 00:43:34";
const plainNation = "<li><a>Vladihoofstock</a></li>";
const switcher =
  `<li><a><form action="" method="post"><select name="switchnation_id" onchange='this.form.submit()'>` +
  `<option value="99">Other Nation</option><option value="16" selected >Vladihoofstock</option></select></form></a></li>`;

function page(title, content, { nationLine = plainNation, loggedIn = true } = {}) {
  let html = fixture("chrome.html")
    .replace("{{TITLE}}", title)
    .replace("{{NATIONLINE}}", nationLine)
    .replace("{{SERVERTIME}}", SERVER_TIME)
    .replace("{{CONTENT}}", content);
  if (!loggedIn) html = html.replace('<li><a href="logout.php">Logout</a></li>', "");
  return html;
}

// ---------------------------------------------------------------------------------------------
// Harness

const shims = `
  (() => {
    const store = () => JSON.parse(localStorage.getItem("__gm") || "{}");
    window.GM_getValue = (key, fallback) => (key in store() ? store()[key] : fallback);
    window.GM_setValue = (key, value) => {
      const all = store();
      all[key] = value;
      localStorage.setItem("__gm", JSON.stringify(all));
    };
    window.GM_xmlhttpRequest = (details) => {
      window.__sheetCall(details.data).then(
        (body) => details.onload({ status: 200, responseText: body, finalUrl: details.url }),
        () => details.onerror({}));
    };
  })();
  document.addEventListener("DOMContentLoaded", () => { ${userscript} });
`;

async function open(browser, sheet, gameOptions = {}) {
  const context = await browser.newContext();
  const tab = await context.newPage();
  tab.on("pageerror", (error) => console.error("page error:", error));
  await tab.exposeFunction("__sheetCall", (data) => JSON.stringify(sheet.handle(JSON.parse(data))));
  await tab.addInitScript(shims);
  await context.route("https://4clop.org/**", (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.replace(/^\//, "");
    const html = (body) => route.fulfill({ contentType: "text/html", body });
    if (name === "api/public/v1.php") return route.fulfill({ contentType: "application/json", body: fixture("api.json") });
    if (name === "overview.php") {
      return html(gameOptions.overviewLoggedOut
        ? page("Login", "<center>Please log in.</center>", { loggedIn: false })
        : page("Overview", fixture("overview.content.html"), gameOptions));
    }
    if (name === "deals.php") return html(page("Deals", fixture("deals.content.html"), gameOptions));
    if (name === "userinfo.php") return html(page("User Info", fixture("userinfo.content.html"), gameOptions));
    return html(page("News", "<center>news</center>", gameOptions));
  });
  return tab;
}

async function configure(tab, dashboardColumn, sheetName) {
  await tab.goto("https://4clop.org/userinfo.php");
  await tab.fill('#clop-sheet-sync-form input[name="dashboardColumn"]', dashboardColumn);
  await tab.fill('#clop-sheet-sync-form input[name="sheetName"]', sheetName);
  await tab.click('#clop-sheet-sync-form input[type="submit"]');
  return waitForResult(tab);
}

async function waitForResult(tab) {
  await tab.waitForFunction(() => {
    const t = document.getElementById("clop-sheet-sync-status")?.textContent || "";
    return /synced at|failed/.test(t);
  }, null, { timeout: 15000 });
  return tab.textContent("#clop-sheet-sync-status");
}

/** Every cell of `tab` that differs between two grids, as "A1 before -> after". */
function diff(before, after) {
  const changes = [];
  for (let r = 0; r < Math.max(before.length, after.length); r++) {
    const a = before[r] || [], b = after[r] || [];
    for (let c = 0; c < Math.max(a.length, b.length); c++) {
      const x = a[c] ?? "", y = b[c] ?? "";
      if (x !== y) changes.push(`${String.fromCharCode(65 + c)}${r + 1}`);
    }
  }
  return changes;
}

const clone = (grid) => JSON.parse(JSON.stringify(grid));
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ---------------------------------------------------------------------------------------------
// Tests

test("full sync writes buildings, stock, dashboard, deals and market -- and nothing else", async (browser) => {
  const sheet = freshSheet();
  // Make a few cells wrong so there is something to correct.
  sheet.set("VladihoofstockZ", "B9", 0);       // Basic Mine have (game: 138)
  sheet.set("VladihoofstockZ", "B58", 5);      // Basic Mine disabled (game: 2)
  sheet.set("VladihoofstockZ", "R12", 1);      // oil HAVE (game: 29816)
  sheet.set("Dashboard-Stockpile", "J21", "#REF!"); // Oil (game: 29816)
  sheet.set("Dashboard-Stockpile", "J9", 99);  // Oil - tick (game: 16)
  const before = { dash: clone(sheet.tabs["Dashboard-Stockpile"]), nation: clone(sheet.tabs.VladihoofstockZ) };

  const tab = await open(browser, sheet);
  const status = await configure(tab, "Vladihoofstock(Z)", "VladihoofstockZ");
  assert.match(status, /synced at .* \(\d+ cell/, status);

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

  // A second sync with nothing changed in the game writes nothing (the badge click forces one).
  const writes = sheet.log.length;
  await tab.goto("https://4clop.org/news.php");
  await tab.waitForTimeout(500);
  assert.equal(sheet.log.length, writes, "an unchanged, recent sync wrote again");
  await tab.click("#clop-sheet-sync-badge");
  await tab.waitForFunction(() => /synced at/.test(document.getElementById("clop-sheet-sync-badge").textContent));
  await tab.waitForTimeout(300);
  const extra = sheet.log.slice(writes).map((op) => `${op.tab}!${op.range}`);
  assert.deepEqual(extra.sort(), ["Dashboard-Stockpile!J3:J3", "VladihoofstockZ!W10:W10"], `forced resync wrote ${extra}`);
  await tab.context().close();
});

test("an older endpoint without batch still gets the same writes, one call each", async (browser) => {
  const batched = freshSheet();
  const single = freshSheet({ batch: false });
  for (const sheet of [batched, single]) {
    const tab = await open(browser, sheet);
    const status = await configure(tab, "Vladihoofstock(Z)", "VladihoofstockZ");
    assert.match(status, /synced at/, status);
    await tab.context().close();
  }
  assert.deepEqual(single.tabs, batched.tabs);
});

test("a wrong Dashboard Column Name skips the dashboard but still updates the nation tab", async (browser) => {
  const sheet = freshSheet();
  sheet.set("VladihoofstockZ", "B9", 0);
  const dash = clone(sheet.tabs["Dashboard-Stockpile"]);
  const tab = await open(browser, sheet, { nationLine: switcher });
  const status = await configure(tab, "Vladihoofstock", "VladihoofstockZ");
  assert.match(status, /1 problem/, status);
  assert.match(status, /no column in row 1 of Dashboard-Stockpile is named "Vladihoofstock"/);
  assert.deepEqual(sheet.tabs["Dashboard-Stockpile"], dash);
  assert.equal(sheet.get("VladihoofstockZ", "B9"), 138);
  // Settings were stored for the nation the switcher has selected.
  const stored = await tab.evaluate(() => Object.keys(GM_getValue("settings", {})));
  assert.deepEqual(stored, ["Vladihoofstock"]);
  await tab.context().close();
});

test("a duplicated label refuses only the block it is in", async (browser) => {
  const sheet = freshSheet();
  sheet.set("Dashboard-Stockpile", "A87", "Oil"); // a second "Oil" inside the Market block
  const tab = await open(browser, sheet);
  const status = await configure(tab, "Vladihoofstock(Z)", "VladihoofstockZ");
  assert.match(status, /"Oil" appears 2 times in the Market block/, status);
  assert.equal(sheet.get("Dashboard-Stockpile", "J86"), "");     // market untouched
  assert.equal(sheet.get("Dashboard-Stockpile", "J52"), 5000);   // deals still written
  await tab.context().close();
});

test("a logged-out overview writes nothing", async (browser) => {
  const sheet = freshSheet();
  const tab = await open(browser, sheet, { overviewLoggedOut: true });
  const status = await configure(tab, "Vladihoofstock(Z)", "VladihoofstockZ");
  assert.match(status, /failed: overview\.php/, status);
  assert.equal(sheet.log.length, 0);
  await tab.context().close();
});

// ---------------------------------------------------------------------------------------------

const browser = await chromium.launch();
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn(browser);
    console.log(`ok   - ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL - ${name}\n${error.stack}`);
  }
}
await browser.close();
console.log(failed ? `\n${failed} failed` : `\nall ${tests.length} passed`);
process.exit(failed ? 1 : 0);
