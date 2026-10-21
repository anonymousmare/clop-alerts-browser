// ==UserScript==
// @name         CLOP Sheet Sync
// @namespace    https://github.com/anonymousmare/clop-alerts-browser
// @version      2.1.0
// @description  Keeps the shared CLOP planning sheet up to date from your logged-in 4clop.org session: buildings, stockpiles, deals and market.
// @match        *://*/*
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @connect      4clop.org
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @run-at       document-idle
// ==/UserScript==

/*
 * What this does, every minute while a 4clop.org tab is open, and every two minutes from any other
 * tab when none is (see SYNC_* -- the script runs on every site so it can, but does nothing there
 * except this timer):
 *
 *   1. reads overview.php, deals.php, groupforces.php and the public API (api/public/v1.php) with
 *      your own session;
 *   2. writes your nation tab ("Sheet Name"): building have/disabled counts in column B, and the
 *      six STOCK goods in the HAVE column plus the timestamp beside the STOCK header, and your
 *      troop counts (from groupforces.php) in the TROOPS block's Have column;
 *   3. writes your column on the Dashboard-Stockpile tab ("Dashboard Column Name"): status rows,
 *      the "- tick" rows and every good, then the Deals block (bits and goods you have put into
 *      outgoing deals) and the Market block (goods on your sell orders, bits held by your buy orders).
 *
 * Both names are set per nation on User Info (userinfo.php). Every nation on your login that has
 * them is synced: the script switches the session to each in turn, reads it, and switches back --
 * only on Sync now, or while no 4clop.org tab is on screen (see visitOthers). Apart from that
 * switch, nothing is ever done in the game: the script only reads pages. Every sheet cell is found
 * by looking its label up, never by row number,
 * and a region whose labels do not line up is skipped and reported instead of guessed at.
 */

(function () {
  "use strict";

  // Greasemonkey 4 only has the async GM.* API and no value-change listener, which the cross-tab
  // lock, the one-request-a-second limit and the "are you looking" check all rely on. Say so on
  // 4clop.org instead of failing on the first storage call.
  const MISSING = [
    typeof GM_getValue !== "function" && "GM_getValue",
    typeof GM_setValue !== "function" && "GM_setValue",
    typeof GM_xmlhttpRequest !== "function" && "GM_xmlhttpRequest",
    typeof GM_addValueChangeListener !== "function" && "GM_addValueChangeListener",
  ].filter(Boolean);
  if (MISSING.length) {
    console.warn(`[CLOP Sheet Sync] this userscript manager does not provide ${MISSING.join(", ")}; use Tampermonkey or Violentmonkey.`);
    if (/(^|\.)4clop\.org$/.test(location.hostname) && document.body) {
      const note = document.createElement("div");
      note.id = "clop-sheet-sync-unsupported";
      note.style.cssText =
        "position:fixed;right:12px;bottom:12px;z-index:9999;max-width:360px;padding:8px 12px;border-radius:6px;" +
        "background:#b8322a;color:#fff;font:12px/1.4 sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.5)";
      note.textContent =
        "CLOP Sheet Sync can't run in this userscript manager (Greasemonkey 4 is missing " +
        `${MISSING.join(", ")}). Install Tampermonkey or Violentmonkey and add the script there instead.`;
      document.body.appendChild(note);
    }
    return;
  }

  // ------------------------------------------------------------------------------------------
  // Configuration

  /** Apps Script web app bound to the shared planning sheet (source: apps-script/Code.gs). */
  const EXEC_URL =
    "https://script.google.com/macros/s/" +
    "AKfycbxq-yk5Yd5kbBOAm7HKGXWDqsQg85XMTiO80HUCLR91PhoOAyFjLoFwBTh9_uSCYdc3uQ/exec";

  /** The alliance-wide tab. The only tab name the script hardcodes. */
  const DASHBOARD_TAB = "Dashboard-Stockpile";

  /** Ranges read before writing. Generous, so a longer sheet is still covered. */
  const NATION_BUILDINGS_RANGE = "A1:B140";
  const NATION_STOCK_RANGE = "Q1:W60";
  const DASHBOARD_RANGE = "A1:AZ200";

  /** Pages where you usually change something; loading one always syncs (after a short debounce). */
  const ACTION_PAGES = [
    "overview.php", "deals.php", "makedeal.php", "marketplace.php", "buyermarketplace.php",
    "myoffers.php", "transfer.php", "actions.php", "favoriteactions.php", "majoractions.php",
  ];
  /** How often a 4clop.org tab syncs (also the minimum gap between page-load syncs there). */
  const SYNC_MIN_INTERVAL_MS = 60 * 1000;
  /** How often any other tab syncs, for when no 4clop.org tab is open. */
  const OFFSITE_INTERVAL_MS = 2 * 60 * 1000;
  /** Your other nations are visited at most this often; the one you are on syncs every round. */
  const OTHER_NATIONS_INTERVAL_MS = 5 * 60 * 1000;
  /** Minimum gap even on an action page, so a burst of clicks is one sync. */
  const SYNC_DEBOUNCE_MS = 10 * 1000;
  /**
   * When the game data is identical to the last clean sync, the sheet is left alone until this
   * much time has passed -- then it is re-checked and the timestamps refreshed anyway.
   */
  const UNCHANGED_REFRESH_MS = 30 * 60 * 1000;
  /** A sync refreshes its lock as it goes; one that stops (a closed tab) frees it this soon. */
  const LOCK_MS = 30 * 1000;
  /** A nation visit that has not checked in for this long is a crashed one, and is undone. */
  const ROTATION_STALE_MS = 15 * 1000;
  /**
   * A 4clop.org tab that was on screen this recently means you are looking at the game, so other
   * nations are left alone unless you press Sync now. On-screen tabs check in every 2 seconds.
   */
  const LOOKING_MS = 5 * 1000;
  /** At most one request a second to 4clop.org, as the game's host asks. */
  const GAME_REQUEST_GAP_MS = 1000;

  /** Waits between attempts at the sheet endpoint (seconds). Google's endpoint fails transiently. */
  const RETRY_DELAYS = [0, 0.5, 1, 2, 4, 8, 15];
  const REQUEST_TIMEOUT_MS = 30 * 1000;
  const SHEET_DEADLINE_MS = 150 * 1000;

  // ------------------------------------------------------------------------------------------
  // The game's vocabulary, and the sheet's names for it

  /**
   * All 31 goods: [game name, Dashboard label, nation-tab STOCK label, Dashboard "- tick" label].
   * The game name is resourcedefs.name exactly as overview.php, deals.php and the API print it.
   */
  const GOODS = [
    ["Energy", "Energy", null, null],
    ["Apples", "Apples", "apple", "Apple - tick"],
    ["Coffee", "Coffee", "coffee", "Coffee - tick"],
    ["Oil", "Oil", "oil", "Oil - tick"],
    ["Gasoline", "Gas", null, null],
    ["Gems", "Gems", "gems", "Gems - tick"],
    ["Cider", "Cider", null, null],
    ["Pies", "Pies", null, null],
    ["Toys", "Toys", null, null],
    ["Tungsten", "Tungsten", null, null],
    ["Plastics", "Plastics", null, null],
    ["Drugs", "Drugs", null, null],
    ["Copper", "Copper", null, null],
    ["Machinery Parts", "M Parts", "mpart", "M Part - tick"],
    ["Vehicle Parts", "V Parts", "vpart", "V Part - tick"],
    ["Precision Parts", "P Parts", null, null],
    ["Composites", "Composites", null, null],
    ["Forbidden Research", "Forbidden Research", null, null],
    ["Apotheosis Serum", "Apotheosis Serum", null, null],
    ["DNA - Central Burrozil", "DNA - Burro - Central", null, null],
    ["DNA - North Burrozil", "DNA - Burro - North", null, null],
    ["DNA - South Burrozil", "DNA - Burro - South", null, null],
    ["DNA - Central Przewalskia", "DNA - Prze - Central", null, null],
    ["DNA - North Przewalskia", "DNA - Prze - North", null, null],
    ["DNA - South Przewalskia", "DNA - Prze - South", null, null],
    ["DNA - Central Saddle Arabia", "DNA - Saddle - Central", null, null],
    ["DNA - North Saddle Arabia", "DNA - Saddle - North", null, null],
    ["DNA - South Saddle Arabia", "DNA - Saddle - South", null, null],
    ["DNA - Central Zebrica", "DNA - Zebrica - Central", null, null],
    ["DNA - North Zebrica", "DNA - Zebrica - North", null, null],
    ["DNA - South Zebrica", "DNA - Zebrica - South", null, null],
  ].map(([game, dashboard, stock, tick]) => ({ game, dashboard, stock, tick }));

  const GOOD_BY_GAME = new Map(GOODS.map((good) => [good.game, good]));

  /**
   * Game building name -> nation-tab column-A label. Two deliberate many-to-one groups: every
   * regional DNA Extraction Facility folds into "DNA", and Solar Collector + Tidal Generator fold
   * into "Energy Collector".
   */
  const BUILDINGS = {
    "Basic Copper Mine": "Basic Mine",
    "Mechanized Copper Mine": "Mecha Mine",
    "Gem Mine": "Gem Mine",
    "Tungsten Mine": "Tungsten Mine",
    "Basic Apple Orchard": "Basic Orchard",
    "Mechanized Apple Orchard": "Mecha Orchard",
    "Coffee Farm": "Coffee Farm",
    "Drug Farm": "Drug Farm",
    "Basic Oil Well": "Basic Oil",
    "Mechanized Oil Well": "Mech Oil",
    "Oil Fracker": "Fracker",
    "Cider Production Facility": "Cider Facility",
    "Solar Collector": "Energy Collector",
    "Tidal Generator": "Energy Collector",
    "Oil Combustion Facility": "Oil Combustion",
    "Gasoline Combustion Facility": "Gas Combustion",
    "Gasoline Refinery": "Gas Refinery",
    "Plastics Factory": "Plastics Factory",
    "Przewalskian Plastics Factory": "Prze Adv Plastic",
    "Toy Factory": "Toy Factory",
    "Bakery": "Bakery",
    "Bar": "Bar",
    "Coffee Shop": "Coffee Shop",
    "Statue": "Statue",
    "Toy and Candy Shop": "Toy & Candy",
    "Video Arcade": "Video Arcade",
    "Mall": "Mall",
    "Basic Factory": "Basic Factory",
    "Advanced Factory": "Adv Factory",
    "Barracks": "Barracks",
    "DNA Extraction Facility - N. SA": "DNA",
    "DNA Extraction Facility - C. SA": "DNA",
    "DNA Extraction Facility - S. SA": "DNA",
    "DNA Extraction Facility - N. Zebrica": "DNA",
    "DNA Extraction Facility - C. Zebrica": "DNA",
    "DNA Extraction Facility - S. Zebrica": "DNA",
    "DNA Extraction Facility - N. Burrozil": "DNA",
    "DNA Extraction Facility - C. Burrozil": "DNA",
    "DNA Extraction Facility - S. Burrozil": "DNA",
    "DNA Extraction Facility - N. Prze": "DNA",
    "DNA Extraction Facility - C. Prze": "DNA",
    "DNA Extraction Facility - S. Prze": "DNA",
    "Moon Worship Center": "Moon Worship",
    "Sun Worship Center": "Sun Worship",
    "Lunar Environmental Facility": "Lunar Enviro",
    "Solar Environmental Facility": "Solar Enviro",
    "Forbidden Research Facility": "Forbidden Research",
    "Alicornification Facility": "Alicornification",
  };
  const SHEET_BUILDINGS = [...new Set(Object.values(BUILDINGS))].sort();

  /** Dashboard rows that are not goods. "Active" holds the last-updated stamp despite its label. */
  const STATUS_LABELS = ["Active", "Sat", "NLR", "SE", "GDP", "Bits"];
  const TICK_LABELS = GOODS.filter((good) => good.tick).map((good) => good.tick);
  const MAIN_LABELS = [...STATUS_LABELS, ...TICK_LABELS, ...GOODS.map((good) => good.dashboard)];
  /**
   * The Deals and Market blocks: a marker row, then "Bits" and the goods again -- minus the two
   * endgame goods, which the game does not let you deal or sell.
   */
  const DEALS_MARKER = "Deals";
  const MARKET_MARKER = "Market";
  const UNTRADEABLE = new Set(["Forbidden Research", "Apotheosis Serum"]);
  const BLOCK_GOODS = GOODS.filter((good) => !UNTRADEABLE.has(good.game));
  const BLOCK_LABELS = ["Bits", ...BLOCK_GOODS.map((good) => good.dashboard)];

  /**
   * Force types as groupforces.php prints them -> the nation tab's TROOPS labels, and what one unit
   * costs every 12 hours (backend_overview.php's "Your military also uses ..." line).
   */
  const TROOPS = [
    { game: "Cavalry", sheet: "Cavalry", upkeep: { apples: 5 } },
    { game: "Tanks", sheet: "Tanks", upkeep: { gasoline: 5 } },
    { game: "Pegasi", sheet: "Pegasi", upkeep: { coffee: 5 } },
    { game: "Unicorns", sheet: "Unicorns", upkeep: { gems: 5 } },
    { game: "Naval", sheet: "Navy", upkeep: { gasoline: 5 } },
    { game: "Alicorns", sheet: "Alicorns", upkeep: { gems: 10 } },
  ];
  const TROOPS_HEADER = "TROOPS";
  const TROOPS_HAVE = "Have";

  const STOCK_HEADER = "STOCK";
  const HAVE_HEADER = "HAVE";
  /** The nation tab's timestamp sits in this column of the STOCK header row; it has no label. */
  const STOCK_STAMP_COLUMN = "W";
  const STOCK_FIRST_COLUMN = 16; // Q

  /** What a buy order holds back from your funds per bit of price, by economy (getbuyingmultiplier). */
  function buyingMultiplier(economy, activeEconomy) {
    if (economy === "State Controlled") return 1.2;
    if (economy === "Free Market" && activeEconomy) return 1.03;
    return 1.1;
  }

  // ------------------------------------------------------------------------------------------
  // Small helpers

  class SyncError extends Error {}

  const text = (node) => (node ? node.textContent.replace(/\s+/g, " ").trim() : "");

  function toInt(raw, what) {
    const cleaned = String(raw).replace(/,/g, "").trim();
    if (!/^-?\d+$/.test(cleaned)) throw new SyncError(`${what} reads ${JSON.stringify(raw)}, which is not a whole number`);
    return parseInt(cleaned, 10);
  }

  function columnLetter(index) {
    let letters = "";
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
      letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
    }
    return letters;
  }

  function cellAt(grid, row, column) {
    const line = grid[row];
    return line && column < line.length ? line[column] : undefined;
  }

  /** Sheets reads "2026-10-21 00:41:08" as a date in the sheet's timezone; a leading ' keeps it text. */
  const asSheetText = (value) => "'" + value;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  const ON_GAME = /(^|\.)4clop\.org$/.test(location.hostname);
  /** The game's own host when we are on it (its cookie may be www.-scoped), the live game otherwise. */
  const GAME_ORIGIN = ON_GAME ? location.origin : "https://4clop.org";

  /**
   * The game's host asks for no more than one request a second. Every request the script makes to
   * 4clop.org waits until a second has passed since the last one -- from any tab, and since your own
   * last 4clop.org page load, which is recorded in main().
   */
  async function paceGame() {
    for (;;) {
      const wait = GM_getValue("lastGameRequest", 0) + GAME_REQUEST_GAP_MS - Date.now();
      if (wait <= 0) break;
      await sleep(wait);
    }
    GM_setValue("lastGameRequest", Date.now());
  }

  /** GET `path` from the game, or POST `form` to it, with your 4clop.org session cookie. */
  async function gameRequest(path, form) {
    await paceGame();
    heartbeat();
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: form ? "POST" : "GET",
        url: `${GAME_ORIGIN}/${path}`,
        data: form ? new URLSearchParams(form).toString() : undefined,
        headers: form ? { "Content-Type": "application/x-www-form-urlencoded" } : {},
        timeout: REQUEST_TIMEOUT_MS,
        onload: (response) => (response.status >= 200 && response.status < 300
          ? resolve(response.responseText)
          : reject(new SyncError(`${path} answered HTTP ${response.status}`))),
        onerror: () => reject(new SyncError(`could not reach 4clop.org (${path})`)),
        ontimeout: () => reject(new SyncError(`4clop.org timed out (${path})`)),
      });
    });
  }

  // ------------------------------------------------------------------------------------------
  // Reading the game

  function isLoggedIn(doc) {
    return !!doc.querySelector('a[href="logout.php"]');
  }

  /** The active nation as the navbar shows it: plain text, or the selected nation-switcher option. */
  function navbarNation(doc) {
    const active = navbarNations(doc).active;
    return active ? active.name : null;
  }

  /**
   * Every nation on the login, from the navbar: a nation-switcher <select> when there are several
   * ({id, name} each, the selected one active), or plain text when there is one (its id is then
   * not on the page, and not needed -- there is nothing to switch to).
   */
  function navbarNations(doc) {
    const select = doc.querySelector('select[name="switchnation_id"]');
    if (select) {
      const all = [...select.querySelectorAll("option")].map((option) => ({
        id: parseInt(option.getAttribute("value"), 10),
        name: text(option),
      }));
      const selected = select.querySelector("option[selected]");
      const active = selected ? all.find((nation) => nation.id === parseInt(selected.getAttribute("value"), 10)) : null;
      return { active: active || null, all };
    }
    const first = doc.querySelector("ul.navbar-right > li > a");
    const name = first ? text(first) : "";
    return name ? { active: { id: null, name }, all: [{ id: null, name }] } : { active: null, all: [] };
  }

  function serverTime(doc) {
    const match = /Server time:\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(doc.body ? doc.body.textContent : "");
    if (!match) throw new SyncError("no 'Server time:' stamp on the page -- not a normal CLOP page");
    return match[1];
  }

  /**
   * The <table> of the overview panel headed exactly `heading`. The class is compared exactly:
   * favourite actions render as "panel-heading h4" with a user-chosen label.
   */
  function panelTable(doc, heading) {
    for (const div of doc.querySelectorAll("div.panel-heading")) {
      if ((div.getAttribute("class") || "").trim() === "panel-heading" && text(div) === heading) {
        const panel = div.closest(".panel");
        return panel ? panel.querySelector("table") : null;
      }
    }
    return null;
  }

  function rightCellIndex(cells) {
    return cells.findIndex((cell) => /text-align:\s*right/i.test(cell.getAttribute("style") || ""));
  }

  /** "2500 (4 per tick)" -> "2500 (4)"; "1000 (Fixed)" stays as printed. */
  function reading(raw, what) {
    const match = /^(-?[\d,]+)\s*\((.+?)\)$/.exec(raw);
    if (!match) throw new SyncError(`${what} reads ${JSON.stringify(raw)} on overview.php, which is not '<value> (<per tick>)'`);
    let perTick = match[2].trim().replace(/\s*per tick$/, "");
    const cleaned = perTick.replace(/,/g, "");
    if (/^-?\d+$/.test(cleaned)) perTick = String(parseInt(cleaned, 10));
    return `${toInt(match[1], what)} (${perTick})`;
  }

  function parseOverview(html) {
    if (!html.trimEnd().endsWith("</html>")) {
      throw new SyncError("overview.php was cut off before the page finished; nothing was written");
    }
    const doc = parseHtml(html);
    if (!isLoggedIn(doc)) throw new SyncError("overview.php came back logged out; nothing was written");
    for (const heading of ["Nation", "Resources", "Buildings"]) {
      if (!panelTable(doc, heading)) throw new SyncError(`overview.php has no ${heading} panel; nothing was written`);
    }

    const name = text(doc.querySelector("#content center h3"));
    if (!name) throw new SyncError("overview.php shows no nation name");
    const link = doc.querySelector('#content a[href*="viewnation.php?nation_id="]');
    const idMatch = link && /nation_id=(\d+)/.exec(link.getAttribute("href"));

    // Nation panel, by label.
    const nationRows = {};
    let activeEconomy = true;
    for (const tr of panelTable(doc, "Nation").querySelectorAll("tr")) {
      const cells = tr.querySelectorAll("td");
      if (cells.length < 2) continue;
      const label = text(cells[0]);
      if (label === "Warning:") activeEconomy = false;
      nationRows[label] = text(cells[1]);
    }
    const row = (label) => {
      if (!(label in nationRows)) throw new SyncError(`the Nation panel on overview.php has no ${JSON.stringify(label)} row`);
      return nationRows[label];
    };

    // Resources panel. Columns are found by heading; the icon column may be hidden (hideicons).
    const resources = {};
    let ticks = null;
    const resourceTable = panelTable(doc, "Resources");
    const headerCells = [...resourceTable.querySelectorAll("thead tr td, thead tr th")].map(text);
    const nameAt = headerCells.indexOf("Resource");
    const ticksAt = headerCells.indexOf("Ticks-Worth");
    if (ticksAt >= 0 && nameAt >= 0) ticks = {};
    for (const tr of resourceTable.querySelectorAll("tbody tr")) {
      const cells = [...tr.querySelectorAll("td")];
      const at = rightCellIndex(cells);
      if (at < 0 || at + 1 >= cells.length) continue;
      const good = text(cells[at]);
      resources[good] = toInt(text(cells[at + 1]), `${good} quantity on overview.php`);
      if (ticks) {
        const raw = text(cells[at + (ticksAt - nameAt)]).replace(/,/g, "");
        if (/^-?\d+$/.test(raw)) ticks[good] = parseInt(raw, 10);
        else if (/^(N\/A|NONE)$/i.test(raw)) ticks[good] = raw.toUpperCase();
        else throw new SyncError(`${good} has an unreadable Ticks-Worth ${JSON.stringify(raw)} on overview.php`);
      }
    }

    // Buildings panel: "138 (2 disabled)".
    const buildings = {};
    for (const tr of panelTable(doc, "Buildings").querySelectorAll("tbody > tr")) {
      const cells = [...tr.children].filter((cell) => cell.tagName === "TD");
      const at = rightCellIndex(cells);
      if (at < 0 || at + 1 >= cells.length) continue;
      const building = text(cells[at]);
      const count = text(cells[at + 1].querySelector("span") || cells[at + 1]);
      const match = /^([\d,]+)\s*(?:\(\s*([\d,]+)\s*disabled\s*\))?/i.exec(count);
      if (!match) throw new SyncError(`building ${building} has an unreadable count ${JSON.stringify(count)} on overview.php`);
      buildings[building] = { have: toInt(match[1], building), disabled: match[2] ? toInt(match[2], building) : 0 };
    }
    // "Your military also uses 0 apples, 0 gems, 5 coffee, and 0 gasoline every 12 hours."
    const upkeepMatch = /military also uses ([\d,]+) apples, ([\d,]+) gems, ([\d,]+) coffee, and ([\d,]+) gasoline/
      .exec(text(resourceTable.closest(".panel")));
    const militaryUpkeep = upkeepMatch
      ? { apples: toInt(upkeepMatch[1], "military apples"), gems: toInt(upkeepMatch[2], "military gems"),
          coffee: toInt(upkeepMatch[3], "military coffee"), gasoline: toInt(upkeepMatch[4], "military gasoline") }
      : null;

    if (!Object.keys(resources).length && !Object.keys(buildings).length) {
      throw new SyncError("overview.php lists no resources and no buildings at all (a failed game query?); nothing was written");
    }

    return {
      name,
      navbarName: navbarNation(doc),
      nations: navbarNations(doc).all,
      nationId: idMatch ? parseInt(idMatch[1], 10) : null,
      serverTime: serverTime(doc),
      economy: row("Economic Type"),
      activeEconomy,
      status: {
        Sat: reading(row("Satisfaction"), "Satisfaction"),
        NLR: reading(row("Relationship with New Lunar Republic"), "New Lunar Republic relationship"),
        SE: reading(row("Relationship with Solar Empire"), "Solar Empire relationship"),
        GDP: toInt(row("GDP").replace(/\s*bits per tick$/, ""), "GDP"),
        Bits: toInt(row("Funds").replace(/\s*bits$/, ""), "Funds"),
      },
      resources,
      ticks,
      buildings,
      militaryUpkeep,
    };
  }

  /**
   * How many units of each force type you have, wherever they are, from groupforces.php. Each
   * force's cell reads "<type><br/><weapon><br/><armor><br/>Size: N<br/>Training: N" after its
   * rename form; the type is the first bare text in the cell.
   */
  function parseForces(html, expectedNation) {
    if (!html.trimEnd().endsWith("</html>")) throw new SyncError("groupforces.php was cut off before the page finished");
    const doc = parseHtml(html);
    if (!isLoggedIn(doc)) throw new SyncError("groupforces.php came back logged out");
    const shown = navbarNation(doc);
    if (shown && expectedNation && shown !== expectedNation) {
      throw new SyncError(`groupforces.php is for ${shown}, not ${expectedNation} (switched nation mid-sync?)`);
    }
    const counts = Object.fromEntries(TROOPS.map((troop) => [troop.game, 0]));
    const content = doc.querySelector("#content") || doc.body;
    for (const td of content.querySelectorAll("td")) {
      const lines = [...td.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent.trim())
        .filter(Boolean);
      const size = lines.map((line) => /^Size:\s*([\d,]+)$/.exec(line)).find(Boolean);
      if (!size) continue;
      if (!(lines[0] in counts)) throw new SyncError(`groupforces.php lists a force of unknown type ${JSON.stringify(lines[0])}`);
      counts[lines[0]] += toInt(size[1], `${lines[0]} force size`);
    }
    return counts;
  }

  /** deals.php is readable but not in a shape we can trust: only the Deals block is skipped. */
  class DealsUnreadable extends SyncError {}

  /** The table headings deals.php prints inside one of your outgoing deals. */
  const OUTGOING_SECTIONS = new Set([
    "Offered Items", "Offered Weapons", "Offered Armor", "Requested Items", "Requested Weapons", "Requested Armor",
  ]);

  /**
   * What your outgoing deals are holding: bits you offered and goods under "Offered Items". The game
   * takes both out of your stockpile when you add them to a deal, so they are yours but not on
   * overview.php. Nothing in an incoming deal (another nation's offer) is counted: what it offers is
   * not yours yet, and what it asks for has not been taken from you.
   *
   * Which way a deal goes is read from its money line, which the game words differently for the two
   * (deals.php: "You offer ..." / "offers ..."). Every deal must be classified before its tables are
   * read, so a line the game rewords can never leave an incoming deal counted as one of yours: the
   * page is refused instead (DealsUnreadable), and only the Deals block is left alone.
   */
  function parseDeals(html, expectedNation) {
    if (!html.trimEnd().endsWith("</html>")) throw new SyncError("deals.php was cut off before the page finished");
    const doc = parseHtml(html);
    if (!isLoggedIn(doc)) throw new SyncError("deals.php came back logged out");
    const shown = navbarNation(doc);
    if (shown && expectedNation && shown !== expectedNation) {
      throw new SyncError(`deals.php is for ${shown}, not ${expectedNation} (switched nation mid-sync?)`);
    }

    const goods = {};
    let bits = 0;
    let direction = null; // null before the first deal, then "unknown" until its money line: "out" | "in"
    let partner = null;
    let section = null;
    const unclassified = () => new DealsUnreadable(
      `could not tell whether the deal with ${partner} on deals.php is yours or theirs, so the Deals block was left alone`);
    const content = doc.querySelector("#content") || doc.body;
    for (const node of content.querySelectorAll("h4, center, table")) {
      if (node.tagName === "H4") {
        if (node.querySelector('a[href*="viewnation.php?nation_id="]')) {
          // A new deal starts with the other nation's name. The previous one must have been classified.
          if (direction === "unknown") throw unclassified();
          direction = "unknown";
          partner = text(node);
          section = null;
        } else {
          section = text(node);
          if (direction === "out" && !OUTGOING_SECTIONS.has(section)) {
            throw new DealsUnreadable(`deals.php has a section ${JSON.stringify(section)} the script does not know, so the Deals block was left alone`);
          }
        }
        continue;
      }
      if (node.tagName === "CENTER") {
        if (node.querySelector("h4, table, form")) continue;
        const line = text(node);
        let match;
        if ((match = /^You (offer|request) ([\d,]+) bits for this deal$/.exec(line))) {
          direction = "out";
          section = null;
          if (match[1] === "offer") bits += toInt(match[2], "bits offered in a deal");
        } else if (line === "You do not involve money in this deal") {
          direction = "out";
          section = null;
        } else if (/^(offers [\d,]+ bits for this deal|requests [\d,]+ bits from you for this deal|does not involve money in this deal)$/.test(line)) {
          direction = "in";
          section = null;
        }
        continue;
      }
      // A table.
      if (direction === null) throw new DealsUnreadable("deals.php has a table outside any deal, so the Deals block was left alone");
      if (direction === "unknown") throw unclassified();
      if (direction === "out" && section === "Offered Items") {
        for (const tr of node.querySelectorAll("tr")) {
          const cells = tr.querySelectorAll("td");
          if (cells.length < 2) continue;
          const good = text(cells[0]);
          goods[good] = (goods[good] || 0) + toInt(text(cells[1]), `${good} offered in a deal`);
        }
      }
      section = null;
    }
    if (direction === "unknown") throw unclassified();
    return { bits, goods };
  }

  /** Your own orders on the public API's market: goods on sell orders, and bits held by buy orders. */
  function parseMarket(api, nationId, multiplier) {
    const market = api && api.market;
    if (!market || !market.resources) throw new SyncError("the API answered without a market section");
    const goods = {};
    let bits = 0;
    for (const order of market.resources.sell || []) {
      if (order.nation_id === nationId) goods[order.item_name] = (goods[order.item_name] || 0) + order.amount;
    }
    for (const kind of ["resources", "weapons", "armor"]) {
      for (const order of (market[kind] && market[kind].buy) || []) {
        if (order.nation_id === nationId) bits += Math.floor(order.price * order.amount * multiplier);
      }
    }
    return { bits, goods };
  }

  /** Everything one nation's sync needs from its own session pages, given its overview.php. */
  async function readNation(overviewHtml) {
    const overview = parseOverview(overviewHtml);
    const name = overview.navbarName || overview.name;
    if (overview.name !== name) throw new SyncError(`overview.php shows ${overview.name} but the navbar says ${name}`);
    let deals;
    try {
      deals = parseDeals(await gameRequest("deals.php"), name);
    } catch (error) {
      if (!(error instanceof DealsUnreadable)) throw error;
      deals = { unreadable: error.message };
    }
    const forces = parseForces(await gameRequest("groupforces.php"), name);
    return { name, overview, deals, forces };
  }

  async function readApi() {
    try {
      return JSON.parse(await gameRequest("api/public/v1.php"));
    } catch (error) {
      if (error instanceof SyncError) throw error;
      throw new SyncError("api/public/v1.php did not answer JSON");
    }
  }

  /** Add the market, which needs the nation id and the API. */
  function withMarket(read, api) {
    const { overview } = read;
    let nationId = overview.nationId;
    if (nationId === null) {
      const match = (api.nations || []).find((nation) => nation.name === overview.name);
      if (!match) throw new SyncError(`could not find the nation id for ${overview.name}`);
      nationId = match.nation_id;
    }
    const market = parseMarket(api, nationId, buyingMultiplier(overview.economy, overview.activeEconomy));
    return { ...read, market, nationId };
  }

  // ------------------------------------------------------------------------------------------
  // Working out what to write

  /** Label -> every 0-based row it occupies in column A between rows [from, to). */
  function indexColumnA(grid, from = 0, to = grid.length) {
    const found = new Map();
    for (let row = from; row < Math.min(to, grid.length); row++) {
      const label = String(cellAt(grid, row, 0) ?? "").trim();
      if (!label) continue;
      if (!found.has(label)) found.set(label, []);
      found.get(label).push(row);
    }
    return found;
  }

  /** Resolve every label to exactly one row, collecting a problem for each missing/duplicate one. */
  function resolveLabels(index, labels, where, problems) {
    const rows = {};
    for (const label of labels) {
      const places = index.get(label) || [];
      if (!places.length) problems.push(`${JSON.stringify(label)} is missing from ${where}`);
      else if (places.length > 1) problems.push(`${JSON.stringify(label)} appears ${places.length} times in ${where} (rows ${places.map((r) => r + 1).join(", ")})`);
      else rows[label] = places[0];
    }
    return rows;
  }

  /** Building have/disabled counts in column B of the nation tab. */
  function planBuildings(grid, tab, overview, problems) {
    const where = (region) => `the ${region} region of column A on tab ${JSON.stringify(tab)}`;
    const columnA = grid.map((line) => String((line && line[0]) ?? "").trim());
    const header = columnA.indexOf("Building");
    const marker = columnA.findIndex((label) => label.toUpperCase().startsWith("DISABLED"));
    const local = [];
    if (header < 0) local.push(`no "Building" header in column A of tab ${JSON.stringify(tab)}`);
    if (marker < 0) local.push(`no "DISABLED:" marker in column A of tab ${JSON.stringify(tab)}`);
    if (local.length) {
      problems.push(...local);
      return [];
    }

    const haveRows = resolveLabels(indexColumnA(grid, header + 1, marker), SHEET_BUILDINGS, where("buildings"), local);
    const disabledRows = {};
    const disabledIndex = indexColumnA(grid, marker + 1);
    for (const name of SHEET_BUILDINGS) {
      const places = disabledIndex.get(name) || [];
      if (places.length) disabledRows[name] = places[0];
    }

    const want = Object.fromEntries(SHEET_BUILDINGS.map((name) => [name, { have: 0, disabled: 0 }]));
    for (const [game, count] of Object.entries(overview.buildings)) {
      const name = BUILDINGS[game];
      if (!name) {
        local.push(`overview.php has a building ${JSON.stringify(game)} the script does not know -- update BUILDINGS`);
        continue;
      }
      want[name].have += count.have;
      want[name].disabled += count.disabled;
    }
    for (const name of SHEET_BUILDINGS) {
      if (want[name].disabled > 0 && !(name in disabledRows)) {
        local.push(`${name} has ${want[name].disabled} disabled but no row in ${where("DISABLED:")}`);
      }
    }
    if (local.length) {
      problems.push(...local);
      return [];
    }

    const cells = [];
    for (const name of SHEET_BUILDINGS) {
      cells.push({ tab, column: 1, row: haveRows[name], value: want[name].have });
      if (name in disabledRows) cells.push({ tab, column: 1, row: disabledRows[name], value: want[name].disabled });
    }
    return cells;
  }

  /** The STOCK block's HAVE column on the nation tab, and its timestamp. */
  function planStock(grid, tab, overview, problems) {
    const where = `the ${STOCK_HEADER} block (column Q) of tab ${JSON.stringify(tab)}`;
    const header = grid.findIndex((line) => String((line && line[0]) ?? "").trim() === STOCK_HEADER);
    if (header < 0) {
      problems.push(`no ${JSON.stringify(STOCK_HEADER)} header in column Q of tab ${JSON.stringify(tab)}`);
      return { cells: [], stamps: [] };
    }
    const haveOffset = (grid[header] || []).findIndex((cell) => String(cell ?? "").trim() === HAVE_HEADER);
    if (haveOffset < 0) {
      problems.push(`no ${JSON.stringify(HAVE_HEADER)} column beside the ${STOCK_HEADER} header on tab ${JSON.stringify(tab)}`);
      return { cells: [], stamps: [] };
    }
    // The label run stops at the first blank row: column Q has a second block (COST, ...) below.
    let end = header + 1;
    while (end < grid.length && String(cellAt(grid, end, 0) ?? "").trim()) end++;
    const local = [];
    const stockGoods = GOODS.filter((good) => good.stock);
    const rows = resolveLabels(indexColumnA(grid, header + 1, end), stockGoods.map((good) => good.stock), where, local);

    const stampOffset = STOCK_STAMP_COLUMN.charCodeAt(0) - 65 - STOCK_FIRST_COLUMN;
    const stampNow = String(cellAt(grid, header, stampOffset) ?? "").trim();
    if (stampNow && !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(stampNow)) {
      local.push(`${STOCK_STAMP_COLUMN}${header + 1} on tab ${JSON.stringify(tab)} should be empty or a timestamp but reads ${JSON.stringify(stampNow)}`);
    }
    if (local.length) {
      problems.push(...local);
      return { cells: [], stamps: [] };
    }
    const column = STOCK_FIRST_COLUMN + haveOffset;
    return {
      cells: stockGoods.map((good) => ({ tab, column, row: rows[good.stock], value: overview.resources[good.game] || 0 })),
      stamps: [{ tab, column: STOCK_FIRST_COLUMN + stampOffset, row: header, value: asSheetText(overview.serverTime) }],
    };
  }

  /**
   * The TROOPS block's Have column (R39:R44 today), on the same Q:W read as the STOCK block. The
   * counts must add up to overview.php's military upkeep line, or the block is left alone.
   */
  function planTroops(grid, tab, game, problems) {
    const header = grid.findIndex((line) => String((line && line[0]) ?? "").trim() === TROOPS_HEADER);
    if (header < 0) {
      problems.push(`no ${JSON.stringify(TROOPS_HEADER)} header in column Q of tab ${JSON.stringify(tab)}`);
      return [];
    }
    const haveOffset = (grid[header] || []).findIndex((cell) => String(cell ?? "").trim() === TROOPS_HAVE);
    if (haveOffset < 0) {
      problems.push(`no ${JSON.stringify(TROOPS_HAVE)} column beside the ${TROOPS_HEADER} header on tab ${JSON.stringify(tab)}`);
      return [];
    }
    let end = header + 1;
    while (end < grid.length && String(cellAt(grid, end, 0) ?? "").trim()) end++;
    const local = [];
    const where = `the ${TROOPS_HEADER} block (column Q) of tab ${JSON.stringify(tab)}`;
    const rows = resolveLabels(indexColumnA(grid, header + 1, end), TROOPS.map((troop) => troop.sheet), where, local);

    const upkeep = game.overview.militaryUpkeep;
    if (upkeep) {
      const expected = { apples: 0, gems: 0, coffee: 0, gasoline: 0 };
      for (const troop of TROOPS) {
        for (const [good, each] of Object.entries(troop.upkeep)) expected[good] += each * game.forces[troop.game];
      }
      const off = Object.keys(expected).filter((good) => expected[good] !== upkeep[good]);
      if (off.length) {
        local.push(`the forces on groupforces.php would use ${off.map((g) => `${expected[g]} ${g}`).join(", ")} but overview.php says your military uses ${off.map((g) => `${upkeep[g]} ${g}`).join(", ")}, so the ${TROOPS_HEADER} block was left alone`);
      }
    }
    if (local.length) {
      problems.push(...local);
      return [];
    }
    const column = STOCK_FIRST_COLUMN + haveOffset;
    return TROOPS.map((troop) => ({ tab, column, row: rows[troop.sheet], value: game.forces[troop.game] }));
  }

  /** Your column on the Dashboard-Stockpile tab: the main block, then Deals, then Market. */
  function planDashboard(grid, columnName, game, problems) {
    const header = grid[0] || [];
    const column = header.findIndex((cell) => String(cell ?? "").trim() === columnName);
    if (column < 0) {
      const shown = header.map((cell) => String(cell ?? "").trim()).filter(Boolean).join(", ");
      problems.push(`no column in row 1 of ${DASHBOARD_TAB} is named ${JSON.stringify(columnName)}. Row 1 reads: ${shown || "(empty)"}`);
      return { cells: [], stamps: [] };
    }

    const all = indexColumnA(grid);
    const marker = (label) => {
      const places = all.get(label) || [];
      if (places.length > 1) problems.push(`${JSON.stringify(label)} appears ${places.length} times in column A of ${DASHBOARD_TAB}`);
      return places.length === 1 ? places[0] : null;
    };
    const dealsAt = marker(DEALS_MARKER);
    const marketAt = marker(MARKET_MARKER);
    if (dealsAt !== null && marketAt !== null && marketAt < dealsAt) {
      problems.push(`on ${DASHBOARD_TAB}, the ${MARKET_MARKER} block must come after the ${DEALS_MARKER} block`);
      return { cells: [], stamps: [] };
    }
    const mainEnd = Math.min(...[dealsAt, marketAt, grid.length].filter((row) => row !== null));

    const cells = [];
    const stamps = [];
    const { overview, deals, market } = game;

    // Main block.
    const mainProblems = [];
    const where = `column A of ${DASHBOARD_TAB} (above ${DEALS_MARKER})`;
    const rows = resolveLabels(indexColumnA(grid, 1, mainEnd), MAIN_LABELS, where, mainProblems);
    if (!mainProblems.length) {
      const values = { ...overview.status };
      for (const good of GOODS) values[good.dashboard] = overview.resources[good.game] || 0;
      if (overview.ticks) {
        for (const good of GOODS) if (good.tick) values[good.tick] = overview.ticks[good.game] ?? "N/A";
      } else {
        problems.push("overview.php has no Ticks-Worth column, so the '- tick' rows were left alone");
      }
      for (const [label, value] of Object.entries(values)) cells.push({ tab: DASHBOARD_TAB, column, row: rows[label], value });
      stamps.push({ tab: DASHBOARD_TAB, column, row: rows.Active, value: asSheetText(overview.serverTime) });
    }
    problems.push(...mainProblems);

    // Deals and Market blocks: "Bits" plus every good, under their marker.
    const block = (label, start, end, data) => {
      if (data.unreadable) {
        problems.push(data.unreadable);
        return;
      }
      if (start === null) {
        problems.push(`no ${JSON.stringify(label)} row in column A of ${DASHBOARD_TAB}, so that block was skipped`);
        return;
      }
      const local = [];
      const where = `the ${label} block of ${DASHBOARD_TAB}`;
      const blockRows = resolveLabels(indexColumnA(grid, start + 1, end), BLOCK_LABELS, where, local);
      for (const name of Object.keys(data.goods)) {
        if (!GOOD_BY_GAME.has(name) || UNTRADEABLE.has(name)) {
          local.push(`your ${label.toLowerCase()} hold ${JSON.stringify(name)}, which the ${label} block has no row for`);
        }
      }
      if (local.length) {
        problems.push(...local);
        return;
      }
      cells.push({ tab: DASHBOARD_TAB, column, row: blockRows.Bits, value: data.bits });
      for (const good of BLOCK_GOODS) cells.push({ tab: DASHBOARD_TAB, column, row: blockRows[good.dashboard], value: data.goods[good.game] || 0 });
    };
    block(DEALS_MARKER, dealsAt, marketAt !== null && marketAt > (dealsAt ?? -1) ? marketAt : grid.length, deals);
    block(MARKET_MARKER, marketAt, grid.length, market);
    return { cells, stamps };
  }

  /** True when the sheet already holds exactly `want`. A number only matches a real number. */
  function sameValue(current, want) {
    if (typeof want === "number") return typeof current === "number" && current === want;
    return current !== undefined && current !== null && String(current) === String(want);
  }

  /** Group cells into one write op per contiguous run of rows in one column. */
  function toWriteOps(cells) {
    const sorted = [...cells].sort((a, b) => (a.tab < b.tab ? -1 : a.tab > b.tab ? 1 : a.column - b.column || a.row - b.row));
    const ops = [];
    let run = null;
    for (const cell of sorted) {
      if (run && run.tab === cell.tab && run.column === cell.column && cell.row === run.end + 1) {
        run.values.push([cell.value]);
        run.end = cell.row;
      } else {
        run = { tab: cell.tab, column: cell.column, start: cell.row, end: cell.row, values: [[cell.value]] };
        ops.push(run);
      }
    }
    return ops.map((r) => {
      const letter = columnLetter(r.column);
      return { action: "write", tab: r.tab, range: `${letter}${r.start + 1}:${letter}${r.end + 1}`, values: r.values };
    });
  }

  // ------------------------------------------------------------------------------------------
  // The sheet endpoint

  function post(payload) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: EXEC_URL,
        data: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" },
        // No Google cookies: with several Google accounts signed in, they can route the call to the
        // wrong account. The deployment is "Anyone" access and needs none.
        anonymous: true,
        timeout: REQUEST_TIMEOUT_MS,
        onload: (response) => resolve(response),
        onerror: () => reject(new Error("network error")),
        ontimeout: () => reject(new Error("timed out")),
      });
    });
  }

  /** One call, retried through Google's transient failures. Throws SyncError on a definitive one. */
  async function callSheet(payload) {
    const started = Date.now();
    let last = "no attempt made";
    for (const delay of RETRY_DELAYS) {
      if (Date.now() - started > SHEET_DEADLINE_MS) break;
      await sleep(delay * 1000);
      heartbeat();
      let response;
      try {
        response = await post(payload);
      } catch (error) {
        last = error.message;
        continue;
      }
      let body;
      try {
        body = JSON.parse(response.responseText);
      } catch (error) {
        last = /Script function not found: doGet/.test(response.responseText)
          ? "Google's one-shot result link expired"
          : /accounts\.google\.com|ServiceLogin/.test(response.finalUrl || response.responseText)
            ? "the endpoint asked for a Google sign-in -- is the deployment still 'Anyone' access?"
            : `HTTP ${response.status}, not JSON`;
        continue;
      }
      if (body && body.ok) return body;
      if (body && body.retry) {
        last = body.error || "retryable error";
        continue;
      }
      const error = new SyncError(`the sheet said: ${(body && body.error) || "unknown error"}`);
      error.definitive = true;
      throw error;
    }
    throw new SyncError(`could not reach the sheet (${last})`);
  }

  let batchSupported = true;

  /** Run ops in order; returns one {ok, values|error} per op. Falls back to one call per op. */
  async function runOps(ops) {
    if (!ops.length) return [];
    if (batchSupported) {
      try {
        const body = await callSheet({ action: "batch", ops });
        if (Array.isArray(body.results)) return body.results;
      } catch (error) {
        if (!error.definitive) throw error;
      }
      batchSupported = false; // an older deployment: it rejects "batch" as a whole
    }
    const results = [];
    for (const op of ops) {
      try {
        results.push(await callSheet(op));
      } catch (error) {
        if (!error.definitive) throw error;
        results.push({ ok: false, error: error.message.replace(/^the sheet said: /, "") });
      }
    }
    return results;
  }

  // ------------------------------------------------------------------------------------------
  // One sync

  async function sync(settings, game) {
    const { sheetName, dashboardColumn } = settings;
    const problems = [];
    const reads = [
      { action: "read", tab: sheetName, range: NATION_BUILDINGS_RANGE },
      { action: "read", tab: sheetName, range: NATION_STOCK_RANGE },
      { action: "read", tab: DASHBOARD_TAB, range: DASHBOARD_RANGE },
    ];
    const [buildingsRead, stockRead, dashboardRead] = await runOps(reads);

    const cells = [];
    const stamps = [];
    if (buildingsRead.ok && stockRead.ok) {
      cells.push(...planBuildings(buildingsRead.values, sheetName, game.overview, problems));
      const stock = planStock(stockRead.values, sheetName, game.overview, problems);
      cells.push(...stock.cells);
      stamps.push(...stock.stamps);
      cells.push(...planTroops(stockRead.values, sheetName, game, problems));
    } else {
      problems.push(`could not read tab ${JSON.stringify(sheetName)}: ${(buildingsRead.ok ? stockRead : buildingsRead).error}`);
    }
    if (dashboardRead.ok) {
      const dashboard = planDashboard(dashboardRead.values, dashboardColumn, game, problems);
      cells.push(...dashboard.cells);
      stamps.push(...dashboard.stamps);
    } else {
      problems.push(`could not read tab ${JSON.stringify(DASHBOARD_TAB)}: ${dashboardRead.error}`);
    }

    const grids = { [sheetName + "!B"]: buildingsRead.values, [sheetName + "!Q"]: stockRead.values, [DASHBOARD_TAB]: dashboardRead.values };
    const current = (cell) => {
      if (cell.tab === DASHBOARD_TAB) return cellAt(grids[DASHBOARD_TAB] || [], cell.row, cell.column);
      if (cell.column === 1) return cellAt(grids[sheetName + "!B"] || [], cell.row, 1);
      return cellAt(grids[sheetName + "!Q"] || [], cell.row, cell.column - STOCK_FIRST_COLUMN);
    };
    const stampKeys = new Set(stamps.map((s) => `${s.tab}|${s.column}|${s.row}`));
    const changed = cells.filter((cell) => !stampKeys.has(`${cell.tab}|${cell.column}|${cell.row}`) && !sameValue(current(cell), cell.value));

    // Values first, timestamps last: a failed write can then never leave a fresh stamp over stale numbers.
    const ops = [...toWriteOps(changed), ...toWriteOps(stamps)];
    const results = await runOps(ops);
    results.forEach((result, i) => {
      if (!result.ok) problems.push(`writing ${ops[i].tab}!${ops[i].range} failed: ${result.error}`);
    });
    return { written: changed.length, stamps: stamps.length, problems };
  }

  // ------------------------------------------------------------------------------------------
  // Settings and state (Tampermonkey storage, shared by every tab)

  const isConfigured = (settings) => !!(settings && settings.dashboardColumn && settings.sheetName);
  const allSettings = () => GM_getValue("settings", {});
  function saveSettings(nation, value) {
    const all = allSettings();
    all[nation] = value;
    GM_setValue("settings", all);
  }
  const stateFor = (nation) => GM_getValue("state", {})[nation] || {};
  function saveState(nation, value) {
    const all = GM_getValue("state", {});
    all[nation] = { ...(all[nation] || {}), ...value };
    GM_setValue("state", all);
  }
  /** Round-wide status: when the last round started, and a failure that stopped the whole round. */
  const roundState = () => GM_getValue("round", {});
  const saveRound = (value) => GM_setValue("round", { ...roundState(), ...value });
  /** Every nation seen on the login, so User Info can list them all. */
  const knownNations = () => GM_getValue("nations", []);
  function rememberNations(nations) {
    if (nations.length && JSON.stringify(nations) !== JSON.stringify(knownNations())) GM_setValue("nations", nations);
  }

  // ------------------------------------------------------------------------------------------
  // One round at a time, across every tab

  let holdingLock = false;
  /** While set, the session may be on another nation: {home: {id, name}, started, beat}. */
  let rotating = null;

  function takeLock() {
    if (GM_getValue("lock", 0) > Date.now()) return false;
    GM_setValue("lock", Date.now() + LOCK_MS);
    holdingLock = true;
    return true;
  }
  function releaseLock() {
    holdingLock = false;
    GM_setValue("lock", 0);
  }
  const syncing = () => GM_getValue("lock", 0) > Date.now();
  const rotationRecord = () => GM_getValue("rotation", null);

  /** Called before every request: keeps the lock, and any nation visit, from looking abandoned. */
  function heartbeat() {
    if (!holdingLock) return;
    GM_setValue("lock", Date.now() + LOCK_MS);
    if (rotating) {
      rotating.beat = Date.now();
      GM_setValue("rotation", rotating);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Visiting your other nations

  /** Switch the session back to `home` and confirm it took. Ends the visit. */
  async function switchBack(home) {
    const html = await gameRequest("overview.php", { switchnation_id: home.id });
    const active = navbarNations(parseHtml(html)).active;
    if (!active || active.id !== home.id) throw new SyncError(`could not switch the game back to ${home.name}`);
    GM_setValue("lastRotation", { started: rotating ? rotating.started : Date.now(), ended: Date.now() });
    rotating = null;
    GM_setValue("rotation", null);
  }

  /**
   * Read each of `others` by switching the session to it, then switch back to `home`.
   *
   * The game keeps one active nation per session, so this is the only way to see another nation's
   * overview, deals and forces without your password. It only happens on Sync now or while no
   * 4clop.org tab is on screen (see runRound). Everything is read first and the sheet is written
   * afterwards, so the session is away from `home` for a few page loads only. While it is, the
   * "rotation" record is set, and a 4clop.org tab you bring up says to wait (installGuard). If
   * switching back fails, the record stays, and the next round -- from any tab -- switches back
   * before anything else.
   */
  async function visitOthers(home, others) {
    rotating = { home, current: null, started: Date.now(), beat: Date.now() };
    GM_setValue("rotation", rotating);
    const results = [];
    try {
      for (const nation of others) {
        rotating.current = nation.name;
        try {
          const read = await readNation(await gameRequest("overview.php", { switchnation_id: nation.id }));
          if (read.name !== nation.name) throw new SyncError(`switching to ${nation.name} landed on ${read.name}`);
          results.push({ name: nation.name, read });
        } catch (error) {
          results.push({ name: nation.name, error });
        }
      }
    } finally {
      await switchBack(home);
    }
    return results;
  }

  // ------------------------------------------------------------------------------------------
  // A round: the nation you are on, then any others that are due

  let running = false;

  function dueInterval() {
    if (!ON_GAME) return OFFSITE_INTERVAL_MS;
    const page = location.pathname.split("/").pop() || "index.php";
    return ACTION_PAGES.includes(page) ? SYNC_DEBOUNCE_MS : SYNC_MIN_INTERVAL_MS;
  }

  async function runRound({ force = false } = {}) {
    const settings = allSettings();
    if (!Object.values(settings).some(isConfigured)) return;
    if (!force && Date.now() - (roundState().lastAttempt || 0) < dueInterval()) return;
    if (running || !takeLock()) return;
    running = true;
    saveRound({ lastAttempt: Date.now() });
    render();
    try {
      const stale = rotationRecord();
      if (stale) {
        rotating = { ...stale };
        await switchBack(stale.home);
      }

      const homeHtml = await gameRequest("overview.php");
      if (!isLoggedIn(parseHtml(homeHtml))) {
        saveRound({ error: null, loggedOut: true });
        return;
      }
      const home = await readNation(homeHtml);
      rememberNations(home.overview.nations);
      const homeRef = home.overview.nations.find((nation) => nation.name === home.name) || { id: null, name: home.name };

      // Other nations mean switching your session, so only on Sync now, or while you are not
      // looking at the game.
      const reads = [{ name: home.name, read: home }];
      const others = force || !lookingAtGame()
        ? home.overview.nations.filter((nation) =>
          nation.name !== home.name && nation.id !== null && isConfigured(settings[nation.name]) &&
          (force || Date.now() - (stateFor(nation.name).lastRead || 0) >= OTHER_NATIONS_INTERVAL_MS))
        : [];
      if (others.length && homeRef.id !== null) reads.push(...(await visitOthers(homeRef, others)));

      const api = await readApi();
      for (const { name, read, error } of reads) {
        if (isConfigured(settings[name])) await syncNation(name, settings[name], read, error, api, force);
      }
      saveRound({ error: null, loggedOut: false });
    } catch (error) {
      saveRound({ error: error.message || String(error) });
      console.error("[CLOP Sheet Sync]", error);
    } finally {
      running = false;
      releaseLock();
      render();
    }
  }

  async function syncNation(name, settings, read, readError, api, force) {
    const state = stateFor(name);
    try {
      if (readError) throw readError;
      const game = withMarket(read, api);
      const digest = JSON.stringify([settings, game.overview.status, game.overview.resources, game.overview.ticks,
        game.overview.buildings, game.deals, game.market, game.forces]);
      if (!force && state.ok && state.digest === digest && Date.now() - (state.lastWrite || 0) < UNCHANGED_REFRESH_MS) {
        saveState(name, { checkedAt: Date.now(), lastRead: Date.now() });
        return;
      }
      const result = await sync(settings, game);
      const ok = result.problems.length === 0;
      saveState(name, {
        ok,
        digest: ok ? digest : null,
        lastWrite: Date.now(),
        lastRead: Date.now(),
        checkedAt: Date.now(),
        written: result.written,
        problems: result.problems,
        error: null,
      });
    } catch (error) {
      saveState(name, { ok: false, digest: null, error: error.message || String(error), problems: [], checkedAt: Date.now(), lastRead: Date.now() });
      console.error(`[CLOP Sheet Sync] ${name}:`, error);
    }
  }

  // ------------------------------------------------------------------------------------------
  // On 4clop.org: "Working! Don't do anything..." while another nation is being read

  /** True while any 4clop.org tab is on screen (they check in every 2 seconds; see main). */
  const lookingAtGame = () => Date.now() - GM_getValue("lastSeen", 0) < LOOKING_MS;

  /**
   * Other nations are only visited on Sync now, or while no 4clop.org tab is on screen. If you bring
   * one up during a visit anyway, the page is covered with "Working! Don't do anything..." -- a
   * click or a form now would land on the other nation, so submits are cancelled too -- and once
   * the round is over it says "Done! Synced". A page loaded during the visit shows the other
   * nation, so it reloads instead. Returns true when it is reloading this page.
   */
  function installGuard() {
    const last = GM_getValue("lastRotation", null);
    const loadedAt = performance.timeOrigin;
    if (!rotationRecord() && last && loadedAt >= last.started - 5000 && loadedAt <= last.ended) {
      sessionStorage.setItem("clop-sheet-sync-finishing", "1");
      location.replace(location.href);
      return true;
    }
    const loadedDuringVisit = !!rotationRecord();
    // "working" while the visit runs, "writing" from switching back until the round ends.
    let phase = sessionStorage.getItem("clop-sheet-sync-finishing") ? "writing" : null;
    sessionStorage.removeItem("clop-sheet-sync-finishing");

    document.addEventListener("submit", (event) => {
      if (!rotationRecord()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);

    const tick = () => {
      const record = rotationRecord();
      if (record) {
        if (phase !== "working") document.activeElement?.blur();
        phase = "working";
        showNotice("working", record);
        // Nobody is finishing the visit (its tab closed): switch back from here.
        if (Date.now() - record.beat > ROTATION_STALE_MS) runRound({ force: true });
        return;
      }
      if (phase === "working") {
        if (loadedDuringVisit) {
          showNotice("reloading");
          sessionStorage.setItem("clop-sheet-sync-finishing", "1");
          location.replace(location.href);
          phase = null;
          return;
        }
        phase = "writing";
      }
      if (phase === "writing") {
        if (syncing()) {
          showNotice("writing");
        } else {
          phase = null;
          showNotice(summary().level === "ok" ? "done" : "done-problems");
          setTimeout(() => phase === null && hideNotice(), 3000);
        }
      }
    };
    tick();
    setInterval(tick, 250);
    return false;
  }

  const NOTICES = {
    working: (record) => [
      "Working! Don't do anything...",
      record && record.current
        ? `Sheet Sync is reading ${record.current}. You'll be back on ${record.home.name} in a few seconds.`
        : "Sheet Sync is reading your other nations. This takes a few seconds.",
    ],
    reloading: () => ["Done! Reloading this page...", "It was loaded while another nation was active."],
    writing: () => ["Almost done...", "Back on your nation. Writing the sheet."],
    done: () => ["Done! Synced ✓", ""],
    "done-problems": () => ["Done! Synced, with problems", "The badge in the corner lists them."],
  };

  /** "working" covers the page and blocks clicks; the rest are a small note at the top. */
  function showNotice(kind, record) {
    const [title, detail] = NOTICES[kind](record);
    let notice = document.getElementById("clop-sheet-sync-wait");
    if (!notice) {
      notice = el("div");
      notice.id = "clop-sheet-sync-wait";
      notice.append(el("div", "font:bold 22px/1.3 sans-serif"), el("div", "margin-top:6px;font:14px/1.4 sans-serif;opacity:.85"));
      document.body.appendChild(notice);
    }
    notice.style.cssText = kind === "working" || kind === "reloading"
      ? "position:fixed;inset:0;z-index:10000;background:rgba(20,22,25,.8);display:flex;flex-direction:column;" +
        "align-items:center;justify-content:center;color:#fff;text-align:center;padding:24px"
      : "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:10000;background:#2b3035;color:#fff;" +
        `padding:10px 18px;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.6);text-align:center;` +
        `border-top:4px solid ${kind === "done" ? COLORS.ok : kind === "done-problems" ? COLORS.warn : COLORS.busy}`;
    notice.dataset.kind = kind;
    notice.children[0].textContent = title;
    notice.children[1].textContent = detail;
    notice.children[1].style.display = detail ? "" : "none";
  }
  const hideNotice = () => document.getElementById("clop-sheet-sync-wait")?.remove();

  // ------------------------------------------------------------------------------------------
  // The badge

  const COLORS = { ok: "#3c8c40", warn: "#c08a1e", bad: "#b8322a", idle: "#5a6068", busy: "#2a6bb8" };
  const RANK = { idle: 0, ok: 1, warn: 2, bad: 3 };

  function describeNation(name) {
    const state = stateFor(name);
    if (state.error) return { level: "bad", line: `failed: ${state.error}` };
    if (!state.checkedAt) return { level: "idle", line: "not synced yet" };
    const when = new Date(state.checkedAt).toLocaleTimeString();
    if (state.problems && state.problems.length) {
      return { level: "warn", line: `synced at ${when} with ${state.problems.length} problem(s)`, details: state.problems };
    }
    return { level: "ok", line: `synced at ${when} (${state.written || 0} cell(s) changed last write)` };
  }

  /** What the badge and the User Info status show: one entry per configured nation, plus the round. */
  function summary() {
    const settings = allSettings();
    const names = Object.keys(settings).filter((name) => isConfigured(settings[name]));
    const round = roundState();
    const entries = names.map((name) => ({ name, ...describeNation(name) }));
    let level = entries.reduce((worst, entry) => (RANK[entry.level] > RANK[worst] ? entry.level : worst), entries.length ? "ok" : "idle");
    let note = null;
    if (!names.length) note = "Not set up -- fill in your sheet names on User Info.";
    else if (round.loggedOut) {
      note = "Not logged in to 4clop.org.";
      level = "bad";
    } else if (round.error) {
      note = `Sync failed: ${round.error}`;
      level = "bad";
    }
    return { level, entries, note };
  }

  function el(tag, style, textContent) {
    const node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (textContent !== undefined) node.textContent = textContent;
    return node;
  }

  function summaryList(info) {
    const box = el("div");
    if (info.note) box.appendChild(el("div", `color:${info.level === "bad" ? "#ff8b80" : "inherit"};margin-bottom:4px`, info.note));
    for (const entry of info.entries) {
      const line = el("div", "margin:3px 0");
      line.appendChild(el("span", `display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:${COLORS[entry.level]}`));
      line.appendChild(el("b", "", entry.name));
      line.appendChild(document.createTextNode(` ${entry.line}`));
      box.appendChild(line);
      if (entry.details) {
        const list = el("ul", "margin:2px 0 6px 18px;padding:0");
        for (const problem of entry.details) list.appendChild(el("li", "", problem));
        box.appendChild(list);
      }
    }
    return box;
  }

  let lastRendered = "";

  function render() {
    if (!ON_GAME || !document.body) return;
    const info = summary();
    const busy = syncing();
    const expanded = GM_getValue("ui.expanded", false);
    const signature = JSON.stringify([info, busy, expanded]);
    if (signature === lastRendered && document.getElementById("clop-sheet-sync-badge")) return;
    lastRendered = signature;

    const status = document.getElementById("clop-sheet-sync-status");
    if (status) {
      status.replaceChildren(summaryList(info));
      if (busy) status.prepend(el("div", `color:${COLORS.busy}`, "Syncing..."));
    }

    document.getElementById("clop-sheet-sync-badge")?.remove();
    const badge = el("div", "position:fixed;right:12px;bottom:12px;z-index:9999;font:12px/1.4 sans-serif;color:#fff");
    badge.id = "clop-sheet-sync-badge";
    const problems = info.entries.reduce((n, entry) => n + (entry.details ? entry.details.length : 0), 0);

    if (!expanded) {
      const icon = busy ? "⟳" : { ok: "✓", warn: "⚠", bad: "✕", idle: "•" }[info.level];
      const pill = el("button",
        "border:0;border-radius:14px;padding:5px 12px;color:#fff;cursor:pointer;font:inherit;font-weight:bold;" +
        `box-shadow:0 1px 4px rgba(0,0,0,.5);background:${busy ? COLORS.busy : COLORS[info.level]}`,
        `${icon} Sheet${problems ? ` (${problems})` : ""}`);
      pill.title = "Sheet Sync -- click to open";
      pill.addEventListener("click", () => {
        GM_setValue("ui.expanded", true);
        render();
      });
      badge.appendChild(pill);
      document.body.appendChild(badge);
      return;
    }

    const card = el("div",
      "width:340px;max-width:calc(100vw - 24px);background:#2b3035;border:1px solid #1c1e22;border-radius:6px;" +
      `box-shadow:0 2px 10px rgba(0,0,0,.6);border-top:4px solid ${busy ? COLORS.busy : COLORS[info.level]}`);
    const head = el("div", "display:flex;align-items:center;justify-content:space-between;padding:7px 10px;font-weight:bold;font-size:13px");
    head.appendChild(el("span", "", "Sheet Sync"));
    const collapse = el("button", "border:0;background:none;color:#ccc;cursor:pointer;font:bold 16px/1 sans-serif;padding:0 2px", "–");
    collapse.title = "Collapse";
    collapse.addEventListener("click", () => {
      GM_setValue("ui.expanded", false);
      render();
    });
    head.appendChild(collapse);
    card.appendChild(head);

    const body = el("div", "padding:0 10px 8px;max-height:45vh;overflow:auto");
    body.appendChild(summaryList(info));
    card.appendChild(body);

    const button = el("button",
      "display:block;width:calc(100% - 20px);margin:0 10px 10px;padding:8px;border:0;border-radius:4px;" +
      `font:bold 14px sans-serif;color:#fff;cursor:${busy ? "default" : "pointer"};background:${busy ? COLORS.busy : COLORS.ok}`,
      busy ? "⟳ Syncing..." : "⟳ Sync now");
    button.disabled = busy || !info.entries.length;
    button.addEventListener("click", () => runRound({ force: true }));
    card.appendChild(button);
    badge.appendChild(card);
    document.body.appendChild(badge);
  }

  // ------------------------------------------------------------------------------------------
  // User Info: the two names, for every nation on the login

  function addSettingsForm() {
    const anchor = document.querySelector('form[name="newpassword"]');
    if (!anchor || document.getElementById("clop-sheet-sync-form")) return;
    // The navbar's nation switcher lists the whole empire, so every nation gets its own row here
    // and nobody has to switch nations just to fill them in.
    const seen = navbarNations(document).all;
    const names = (seen.length ? seen : knownNations()).map((nation) => nation.name);
    const settings = allSettings();

    const form = document.createElement("form");
    form.id = "clop-sheet-sync-form";
    form.innerHTML = `
      <center><h5>Spreadsheet Sync</h5></center>
      <center><table>
        <tr><th>Nation</th><th>Dashboard Column Name</th><th>Sheet Name</th></tr>
      </table></center>
      <center><input type="submit" value="Save Sheet Settings" class="btn btn-sm btn-warning"/>
      <input type="button" name="syncnow" value="Sync Now" class="btn btn-sm btn-success"/></center>
      <center><small id="clop-sheet-sync-status" style="display:inline-block;text-align:left"></small></center>
      <br/>`;
    const table = form.querySelector("table");
    for (const name of names) {
      const row = document.createElement("tr");
      row.dataset.nation = name;
      row.innerHTML = `<td style="padding-right:8px"></td>
        <td><input name="dashboardColumn" class="form-control" style="width:200px;" placeholder="e.g. LePone(Z)" autocomplete="off"/></td>
        <td><input name="sheetName" class="form-control" style="width:200px;" placeholder="e.g. LePone(Z)" autocomplete="off"/></td>
        <td class="clop-guess" style="padding-left:8px;font-size:12px;opacity:.8"></td>`;
      row.cells[0].textContent = name;
      const current = settings[name] || {};
      row.querySelector('[name="dashboardColumn"]').value = current.dashboardColumn || "";
      row.querySelector('[name="sheetName"]').value = current.sheetName || "";
      table.appendChild(row);
    }
    const save = () => {
      for (const row of table.querySelectorAll("tr[data-nation]")) {
        saveSettings(row.dataset.nation, {
          dashboardColumn: row.querySelector('[name="dashboardColumn"]').value.trim(),
          sheetName: row.querySelector('[name="sheetName"]').value.trim(),
        });
      }
    };
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      save();
      for (const name of names) saveState(name, { digest: null, error: null, problems: [], checkedAt: 0 });
      runRound({ force: true });
    });
    form.syncnow.addEventListener("click", () => {
      save();
      runRound({ force: true });
    });
    anchor.parentNode.insertBefore(form, anchor);
    guessNames(table).catch((error) => console.warn("[CLOP Sheet Sync] could not guess sheet names:", error));
  }

  /**
   * Fill in any empty row from the sheet itself: the Dashboard column whose header is the nation's
   * name (alone, or followed by its "(Z)"-style region tag), and the tab of that same name, else the
   * plain nation name, whichever exists. Nothing is saved until you press Save.
   */
  async function guessNames(table) {
    const field = (row, name) => row.querySelector(`[name="${name}"]`);
    const blank = (row) => !field(row, "dashboardColumn").value.trim() && !field(row, "sheetName").value.trim();
    const rows = [...table.querySelectorAll("tr[data-nation]")].filter(blank);
    if (!rows.length) return;
    const [header] = await runOps([{ action: "read", tab: DASHBOARD_TAB, range: "A1:AZ1" }]);
    if (!header.ok) return;
    const columns = (header.values[0] || []).map((cell) => String(cell ?? "").trim()).filter(Boolean);
    for (const row of rows) {
      const nation = row.dataset.nation;
      const column = columns.find((name) => name === nation) ||
        columns.find((name) => name.startsWith(`${nation}(`) || name.startsWith(`${nation} (`));
      const candidates = [...new Set([column, nation].filter(Boolean))];
      const probes = await runOps(candidates.map((tab) => ({ action: "read", tab, range: "A1" })));
      const tab = candidates.find((_, i) => probes[i].ok);
      if (!blank(row) || (!column && !tab)) continue; // you started typing, or there is nothing to suggest
      if (column) field(row, "dashboardColumn").value = column;
      if (tab) field(row, "sheetName").value = tab;
      row.querySelector(".clop-guess").textContent = "← found in the sheet; check it, then Save";
    }
  }

  // ------------------------------------------------------------------------------------------

  function main() {
    if (ON_GAME) {
      // Your own page load counts toward the one-request-a-second limit too, from when the server
      // finished answering it.
      const navigation = performance.getEntriesByType("navigation")[0];
      const answered = Math.round(performance.timeOrigin + (navigation ? navigation.responseEnd : 0));
      GM_setValue("lastGameRequest", Math.max(GM_getValue("lastGameRequest", 0), answered));
      if (location.pathname.startsWith("/api/") || !isLoggedIn(document)) return;
      rememberNations(navbarNations(document).all);
      // Tell other tabs you are looking at the game, so they leave your other nations alone.
      const markSeen = () => document.visibilityState === "visible" && GM_setValue("lastSeen", Date.now());
      markSeen();
      document.addEventListener("visibilitychange", markSeen);
      setInterval(markSeen, 2000);
      if (installGuard()) return;
      if (location.pathname.endsWith("userinfo.php")) addSettingsForm();
      render();
      for (const key of ["state", "round", "lock", "settings", "ui.expanded"]) GM_addValueChangeListener(key, () => render());
    }
    runRound();
    // Checking more often than the interval is what lets the throttle fire on time.
    setInterval(() => runRound(), (ON_GAME ? SYNC_MIN_INTERVAL_MS : OFFSITE_INTERVAL_MS) / 4);
  }

  main();
})();
