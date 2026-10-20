# Multi-nation accounts — design

## Problem

A CLOP player has one login, which can own several nations. The game keeps the active nation in
the PHP session (`$_SESSION['nation_id']`). On login it picks whichever nation the database returns
first (`backend_login.php:57`, no `ORDER BY`), and a POST of `switchnation_id` to any page changes
it (`allfunctions.php:13`).

The monitor never chooses. It logs in, reads whatever nation the session landed on, and writes
that nation's buildings and stockpiles into the one tab named by `CLOP_NATION`. On a multi-nation
account that overwrites a tab with another nation's numbers. It also re-logs in mid-run whenever
alliance messages are pending (`clop_monitor.py` `snapshot`), which can land the session on a
different nation partway through. Reports are per nation too (`backend_reports.php:5`), so reports
for every nation but the landed one are never seen.

## Discovering the nations

At startup and every poll, from the page already fetched for the message counts:

- If the header has the `switchnation_id` select, its options are the account's nations
  (id + in-game name). header.php renders it only for accounts with more than one nation.
- Otherwise the account has one nation; its id comes from the empire overview's single
  `switchnation_id` button, as `_own_nation_id` does today.

## Per poll

Read **once per login**: user messages, alliance messages, news, 4chan, the buyer's market page.

Read **once per nation**, in dropdown order:

1. POST `switchnation_id=<id>`, then confirm the header's selected option is that id. On a
   single-nation account there is nothing to switch and nothing to confirm.
2. If the confirmation fails, skip the nation for this poll and raise a failure alert. Nothing is
   written to its sheet. A wrong nation must never reach a tab.
3. Read `overview.php` and `reports.php` and run the report alerts against that nation's own
   baseline. Report alerts name the nation.
4. Sync the nation's sheet (buildings, stockpile block, Dashboard column) with its own fingerprint
   cache.

Any re-login during a nation's turn sends it back to step 1 before anything else is read, so a
fresh session's default nation is never trusted.

Market alerts: orders from **any** of the account's own nations are ignored, not just the active
one. Availability is judged per nation against that nation's stockpile and reserves, and each
alert names the nation that can fill it. The alliance roster is looked up per nation, because one
account's nations can be in different alliances.

## Configuration

Secrets stay in `.env`: `CLOP_USERNAME`, `CLOP_PASSWORD`, `CLOP_WEBHOOK_URL`.

The nation → sheet mapping goes in `settings.json`, which is git-ignored and hot-reloaded:

```json
"nations": {
  "Le Pone":      { "tab": "LePone(Z)" },
  "Other Nation": { "tab": "Other", "sheet_url": "https://script.google.com/macros/s/.../exec" },
  "Alt Nation":   { "sync": false }
}
```

- Keys are in-game nation names, exactly as the dropdown shows them.
- `tab` is the sheet tab name; it is also the name looked up in row 1 of `Dashboard-Stockpile`.
  Defaults to the in-game name.
- `sheet_url` is the Apps Script `/exec` URL of that nation's spreadsheet. Defaults to
  `sheets.EXEC_URL`. Different spreadsheets share the same layout; only the URL and tab names
  differ. Layout ranges stay fixed in code.
- `sync: false` keeps the nation's report and market alerts but writes no sheet.
- A nation on the account with no entry is still watched for reports, but not synced, and a
  startup alert lists it so it is not silently skipped. An entry naming no nation on the account
  raises the same alert.
- Each distinct `sheet_url` gets one `GoogleSheet`; every configured tab is checked at startup
  with the same rules as today (missing tab → that nation's sync off; unreachable → stays on).

Backward compatibility: with no `nations` section, a set `CLOP_NATION` keeps today's meaning, but
only applies when the account has exactly one nation. On a multi-nation account `CLOP_NATION` alone
raises a startup alert asking for a `nations` section, and no sheet is written. Guessing which
nation it meant is the bug this design removes.

## State

A one-nation account keeps today's flat `Snapshot` and state file unchanged, so its report marker
carries over with nothing lost. A multi-nation account's `Snapshot` carries one `NationSnapshot`
per nation (its reports, market view, stockpile and overview page), and `.state/clop-monitor.json`
gains a `nations` list holding each nation's id, name and report marker. A state file from before
this change has no `nations` list and loads as before. On a multi-nation account its flat marker
belongs to whichever nation the old session happened to be on, so it is not reused: the first poll
is a fresh baseline for every nation (no alert storm, no false alerts). A skipped nation keeps its
previous marker. The sheet fingerprints are in memory only, per nation.

## Discovered during implementation

- The buyer market colours friends and enemies by user (`buyermarketplace.php:65`, embargoes by
  `user_id`), so the order list is identical for every nation on a login. It is fetched once per
  poll, and each nation's alliance roster is applied afterwards (`apply_roster`). Only alliance
  differs between an account's nations; each nation's alliance is resolved by the market preflight
  from `viewnation.php`, which needs no switching.
- There are three independent checks that a page belongs to the nation expected: the header's
  selected option after the switch, the same on `reports.php`, and the nation name overview.php
  prints (`require_page_nation`, also applied inside `sync_sheet_step` via `expected_nation`).
- An absent `nations` section is not listed among "settings using defaults": it means
  `CLOP_NATION` names the tab, which is the normal one-nation setup.
- `settings.example.json` ships the section as `_nations_example`, which is inert, because a live
  example with made-up names would turn on the `nations` rules (and ignore `CLOP_NATION`) for anyone
  who copied the file.

## Testing

Unit tests against captured HTML, matching the existing suite:

- discovery from a header with the select, and from the empire overview without it;
- the switch is confirmed, and a mismatched selected option skips the nation with no sheet write;
- a re-login mid-nation switches again before reading;
- reports and fingerprints stay separate per nation;
- market ignores all own nations and names the filling nation;
- settings: defaults, `sync: false`, unknown/unlisted nations, per-nation `sheet_url`, and the
  `CLOP_NATION` fallback on one- and multi-nation accounts;
- an old single-nation state file loads without alerting.

Then one live `--once` run against a multi-nation account, checking each tab got its own numbers.
