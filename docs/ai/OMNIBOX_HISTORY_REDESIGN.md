# Omnibox (address/search bar) + browsing history — analysis and redesign plan

Owner request (2026-09-25): the address/search bar "feels wrong"; study the current
implementation, propose the best way to handle the address + search bar, and add a proper
browsing history.

Companion docs: [PROJECT_MAP.md](PROJECT_MAP.md) (architecture, §6 "Browser shell"),
[AUDIT-2026-09.md](AUDIT-2026-09.md) (bug ids; this doc adds A-397…A-403),
[PRODUCTION_PLAN.md](PRODUCTION_PLAN.md).

---

## 1. Where we start (verified 2026-09-25, app launched with `CUPNET_MITM_PORT=8899` + Playwright)

### 1.1 Pieces and files

| Piece | Where | Notes |
|---|---|---|
| Input + committed-URL state | `browser-renderer.js` 10–330 (`_setToolbarUrl`, `_setToolbarUrlIfChanged`, `_urlInputDirty`, `_committedToolbarUrl`) and 651–668 (`_scheduleTabUiUpdate`) | Two Enter handlers: `urlInput` keydown at :86 (only when the list is closed) and the capture-phase `onCommandPaletteGlobalKeydown` at :2690 (almost always the one that runs). |
| Suggestion rows | `browser-renderer.js` 2261–2560 (`renderOmniboxList`, `OMNIBOX_QUICK_LINKS`, `_looksLikeUrlOrHost`, `_buildExactTypedUrlRow`, `_cupnetFuzzyMatch`) | Row order is hard-coded: `[typed URL] [Search <engine> for] [≤4 tabs] [quick links] [history]`, sliced to 24. |
| Dropdown surface | `omnibox-overlay.html` + `preload-omnibox-overlay.js`; `tab-manager.js` 1038–1125 (`showOmniboxOverlay`, `hideOmniboxOverlay`, `_layoutOmniboxOverlayBounds`) | A separate `WebContentsView` above the tab (required: the tab view paints over shell DOM). Created lazily, destroyed by `switchTab`; own partition `persist:cupnet_omnibox_overlay`, proxy direct; inline script (`'unsafe-inline'`). |
| Input → URL | `utils.js` `resolveNavigationUrl` / `resolveNavigationUrlWithBase` / `resolveLoadUrlForWebContents`; `main-process/ipc/handlers/tabs-ipc.js` `navigate-to` (aliases `cupnet://settings|guide|identity-check|home|new-tab`) | The renderer re-implements the same heuristic in `_looksLikeUrlOrHost` (drifts). |
| Search engine | `utils.SEARCH_ENGINES` (duckduckgo/google/brave/yandex + custom `{q}`), `settings-store.normalizeSearchEngineSettings`, `cupnet-runtime.getSearchEngineUrl()`; label in the shell from the one-shot `init-settings` | `new-tab.html` has its **own** engine list (google/duckduckgo/yandex.ru/bing) in partition localStorage (A-338). |
| History store | `db.js` 855–869 (`omnibox_history(url UNIQUE, host, title, visit_count, typed_count, last_visit_at)`), 2260–2400 (`recordOmniboxVisit`, `getOmniboxSuggestions`, `_omniboxFrecency`, `getOmniboxTopHosts`) | Frecency `(visits + 3·typed)·e^(−age/14d)`. Candidates: `LIKE '%q%'` on host/url/title, `ORDER BY last_visit_at LIMIT 80`, scored in JS. Falls back to `requests.host` top hosts. |
| Recording | `tab-manager.js` 314–333: `did-navigate` → `db.recordOmniboxVisit({url, title: getTitle(), typed})`; `typed` comes from `_pendingOmniboxTypedTabIds` set by `navigate(url, tid, {omniboxTyped:true})` | `navigate-to` always passes `omniboxTyped:true` (also for new-tab quick links). |
| IPC | `preload.js` `getOmniboxSuggestions/getOmniboxTopHosts/recordOmniboxVisit`, `showOmniboxOverlay/hideOmniboxOverlay/updateOmniboxOverlay`, `onOmniboxOverlaySelect/Dismiss`, `onForceCloseOmnibox`; handlers in `db-logging-ipc.js` and `misc-ipc.js` | `record-omnibox-visit` is exposed to the shell but never called from it. |
| Tests | `tests/unit/utils.test.mjs` (URL resolution), `tests/unit/omnibox-history.test.mjs` (skipped unless better-sqlite3 loads under Node), `tests/e2e/omnibox.e2e.spec.js` omni-1…7 | omni-2 **asserts that there is no inline autocomplete**; the guide (`scripts/guide-i18n/*.mjs` "omnibox") promises inline autocomplete + Tab. |
| Docs/UI text | `scripts/guide-i18n/en.mjs` #omnibox, hint string at `browser-renderer.js:2356` (" · Tab complete") | Both describe features that do not exist (A-212). |

### 1.2 What the user actually sees today (screenshots taken 2026-09-25)

1. **Focus the bar (Ctrl+L / click) on wikipedia.org** → two rows only: `Open https://www.wikipedia.org/`
   (redundant, it is the current page) and one history row. There is no "recent / top sites" list,
   because the query sent to the DB is the *selected current URL*, not an empty string.
2. **Type `htt`** → row 1 (highlighted, what Enter does) is `Search DuckDuckGo for "htt"`, although
   `httpbin.org/get` and `httpbin.org/html` are in history. `User guide` also appears, because the
   subsequence fuzzy matcher finds h‑t‑t inside "help documentation manual".
3. **Type `wiki`** → row 1 is `Search DuckDuckGo for "wiki"`; Enter searches even though
   wikipedia.org was visited a minute ago. No inline completion, Tab does nothing (closes the list).
4. **Type `localhost:3000`** → the only row is `Search DuckDuckGo for "localhost:3000"` (A‑067/A‑391).
5. **History titles are wrong:** rows read `wikipedia.org`, `httpbin.org/html` — the title captured at
   `did-navigate` is Chromium's placeholder (URL), and the real `page-title-updated` never updates the row.
6. While typing, any tab title/favicon/URL change (even in a background tab) resets the input to the
   current URL (A‑017); switching to another app and back discards the draft (A‑211).
7. There is **no history UI at all**: no History window/page, no menu item, no "recently closed",
   no way to delete a row or clear history (`omnibox_history` rows are never deleted — `clear-logs`
   only touches request logs). Isolated-tab visits are mixed into the same list without a marker.

### 1.3 Root causes (why it "feels wrong")

- **No "default match" concept.** Chrome's rule is *row 1 == what Enter does, and row 1 is the best
  guess (history/shortcut first)*. Here row 1 is a fixed literal ("typed URL" or "search"), history is
  appended at the end, and Enter ignores the highlight unless the user pressed ↑/↓.
- **Two URL heuristics** (`utils.resolveNavigationUrl` in main, `_looksLikeUrlOrHost` in the shell)
  that both miss `localhost`, `host:port`, IPv6 and single-label intranet hosts.
- **Input state is fragile:** three writers (tab-list update, url-updated, will-navigate) can overwrite
  the field while the user is typing; the `dirty` flag is not cleared on Enter; blur reverts.
- **History is an omnibox side-table, not a history.** One aggregate row per URL, wrong titles, no
  visit log, no in-page (SPA) navigations, no delete/clear/retention, no UI.
- **Ranking prefilter is recency-only** (`ORDER BY last_visit_at LIMIT 80` before scoring), so with
  a few hundred rows a frequently used but not-recent site can drop out of the candidate set.
- **Search engine setting is not propagated** (label stale, A‑208) and the start page has a separate
  engine list (A‑338).

---

## 2. Target behaviour (spec)

Design goal: behave like Chrome's omnibox where the user expects it, add the things a traffic-analysis
browser needs (isolated tabs, dev hosts, quick tool commands), and keep everything testable.

### 2.1 Input classification (single implementation, shared by main and shell)

`classifyOmniboxInput(text, { base }) → { kind: 'url'|'search'|'command'|'internal', url?, query? }`

| Input | Result |
|---|---|
| `> …` | `command` (palette) |
| `cupnet://settings`, `cupnet:guide`, `cupnet://home`, `cupnet://newtab`, `cupnet://identity-check` | `internal` (aliases normalised in one map; A‑203) |
| `scheme://…` (any valid URL) | `url` as is |
| `localhost[:port][/…]`, `[::1][:port]`, `127.…`, `10.…`, `192.168.…`, `172.16‑31.…`, `0.0.0.0` | `url` with **http://** |
| `1.2.3.4[:port][/…]` | `url` with http:// |
| `host:port[/…]`, `single-label/path` (intranet) | `url` with http:// |
| `word.tld[/…]` (no spaces) | `url` with https:// |
| `/path` while on a site | `url` resolved against the current origin (existing behaviour) |
| anything else (spaces, no dot) | `search` via the configured engine |

Lives in a new dependency-free file `omnibox-input.js` (CommonJS export + `window.CupNetOmniboxInput`
guard so `browser.html` can load it with `<script>` and `utils.js` can `require` it). Replaces
`_looksLikeUrlOrHost` and the heuristic inside `resolveNavigationUrl` (the latter keeps its signature).

### 2.2 Row composition (max 8 rows; today 24)

Query `q` non-empty:

1. **Default match** — what Enter opens. Chosen in this order:
   1. a learned **shortcut** (`omnibox_shortcuts`: the user typed this prefix before and picked a URL);
   2. a history row whose **host starts with `q`** (or a host label after a dot starts with `q`, e.g.
      `wiki` → `www.wikipedia.org`) with frecency above a small threshold → shown as
      `wikipedia.org — Wikipedia` and **inline-completed** in the field (see 2.4);
   3. otherwise the typed text itself: `Open http://localhost:3000` for `url` kinds, or
      `Search Google for "…"` for `search` kinds.
2. **The alternative primary action** — if row 1 is a history/shortcut row, row 2 is
   `Search <engine> for "q"` (or `Open q` when `q` classifies as `url`); if row 1 is the typed text and
   `q` is url-like, row 2 is the search row. Never both "Open" and "Search" for a clear `scheme://` URL.
3. **Switch to tab** (≤2, other tabs whose URL/title contain `q`; isolated tabs get a badge).
4. **History** (≤4, ranked, excluding row 1) — title + URL preview, badge for isolated-tab origin.
5. **Quick links** only on **prefix/word-boundary** match of their keywords (`set` → Settings,
   `gui` → User guide, `ident` → Identity check, `home` → Start page). No subsequence fuzzy (A‑401).

Query empty (bar focused, text unchanged or cleared) → **zero-suggest**:
`Recent` (≤6 by `last_visit_at`, deduped by host+path) · `Top sites` (≤4 by frecency, hosts only, not
already listed) · quick links (Settings, Guide, Identity check). Row 1 highlighted but Enter with an
unchanged URL simply reloads, as in Chrome.

Command mode (`>`): unchanged list; matching switches from subsequence to *word-prefix* with a
subsequence fallback only when word-prefix finds nothing.

### 2.3 Ranking

Candidates (SQL, up to 300): `host LIKE 'q%'` OR `host LIKE '%.q%'` OR `url LIKE '%q%'` OR
`title LIKE '%q%'` (ESCAPE as today), `hidden = 0`, ordered by `visit_count + 3·typed_count` DESC (not
by recency — fixes the prefilter cut-off). Scoring in JS (pure, unit-tested):

```
frecency = (visit_count + 3·typed_count) · e^(−ageDays/14)          (unchanged)
boost    = shortcut 8 · host-prefix 3 · host-label-prefix 2 · title-word-prefix 1.5
           · url-substring 1 · title-substring 0.7
score    = frecency · boost
```

Only `shortcut` / `host-prefix` / `host-label-prefix` rows may become the default match, and only when
`q.length ≥ 2`. Shortcuts: on every omnibox-initiated navigation store
`(lower(typed text) → final URL)` with hit count; Chrome does the same ("shortcuts database"), it is
what makes `wiki` → wikipedia.org stick after one use.

### 2.4 Keyboard and mouse

| Key | Action |
|---|---|
| Enter | open row 1 (default match) — or the highlighted row after ↑/↓ |
| ↑ / ↓ | move highlight; the field shows the highlighted row's URL (Chrome behaviour), ↑ from row 1 returns to the typed text |
| Tab / → at end of text | accept the inline completion (only when a completion is shown) |
| Esc | 1st: close list + revert text to the committed URL (keep focus); 2nd: blur (Esc while loading and the list closed still = Stop) |
| Cmd/Ctrl+Enter, Alt+Enter | open in a **new tab** (only if `newTab()` returned an id — A‑205) |
| Shift+Enter | open in a **new isolated tab** (product-specific; replaces today's odd "navigate raw") |
| Shift+Delete (Shift+Fn+Backspace on mac) | remove the highlighted history row from suggestions (`hidden=1`) |
| Cmd/Ctrl+K | command mode (`>`), unchanged |
| Click on the bar | select all + zero-suggest; typing replaces |
| Right-click on the bar | native menu: Paste and go · Paste · Copy · Cut · Select all · Edit URL (A‑403) |

Inline completion rules (the part omni‑2 currently forbids): complete **only** the host portion of a
host-prefix / shortcut match, only when the user is appending at the end of the text (never on
delete/backspace, never mid-string), completion is selected text so Backspace removes it. Setting
`omnibox.inlineComplete` (default on) to disable.

### 2.5 Input state machine (fixes A‑017, A‑206, A‑211)

States: `idle` (shows committed URL, `.url-display` layer) → `editing` (focused; `draft` string) →
`open` (editing + list visible). Rules:

- Tab-list/title/favicon updates **never** write into the field while `editing`; only a real active-tab
  switch (`active.id` changed) does (`_lastActiveTabIdForUrl`).
- `url-updated` / `tab-url-changed` update the committed URL and the display layer only.
- `will-navigate` (link click) forces the field, as today (a user click means they abandoned the draft).
- Enter clears the draft (`dirty=false`) *before* sending `navigate-to`.
- Blur: revert only when focus moved elsewhere inside the window; if the **window** lost focus keep the
  draft and restore it on window focus.
- One keydown handler (capture-phase) — remove the duplicate at `browser-renderer.js:86`.

### 2.6 Search

- One engine list: `utils.SEARCH_ENGINES` (+ Bing) is the source of truth; `new-tab.html` reads the
  configured engine through a read-only `get-search-engine` IPC in `preload-view.js` and builds the
  URL with the same template helper (A‑338). Per-click engine choice on the start page persists via
  `setUiPref`, not partition localStorage.
- Engine changes broadcast to the shell (`browser-settings-updated` carries `searchEngine`), so the
  "Search <engine> for" label is always right (A‑208).
- Optional (phase D): engine keywords `g foo`, `ddg foo`, `y foo`, and scopes `@tabs …`, `#history …`.

### 2.7 History (new)

**Recording** (`history-service.js`, main):

- `did-navigate` → visit with `transition` ∈ `typed | link | redirect | reload | back_forward | profile`
  (typed from `_pendingOmniboxTypedTabIds`; reload/back_forward from `navigationHistory` deltas).
- `did-navigate-in-page` → visit `in_page`, deduped when the same URL was recorded < 1 s ago (SPA
  routers push twice).
- `page-title-updated` → `UPDATE omnibox_history SET title=? WHERE url=?` for the tab's current URL
  (fixes wrong titles). Record the visit at `did-navigate` (URL known immediately), patch the title later.
- Never record: `about:`, `file:` (internal pages), `devtools:`, `data:`, `blob:`, error pages, the
  overlay view. Store the URL **without `#fragment`**.
- Tag every visit with `tab_id`, `cookie_group_id` (1 = shared) and the logging `session_id` (so a visit
  can be correlated with the request log later).
- Setting `history.recordIsolatedTabs` (default **on**, shown with a badge; off = never stored).
- Retention: `history.retentionDays` (default 90) — purge `history_visits` older than N at startup;
  aggregate rows with no remaining visits are deleted too. `Clear history` = visits + aggregates +
  shortcuts (+ optional "also clear request logs" checkbox).

**Schema** (in `db.js` `migrateSchema`, additive):

```sql
ALTER TABLE omnibox_history ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;      -- Shift+Delete
ALTER TABLE omnibox_history ADD COLUMN last_cookie_group_id INTEGER;            -- badge
CREATE TABLE IF NOT EXISTS history_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url_id INTEGER NOT NULL REFERENCES omnibox_history(id) ON DELETE CASCADE,
  visited_at TEXT NOT NULL,
  transition TEXT NOT NULL,
  tab_id TEXT, cookie_group_id INTEGER, session_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_hv_time ON history_visits(visited_at);
CREATE INDEX IF NOT EXISTS idx_hv_url  ON history_visits(url_id);
CREATE TABLE IF NOT EXISTS omnibox_shortcuts (
  text TEXT PRIMARY KEY, url TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 1, last_used_at TEXT NOT NULL
);
```

`omnibox_history` stays the per-URL aggregate (no rename → no migration risk for existing DBs).

**UI:**

- **History window** (`history.html` + `history-renderer.js`, spawned with `_spawnTrustedToolWindow`
  like Cookie Manager — the settings-as-tab path is broken, A‑036): search box (title/URL), day groups,
  rows with time · title · URL · isolated badge · session id; actions open / open in new tab / copy /
  delete; toolbar Clear (last hour / today / all), retention selector, "record isolated tabs" toggle.
- **Menu** `History`: Back, Forward, Home, ─, Show All History (Cmd/Ctrl+Y), Recently Closed
  (submenu ≤10), Reopen Closed Tab, ─, Clear History….
- **Recently closed:** `tab-manager.closeTab` pushes `{url, title, cookieGroupId, entries:
  navigationHistory.getAllEntries(), index}` into a ring of 10; reopen = `createTab({cookieGroupId})` +
  `webContents.navigationHistory.restore({entries, index})` (present in Electron 44's `electron.d.ts`).
  If the cookie group was deleted, reopen in the shared group and toast it.
- **Per-tab back/forward list:** right-click / long-press on ◀ ▶ shows `navigationHistory.getAllEntries()`
  as a native menu (`goToIndex`).
- Palette commands: `Open History`, `Reopen closed tab`, `Clear history…`.

### 2.8 Overlay surface

Keep the `WebContentsView` (it is the only surface that paints above the tab). Changes:

- Create once per main window, keep alive; `switchTab` / window switcher only **detach** it and send
  `force-close-omnibox` (fixes the destroy/recreate flash and the A‑380 race with the
  `_omniboxWanted` / `_omniboxShowPromise` guard).
- `#backdrop` transparent by default; the dark veil only for command mode if wanted.
- Move the inline script to `omnibox-overlay-renderer.js`, drop `'unsafe-inline'` from the CSP,
  `sandbox: true` in the preload (it only uses `contextBridge` + `ipcRenderer`).
- Cap the row content width (≈ 960 px) so labels do not sit 2000 px away from the hint on wide screens.
- Row model gets `kind`, `badge` (`isolated`, `tab`), `completion` (host suffix) and `deletable`.

---

## 3. Architecture / code layout

```
omnibox-input.js                 pure: classifyOmniboxInput, INTERNAL_ALIASES      (shell <script> + require)
omnibox-model.js                 pure: buildOmniboxRows, rankSuggestions, findDefaultMatch, computeCompletion
omnibox-controller.js            DOM: input state machine, keyboard, overlay sync   (loaded by browser.html)
omnibox-overlay.html + omnibox-overlay-renderer.js + preload-omnibox-overlay.js
main-process/services/history-service.js   recordVisit, updateTitle, suggest, zeroSuggest, list, deleteUrl,
                                           clear, purge, recently-closed ring, reopenClosedTab   (wraps db.js)
main-process/ipc/handlers/omnibox-history-ipc.js   trusted-sender guarded omnibox-* / history-* channels,
                                           url-bar-context-menu, nav-history-menu, get-search-engine (read-only)
history.html + history-renderer.js         tool window (sub-windows.createHistoryWindow)
```

(Shell files stay flat in the repo root like the rest of the renderer code; the `shell/` folder from the
first draft was not introduced.)

`browser-renderer.js` loses ~600 lines (omnibox block + URL state) and only wires the controller.
`db-logging-ipc.js` keeps `get-omnibox-*` as thin aliases for one release, then they go.

Tests:

- `tests/unit/omnibox-input.test.mjs` — classifier table (incl. `localhost:3000`, `[::1]:8080`,
  `api:8080/v1`, `intranet/path`, `10.0.0.5`, `word.tld`, `two words`, aliases).
- `tests/unit/omnibox-model.test.mjs` — row composition, default-match selection, zero-suggest,
  quick-link prefix matching, command word-prefix matching, ranking boosts.
- `tests/test-db.js` (Electron ABI) — visits, title patch, hidden rows, purge, shortcuts, clear.
- e2e `omnibox.e2e.spec.js`: replace omni‑2 with "host-prefix inline completion + Tab accepts";
  add localhost → http, Shift+Delete hides a row, zero-suggest on focus, History window lists a visit,
  Reopen closed tab restores URL + cookie group.
- Guide: rewrite the #omnibox section (`scripts/guide-i18n/{en,fr,es,ru}.mjs`) and `npm run build:guide`.

---

## 4. Phased plan

| Phase | Scope | Exit criteria | Effort |
|---|---|---|---|
| **A — stop the bleeding** ✅ 2026-09-25 | A‑017 (typing clobbered), A‑206 (dirty after Enter), A‑211 (blur revert), A‑208 (engine label), A‑212 (hint/guide), A‑203 (dead alias), A‑205 (Cmd+Enter cancel), A‑067/A‑391 (localhost), A‑380 (overlay race), A‑397 (titles), A‑398 (SPA visits), A‑399 (zero-suggest), A‑401 (quick-link fuzzy) | omnibox e2e green + new unit tests; screenshots 1–6 above no longer reproduce | ~1 day |
| **B — model + ranking** ✅ 2026-09-25 | extract `omnibox-input.js` / `omnibox-model.js` / controller; default match; shortcuts table; inline completion; ↑↓ fills the field; Shift+Delete; Shift+Enter → isolated tab; context menu; search-engine unification (A‑338); overlay kept alive + strict CSP | unit tests for model; e2e omni‑2 replaced; `browser-renderer.js` omnibox block removed | ~2 days |
| **C — history** ✅ 2026-09-25 | `history_visits`, `history-service.js`, `history-ipc.js`, History window, History menu, recently closed + reopen, retention + clear, isolated badge/toggle, back/forward list | test-db + e2e cases; guide updated | ~2–3 days |
| **D — polish (optional)** | engine keywords, `@tabs` / `#history` scopes, favicon URL per history row (favicon cache was removed), width cap, a11y (`role=listbox` mirrored in the overlay) | — | ~1 day |

Phase A is safe to do right away on `audit/2026-09-fixes` (no schema change). Phases B–C touch
`db.js` (additive migration) and the shell layout; do them on a branch with the e2e smoke set green
after each step.

---

## 5. Decisions needed from the owner

1. **Inline autocomplete** (Chrome-style, host part only, Tab/→ accepts): recommended **yes** — it is
   the single change that makes `wiki` + Enter open wikipedia.org. Requires replacing e2e omni‑2.
2. **Isolated tabs in history**: recommended **record + badge + toggle** (default on). Alternative:
   never record isolated-tab visits.
3. **Retention** default: 90 days of visits (aggregates follow). Alternative: unlimited.
4. **History surface**: tool window (recommended; consistent with Cookie/DNS managers, works with the
   trusted `preload.js`) vs. an internal `cupnet://history` tab (needs the settings-as-tab fix A‑036 first).
5. **Shift+Enter** → new isolated tab (recommended) vs. Chrome's "new window".
6. **Reopen closed tab shortcut**: Chrome's Cmd+Shift+T is taken by *New Isolated Tab*. Options:
   Cmd+Alt+T for reopen (keeps current bindings) or move isolated tab to Cmd+Shift+I.
7. **Zero-suggest content**: Recent + Top sites + quick links (recommended) vs. Recent only.

---

## 6. Progress log

- 2026-09-25: analysis done, screenshots of the current behaviour taken with a Playwright launch
  (`CUPNET_MITM_PORT=8899` because the dev instance holds 8877); new audit ids A‑397…A‑403 filed.
- 2026-09-25 (later): owner approved all recommended decisions (§5: inline completion on, isolated visits
  recorded + badge + toggle, 90-day retention, History as a tool window, Shift+Enter → isolated tab,
  Cmd/Ctrl+Alt+T reopen, Recent + Top sites zero-suggest). **Phases A, B and C implemented** in the working
  tree (uncommitted, on `audit/2026-09-fixes`):
  - new: `omnibox-input.js`, `omnibox-model.js`, `omnibox-controller.js`, `omnibox-overlay-renderer.js`,
    `history.html`, `history-renderer.js`, `main-process/services/history-service.js`,
    `main-process/ipc/handlers/omnibox-history-ipc.js`, `tests/unit/omnibox-input.test.mjs`,
    `tests/unit/omnibox-model.test.mjs`;
  - changed: `browser-renderer.js` (omnibox block + URL state removed, controller wired), `browser.html`
    (dead dropdown/palette DOM removed, scripts added), `omnibox-overlay.html` (strict CSP, badges, delete),
    `preload-omnibox-overlay.js`, `preload.js`, `preload-view.js`, `utils.js` (classifier), `db.js`
    (history_visits, omnibox_shortcuts, last_cookie_group_id, history API), `tab-manager.js` (history hooks,
    title patch, in_page visits, reload transition, recently-closed snapshot, overlay keep-alive + race
    guard, sandbox), `tabs-ipc.js` (alias map), `settings-toolbar-ipc.js` (searchEngine / inline flag
    broadcast), `settings-store.js` (history settings, bing), `sub-windows.js` (createHistoryWindow),
    `main-window.js` (History menu), `cupnet-runtime.js` (service wiring, purge at startup, scope keys),
    `misc-ipc.js` (overlay delete relay), `new-tab.html` (engine from Settings), `settings.html` (Bing),
    `keyboard-shortcuts.js`, guide sections in 4 languages (+ `npm run build:guide`), `tests/test-db.js`
    (11 history tests), `tests/unit/utils.test.mjs`, `tests/e2e/omnibox.e2e.spec.js` (omni‑2 replaced,
    omni‑2b/2c/8/9/10 added).
  - validation without a GUI: vitest 42 files / 356 tests green (353 pass, 3 skipped; incl. 69 new omnibox tests), tests/test-db.js
    43/43 under Electron's Node, history-service smoke against a temp SQLite DB, `node -c` on every touched
    file. **The Playwright e2e (`tests/e2e/omnibox.e2e.spec.js`) has not been run locally** — it launches the
    GUI, which the owner asked not to do while they are working; run it (or CI) before merging.
  - phase D leftovers: engine keywords (`g foo`), `@tabs` / `#history` scopes, favicons in rows, dead omnibox
    CSS in styles.css (`.url-omnibox-dropdown`, `.command-palette*`) can be deleted.
