/** CupNet new-tab guide — English (full parity with other langs) */
export default function en(kbdRow) {
    return `
<div class="g-hero">
    <img src="img.png" class="g-hero-logo" alt="CupNet">
    <div>
        <h1 class="g-hero-title">CupNet — How to Use</h1>
        <div class="g-hero-sub">Developer proxy browser · built-in MITM · AzureTLS fingerprints · SQLite network logs</div>
        <div style="margin-top:6px">
            <span class="g-pill">v2.0</span><span class="g-pill">SQLite</span>
            <span class="g-pill">CDP</span><span class="g-pill">AzureTLS</span>
        </div>
    </div>
</div>

<div id="brief" class="g-card g-brief">
    <h2>In brief</h2>
    <ul>
        <li><b>What it is:</b> Electron browser where tab traffic goes through CupNet’s stack: optional upstream proxy, HTTPS MITM on port <b>8877</b>, outbound TLS via <b>AzureTLS</b> worker (spoofed JA3 / HTTP2 profile).</li>
        <li><b>Logs:</b> Requests are recorded to <b>SQLite</b> (CDP + MITM path). Toggle <b>REC</b> on the toolbar to pause/resume logging; open <b>Log</b> for the viewer (FTS, HAR, replay, trace, compare).</li>
        <li><b>Proxy Manager:</b> Saved profiles (encrypted with OS keychain), <b>Apply globally</b> or <b>Apply to active tab</b>, live MITM stats in the header bar.</li>
        <li><b>Toolbar:</b> DNS overrides, Request Editor, Rules &amp; intercept, Page Analyzer, System Console, Settings (separate window).</li>
        <li><b>New Tab page:</b> Search, Quick Links, proxy/IP widget (MITM badge, per-tab scope), <b>Shared / Isolated</b> cookie toggle, <b>External proxy</b> for curl/scripts.</li>
        <li><b>Trust:</b> In-app Chromium sessions trust the MITM CA automatically. For other tools, use the PEM on disk (see <a href="#mitm">MITM &amp; CA</a>) or route them through External proxy.</li>
    </ul>
</div>

<div class="g-card g-toc">
    <h2>Contents</h2>
    <a href="#brief">0. In brief</a>
    <a href="#gs">1. Quick start</a>
    <a href="#traffic">2. Traffic path &amp; recording</a>
    <a href="#proxy">3. Proxy Manager</a>
    <a href="#fingerprint">4. Fingerprint &amp; TLS</a>
    <a href="#toolbar">5. Toolbar</a>
    <a href="#hotkeys">6. Hotkeys</a>
    <a href="#logs">7. Network logs · Trace · Compare</a>
    <a href="#editor">8. Request Editor</a>
    <a href="#rules">9. Highlight Rules &amp; Intercept</a>
    <a href="#cookies">10. Cookie Manager</a>
    <a href="#isolated">11. Isolated tabs</a>
    <a href="#dns">12. DNS overrides</a>
    <a href="#analyzer">13. Page Analyzer</a>
    <a href="#console">14. System Console</a>
    <a href="#newtab">15. New Tab page</a>
    <a href="#settings">16. Settings window</a>
    <a href="#mitm">17. MITM · CA file · Bypass</a>
    <a href="#issues">18. Common issues</a>
</div>

<div id="gs" class="g-card">
    <h2>1) Quick start</h2>
    <ol>
        <li>From the project folder run: <code>ELECTRON_RUN_AS_NODE= npm start</code> (IDEs may set <code>ELECTRON_RUN_AS_NODE=1</code> — clear it for Electron).</li>
        <li>The main window opens with a tab bar + navigation toolbar. Address bar accepts URL or search query.</li>
        <li>Ensure <b>REC</b> is on when you want new requests written to the database; the <b>Log #N</b> badge shows session + count.</li>
        <li>Click the <b>proxy pill</b> (left of the address bar) to open Proxy Manager — connect an upstream profile or stay on local MITM-only mode.</li>
        <li>New tab: <kbd>Ctrl T</kbd> or <b>+</b>. Isolated tab (separate storage): <kbd>Ctrl ⇧T</kbd> or <b>+🔒</b>.</li>
    </ol>
    <div class="g-tip">Direct browsing without an upstream proxy is normal. AzureTLS + MITM still shape HTTPS when MITM mode is active.</div>
</div>

<div id="traffic" class="g-card">
    <h2>2) Traffic path &amp; recording</h2>
    <p>Tabs are launched with Chromium’s proxy pointing at CupNet’s MITM listener (<b>127.0.0.1:8877</b>). Decrypted HTTPS is forwarded through the <b>AzureTLS worker</b> so the server sees a real browser TLS fingerprint (profile chosen per proxy profile / defaults).</p>
    <ul>
        <li><b>REC</b> — left part of the log pill. When recording is OFF, new network rows (and dependent features such as auto screenshots tied to traffic) stop accumulating.</li>
        <li>Clicking REC while logging may ask whether to continue the current session or start a fresh one.</li>
        <li><b>Mitm-init banner</b> on the New Tab page appears while the network stack starts; pages may be slow for a few seconds.</li>
    </ul>
    <div class="g-tip success">Highlight rules run after logging. Intercept rules that modify or mock traffic are evaluated on the MITM path in MITM mode (see Rules section).</div>
</div>

<div id="proxy" class="g-card">
    <h2>3) Proxy Manager</h2>
    <p>Open via the toolbar proxy pill or the <b>Manage →</b> link on the New Tab proxy widget. Protocols: <code>http</code>, <code>https</code>, <code>socks4</code>, <code>socks5</code>.</p>
    <h3>Profiles</h3>
    <ul>
        <li><b>+ New</b> / list selection — edit name, proxy URL template, notes.</li>
        <li>Credentials and secrets use the OS keychain (<code>safeStorage</code>) — not stored as plain text in SQLite.</li>
        <li><b>⚡ Test</b> — resolve template, measure latency, show IP/geo ASN.</li>
        <li><b>Apply globally</b> — connect for the whole browser (all tabs share the effective profile unless overridden).</li>
        <li><b>Apply to active tab</b> — bind the edited profile (with current SID/RAND values) only to the currently focused tab.</li>
        <li><b>⧉ Copy</b> — duplicate profile; <b>✕ Delete</b> — remove. <b>✕ Disconnect</b> clears upstream proxy.</li>
    </ul>
    <h3>Template variables</h3>
    <div class="g-tip">
        <code>{RAND:min-max}</code> — random integer on each connect<br>
        <code>{SID}</code> — ephemeral session token (auto <code>cupnet</code> + digits if empty)<br>
        <code>{VARNAME}</code> — value stored in the profile variables table
    </div>
    <details><summary>Example template</summary>
        <pre>socks5://user-{SID}:{PASSWORD}@{COUNTRY}.provider.com:{RAND:10000-19999}</pre>
    </details>
    <h3>Live MITM stats (top bar)</h3>
    <p>Shows AzureTLS worker health: req/s, average latency, pending count, totals, errors, and active TLS profile — useful when debugging slow pages or upstream failures.</p>
    <span class="g-status ok">✓ After a global connect, the active tab reloads so it picks up the new proxy chain.</span>
</div>

<div id="fingerprint" class="g-card">
    <h2>4) Fingerprint &amp; TLS</h2>
    <p>Expand <b>🎭 Fingerprint / Identity</b> inside a profile. Values apply when you connect / apply that profile.</p>
    <h3>HTTP / browser identity (CDP)</h3>
    <ul>
        <li><b>User-Agent</b> — presets (Chrome Win/Mac, Firefox, Safari, Mobile) affect headers and <code>navigator.userAgent</code>.</li>
        <li><b>Timezone</b> — overrides <code>Intl</code>, <code>Date</code>, and related APIs.</li>
        <li><b>Language</b> — maps to <code>Accept-Language</code> + <code>navigator.language</code>.</li>
    </ul>
    <h3>TLS fingerprint (AzureTLS)</h3>
    <ul>
        <li><b>Template</b> mode — choose Chrome 133, Firefox 138, Safari 18, iOS 18, Edge 133, Opera 119. JA3 / HTTP2 settings follow that browser.</li>
        <li><b>Custom JA3</b> — paste a full JA3 string; use prefills to match a template quickly.</li>
    </ul>
    <p><b>⚡ Traffic Optimization</b> (same profile) optionally blocks images/CSS/fonts/media/WebSocket with a captcha whitelist — speeds up heavy pages when enabled.</p>
    <div class="g-tip success">Disconnect clears global overrides. Per-tab bindings disappear when you close the tab.</div>
</div>

<div id="toolbar" class="g-card">
    <h2>5) Toolbar</h2>
    ${kbdRow('← → ↻ ⌂', 'Back / Forward / Reload / Home (start page)')}
    ${kbdRow('Proxy pill', 'Shows Direct or profile name + detail. Opens Proxy Manager. Mode badge when MITM routing is active.')}
    ${kbdRow('Address bar', 'URL or search — Enter to navigate')}
    <hr class="g-hr" style="margin:10px 0">
    ${kbdRow('<b>REC · Log #N</b>', 'REC toggles DB logging. Log opens Network Activity viewer; badge shows session id + request count.')}
    ${kbdRow('<b>DevTools</b>', 'Developer tools for the active tab (not the shell). Also <kbd>F12</kbd>.')}
    ${kbdRow('<b>Cookies</b>', 'Cookie Manager')}
    ${kbdRow('<b>DNS</b>', 'DNS overrides manager (badge = hit count)')}
    ${kbdRow('<b>Req Editor</b>', 'HTTP replay / compose')}
    ${kbdRow('<b>Rules</b>', 'Highlight &amp; intercept configuration (badge = hits)')}
    ${kbdRow('<b>Analyzer</b>', 'Page Analyzer window — forms, captcha heuristics, endpoint hints')}
    ${kbdRow('<b>Console</b>', 'System console — stdout/stderr from the app')}
    ${kbdRow('<b>Settings</b>', 'Opens the Settings window (General / Tracking / Devices / Performance)')}
</div>

<div id="hotkeys" class="g-card">
    <h2>6) Hotkeys</h2>
    <p>On macOS use <kbd>⌘ Cmd</kbd> instead of <kbd>Ctrl</kbd> where noted. Application menu exposes the same actions with exact accelerators.</p>
    <h3>Tabs &amp; navigation</h3>
    ${kbdRow('<kbd>Ctrl T</kbd>', 'New tab')}
    ${kbdRow('<kbd>Ctrl ⇧T</kbd>', 'New isolated tab')}
    ${kbdRow('<kbd>Ctrl W</kbd>', 'Close active tab')}
    ${kbdRow('<kbd>Ctrl Tab</kbd> / <kbd>Ctrl ⇧Tab</kbd>', 'Next / previous tab')}
    ${kbdRow('<kbd>Ctrl 1-9</kbd>', 'Focus tab by index (9 = last)')}
    ${kbdRow('<kbd>Ctrl L</kbd>', 'Focus address bar')}
    ${kbdRow('<kbd>Ctrl R</kbd> / <kbd>F5</kbd>', 'Reload')}
    ${kbdRow('<kbd>Ctrl ⇧R</kbd>', 'Hard reload (bypass cache)')}
    ${kbdRow('<kbd>Alt ←</kbd> / <kbd>Alt →</kbd>', 'Back / Forward')}
    <h3>Tools</h3>
    ${kbdRow('<kbd>Ctrl P</kbd>', 'Proxy Manager')}
    ${kbdRow('<kbd>Ctrl ⇧L</kbd>', 'Network log viewer')}
    ${kbdRow('<kbd>Ctrl Alt C</kbd>', 'Cookie Manager (mac: ⌘⌥C)')}
    ${kbdRow('<kbd>Ctrl ⇧M</kbd>', 'DNS Manager (application menu)')}
    ${kbdRow('<kbd>Ctrl ⇧A</kbd>', 'Page Analyzer')}
    ${kbdRow('<kbd>Ctrl ⇧K</kbd>', 'System Console')}
    ${kbdRow('<kbd>F2</kbd>', 'Screenshot now')}
    ${kbdRow('<kbd>F12</kbd>', 'DevTools — active tab')}
    ${kbdRow('<kbd>Ctrl ⇧I</kbd>', 'DevTools — browser shell')}
</div>

<div id="logs" class="g-card">
    <h2>7) Network logs · Trace · Compare</h2>
    <p>HTTP(S)/WebSocket events land in SQLite: URL, method, headers, bodies (incl. binary-safe storage), timings, screenshots as special rows.</p>
    <ul>
        <li><b>Filters</b> — method, status, content-type, tab, session.</li>
        <li><b>FTS</b> — full-text search on URL + response body text.</li>
        <li><b>Export HAR</b> — HAR 1.2 compatible with Charles / DevTools / etc.</li>
        <li><b>Replay</b> — send selection into the Request Editor.</li>
        <li><b>Trace</b> — button stores full request/response snapshots; ⌘/Ctrl-click opens the Trace viewer window.</li>
        <li><b>Compare</b> — add entries to left/right slots, then open the Compare window to diff two requests.</li>
        <li><b>Sessions</b> — rename, switch, delete logging sessions.</li>
    </ul>
    <h3>Auto screenshots</h3>
    <p>Interval and intelligent triggers live under <b>Settings → General / Tracking</b>. Identical consecutive frames are skipped. The New Tab document itself is excluded from logging and captures.</p>
</div>

<div id="editor" class="g-card">
    <h2>8) Request Editor</h2>
    <p>Postman-style tool using Electron <code>net.fetch</code> — fewer header restrictions than renderer <code>fetch</code>.</p>
    <ul>
        <li>Edit method, URL, query table, headers, body modes (None / Raw / JSON / form).</li>
        <li>Optional per-request TLS profile override.</li>
        <li>Response panel: status, headers, formatted JSON, timing.</li>
        <li><b>Copy as cURL</b> — clipboard.</li>
    </ul>
    <div class="g-tip">Headers marked restricted by Chromium may still be ignored or rewritten at the network layer.</div>
</div>

<div id="rules" class="g-card">
    <h2>9) Highlight Rules &amp; Intercept</h2>
    <p>Open via <b>Rules</b>. Two concepts:</p>
    <h3>Highlight rules</h3>
    <p>Evaluate <i>after</i> the response is logged. Match URL, method, status, MIME, duration, host, bodies, errors with operators (<code>contains</code>, <code>equals</code>, regex, numeric comparisons…). Actions: <b>highlight</b>, <b>screenshot</b>, <b>notification</b>, <b>block</b> (mark row).</p>
    <h3>Intercept rules</h3>
    <p>Evaluate <i>before</i> the network. Wildcard patterns. Actions: <b>block</b>, <b>modify headers</b> (request/response), <b>mock</b> fixed responses.</p>
    <div class="g-tip">With <b>MITM mode</b> active, request interception is handled inside the MITM pipeline (not via <code>protocol.handle</code>) so TLS behaviour stays consistent for strict sites (Cloudflare / Turnstile).</div>
</div>

<div id="cookies" class="g-card">
    <h2>10) Cookie Manager</h2>
    <ul>
        <li>Per-tab session picker, live search, inline edit, import/export JSON or Netscape <code>cookies.txt</code>.</li>
        <li><b>Current tab</b> filter locks to the active navigation domain.</li>
        <li><b>Share to tab</b> copies cookies between isolated/shared sessions with optional domain filter.</li>
    </ul>
</div>

<div id="isolated" class="g-card">
    <h2>11) Isolated tabs</h2>
    <p><b>+🔒</b> creates a dedicated Chromium partition — separate cookies, cache, storage. Closing the tab destroys that data. Cookie Manager can export before close.</p>
    <div class="g-tip success">Use isolated tabs for parallel accounts or clean-room signups.</div>
</div>

<div id="dns" class="g-card">
    <h2>12) DNS overrides</h2>
    <p><b>DNS</b> opens the manager for host → IP overrides used during resolution inside CupNet. Wildcard hosts may require MITM CORS features for HTTPS pages — the UI warns when applicable.</p>
</div>

<div id="analyzer" class="g-card">
    <h2>13) Page Analyzer</h2>
    <p>Detached window summarizing the active tab: forms, detected captcha widgets, collected endpoints, and helper actions. Keep it open while you navigate; refresh or re-run scans as needed.</p>
</div>

<div id="console" class="g-card">
    <h2>14) System Console</h2>
    <p>Streaming view of main-process logs (info/warn/error). Use “Save” actions in-window to export history when debugging.</p>
</div>

<div id="newtab" class="g-card">
    <h2>15) New Tab page</h2>
    <ul>
        <li><b>Search row</b> — DuckDuckGo / Google / Yandex / Bing toggles (persist locally).</li>
        <li><b>Quick Links</b> — user URLs or one-click proxy profile shortcuts. <b>📖 Guide</b> opens this manual in the current tab.</li>
        <li><b>Proxy / IP card</b> — status dot, MITM badge, upstream label, external IP + geo, per-tab proxy scope pill (Global vs profile name).</li>
        <li><b>Cookie strip</b> — Shared vs Isolated toggle for the active tab’s cookie group, counts, Open (Cookie Manager), Clear all.</li>
        <li><b>External proxy</b> — optional HTTP listener (choose port) so curl, scripts, or LAN devices can send traffic through CupNet (same TLS profile + logging). Available when MITM mode is active.</li>
    </ul>
</div>

<div id="settings" class="g-card">
    <h2>16) Settings window</h2>
    <p><b>Settings</b> opens a dedicated window (not an inline drawer).</p>
    <h3>General</h3>
    <ul>
        <li><b>Unblock copy / paste</b> — stop pages from blocking clipboard shortcuts.</li>
        <li><b>MITM bypass domains</b> — one host pattern per line; matched hosts skip MITM (useful for embedded challenges).</li>
        <li><b>URL filter patterns</b> — glob per line; matching URLs are omitted from logs (<b>Save filters</b>).</li>
    </ul>
    <h3>Tracking</h3>
    <p>Choose which events trigger automatic screenshots (clicks, load complete, pending-network thresholds, mouse cadence, typing pause, scroll idle, rule-triggered captures). Tune thresholds for noisy environments.</p>
    <h3>Devices</h3>
    <p>Camera / microphone allow-lists and priority ordering for getUserMedia — helps when automating conferencing or captcha flows.</p>
    <h3>Performance</h3>
    <p>Live Electron/Chromium process table (CPU, working set, private memory, sandbox) refreshed every few seconds.</p>
</div>

<div id="mitm" class="g-card">
    <h2>17) MITM · CA file · Bypass lists</h2>
    <p>The MITM forward proxy terminates TLS with a CupNet-generated CA, logs plaintext where enabled, then re-encrypts upstream via AzureTLS.</p>
    <h3>In-browser trust</h3>
    <p>Internal BrowserViews automatically trust this CA — you normally <i>do not</i> import anything manually for tabs inside CupNet.</p>
    <h3>PEM on disk (external tools)</h3>
    <p>The public certificate is written to your user-data directory:</p>
    <ul>
        <li><b>macOS:</b> <code>~/Library/Application Support/CupNet/mitm-ca/ca-cert.pem</code></li>
        <li><b>Windows:</b> <code>%APPDATA%\\CupNet\\mitm-ca\\ca-cert.pem</code></li>
        <li><b>Linux:</b> <code>~/.config/CupNet/mitm-ca/ca-cert.pem</code></li>
    </ul>
    <p>Import that PEM into another browser or OS trust store only if you intentionally want that tool to accept CupNet-signed sites. Prefer the <b>External proxy</b> on the New Tab page to chain CLI clients through CupNet instead.</p>
    <h3>Bypass domains</h3>
    <p>Configured under <b>Settings → General → MITM bypass domains</b>. Combine with Intercept / DNS tools for advanced setups.</p>
    <span class="g-status warn">⚠ Only install the CA on machines you control. Never trust unknown CA files.</span>
</div>

<div id="issues" class="g-card">
    <h2>18) Common issues</h2>
    <ul>
        <li><b>App won’t start from IDE</b> — run <code>ELECTRON_RUN_AS_NODE= npm start</code> from a clean shell.</li>
        <li><b>Native module crash</b> — <code>npm run rebuild:arm64</code> (Apple Silicon) or <code>npx electron-rebuild</code>.</li>
        <li><b>Upstream proxy errors</b> — verify URL format, run <b>Test</b>, check MITM stats error counter.</li>
        <li><b>Strict sites / captcha loops</b> — ensure MITM bypass list includes challenge domains; avoid mixed tooling that reintroduces <code>protocol.handle</code> paths alongside MITM.</li>
        <li><b>External proxy disabled</b> — start listening only when CupNet is in MITM traffic mode; widget shows the precise error.</li>
    </ul>
    <details><summary>Developer bootstrap</summary>
        <pre>cd node/cupnet2
npm install --ignore-scripts
npm run rebuild:arm64   # Apple Silicon example
ELECTRON_RUN_AS_NODE= npm start</pre>
    </details>
</div>

<div class="g-footer">© CupNet 2.0 — All rights reserved.</div>
`;
}
