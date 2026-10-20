# Multi-nation accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Watch and sync every nation on one CLOP login, never writing one nation's numbers to another's tab.

**Architecture:** The client finds the account's nations from the header switcher (or the empire
overview for a one-nation account), switches the session to each in turn and confirms the switch
before reading. A one-nation account keeps today's flat `Snapshot`. A multi-nation account's
`Snapshot` carries one nested `NationSnapshot` per nation holding that nation's reports, market
view and overview page, and `build_alerts` recurses into them. The `nations` section of
`settings.json` maps each nation to a tab and sheet URL. Spec:
`docs/superpowers/specs/2026-10-20-multi-nation-design.md`.

**Tech Stack:** Python 3 stdlib, unittest/pytest (`python -m pytest -q`).

**Findings that shaped this plan (beyond the spec):**
- Buyer-market colours are per *user* (`buyermarketplace.php:65`, embargoes by `user_id`), so the
  order list is the same for every nation on the login. It is fetched once per poll with no
  roster, and each nation's alliance roster is applied afterwards (`apply_roster`).
- header.php renders the switcher `<select>` only for more than one nation
  (`header.php:181-186`), so "no select" means a one-nation account.
- `allfunctions.php:13-24` handles `switchnation_id` on every page and then clears `$_POST`, so
  POSTing only `switchnation_id` to `overview.php` is side-effect free (it is what the empire
  overview's own buttons do).
- `Stockpiles.nation_name` (from overview.php) is a second, independent check that a page belongs
  to the nation expected; the sheet step refuses to write when it disagrees.

---

### Task 1: Parse the account's nations

**Files:** Modify `clop_monitor.py` (parsers near `parse_current_nation_id`); Test `test_clop_monitor.py`.

- [ ] Add `AccountNation(nation_id: int, name: str)` frozen dataclass.
- [ ] `parse_header_nations(html) -> List[AccountNation]` from the `switchnation_id` select options
  (digit values only), and `parse_empire_nations(html) -> List[AccountNation]` from the empire
  overview's buttons (extend `ButtonValueParser` to record each button's text).
- [ ] Tests: two-option select → two nations in order; header with no select → `[]`; empire page
  with one button → one nation with its name; `parse_empire_nation_ids` unchanged.
- [ ] Run `python -m pytest -q test_clop_monitor.py`, commit.

### Task 2: Discover and switch in the client

**Files:** Modify `ClopClient` in `clop_monitor.py`; Test `test_clop_monitor.py`.

- [ ] Fields: `nations: Tuple[AccountNation, ...] = ()`, `switchable = False`,
  `active_nation_id: Optional[int] = None`.
- [ ] `discover_nations()`: GET `index.php` (log in if logged out); header select → `switchable =
  True`; otherwise the empire overview must list exactly one nation, else `MonitorError`.
- [ ] `select_nation(nation)`: no-op bookkeeping on a one-nation account; otherwise POST
  `{"switchnation_id": id}` to `overview.php`, then require `parse_current_nation_id(html) == id`,
  else raise `NationSwitchError(MonitorError)`.
- [ ] `login()`: after a successful login on a switchable account with an `active_nation_id`,
  switch back to it before returning (returns the switch response, which carries the same header
  counts), so no re-login anywhere can leave the session on the game's default nation.
- [ ] Tests: discovery both ways; switch POST form exactly `{"switchnation_id": "34"}`; mismatched
  selected option raises; re-login re-selects; one-nation account never POSTs a switch.
- [ ] Run tests, commit.

### Task 3: Per-nation reads and alerts

**Files:** Modify `Snapshot`, `ClopClient.snapshot`, `build_alerts`, `market_order_alerts`,
`check_and_notify`, `market_preflight`, `_alliance_roster`; Test `test_clop_monitor.py`.

- [ ] `NationSnapshot(nation_id, name, snapshot: Snapshot, overview_html: Optional[str] = None,
  skipped: Optional[str] = None)`; `Snapshot.nations: Tuple[NationSnapshot, ...] = ()`.
- [ ] `to_json`/`from_json` persist each nation's `nation_id`, `name`, `latest_report`,
  `reports_checked`; an old file without `nations` still loads.
- [ ] `ClopClient.snapshot(include_market=True, stockpiles=None, overview_for=frozenset())`:
  on a switchable account with `include_market=True`, read login-level pages once, then for each
  nation: `select_nation`, read reports, read overview when market is watched or its id is in
  `overview_for` (checking `Stockpiles.nation_name` matches), apply its roster to the once-fetched
  orders. A `MonitorError` other than `AuthenticationError` during a nation's turn becomes
  `skipped`. `include_market=False` (the post-dismissal refresh) reads only login-level pages.
- [ ] `market_preflight` resolves `alliance_ids: Dict[int, int]` for every nation when switchable
  (via `viewnation.php`, no switching needed); `_alliance_roster(alliance_id=None)`.
- [ ] `build_alerts(..., own_nations=frozenset())`: recurse into `current.nations` with the
  login-level categories muted, prefix each alert with `"<nation>: "`; `market_order_alerts`
  ignores any buyer named in `own_nations`.
- [ ] `check_and_notify`: notify skipped nations via `notify_failure`; keep each skipped nation's
  previous marker; after a dismissal keep `current.nations`.
- [ ] Tests: two-nation poll alerts each nation's report with its name; a skipped nation keeps its
  marker and raises a failure; own-nation buyers ignored; roster per nation; state round-trip.
- [ ] Run tests, commit.

### Task 4: `nations` settings and the sync plan

**Files:** Modify `load_settings`, `settings_changes`, `MonitorSettings`; add `plan_sheet_sync`;
Test `test_clop_monitor.py`.

- [ ] `NationSettings(tab: Optional[str], sheet_url: Optional[str], sync: bool = True)`;
  `MonitorSettings.nations: Optional[Tuple[Tuple[str, NationSettings], ...]]` (None = absent).
  Keys starting with `_` are help text and ignored. Validate types; `sheet_url` must be https.
- [ ] `plan_sheet_sync(nations, configured, env_nation) -> Tuple[Dict[int, Tuple[str, str]],
  List[str]]` giving `{nation_id: (tab, sheet_url)}` and warnings, per the spec's rules.
- [ ] Tests for every rule in the spec's Configuration section.
- [ ] Run tests, commit.

### Task 5: Main loop

**Files:** Modify `main`, `sync_sheet_step` (add `expected_nation`); update fake clients in
`test_clop_monitor.py` (`PollingClient`, `FailingClient`) with `discover_nations`.

- [ ] After login: `discover_nations()`, print the nations, plan sync, `require_tab` per target
  with one `GoogleSheet` per distinct URL (same weather/config split as today).
- [ ] Re-plan when `settings.nations` or the account's nations change.
- [ ] Per poll: one-nation path unchanged; multi-nation reads overview inside the snapshot and the
  sync loop uses each nation's page, switching only when it must re-read (after a dialog).
- [ ] `sync_sheet_step(..., expected_nation=None)` refuses to write when the page's nation name
  differs.
- [ ] Run full suite, commit.

### Task 6: Docs and live check

- [ ] `.env.example`, `settings.example.json` (`nations` with help text), README config section.
- [ ] `python clop_monitor.py --once` against the real account; confirm the per-nation output.
- [ ] Commit.
