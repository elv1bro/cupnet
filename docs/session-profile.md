# CupNet Session Profile

A **session profile** is a JSON file that bootstraps a browser tab in one step: proxy, cookies, optional storage, DNS overrides, navigation URL, and JavaScript to run after the page loads.

Use it to reproduce a test environment, hand off a logged-in state to a colleague, or automate repeatable manual setups.

---

## Quick start

1. Copy `examples/cupnet-session.example.json` and edit it.
2. In CupNet menu: **File → Load Session Profile…** (or omnibox command `> Load session profile`).
3. **Browse…** → pick your JSON file.
4. Optionally set **URL override** (keeps cookies/proxy from the file, opens a different page).
5. Click **Load session** — the dialog closes immediately; the tab navigates in the background. Post-load JavaScript runs after the page finishes loading (or after the navigation timeout).

CupNet applies proxy, fingerprint, and cookies first, then starts navigation without blocking the dialog on slow pages (e.g. BLS behind a residential proxy).

---

## File format

Supported formats:

| `format` | Use case |
|----------|----------|
| `cupnet-session` | Full handoff — **requires** `navigate.url` |
| `cupnet-launch` | General launch context — URL optional; at least one of proxy / cookies / fingerprint / navigate / storage / script / DNS |

```json
{
  "format": "cupnet-session",
  "version": 1,
  "name": "My test session",
  "description": "Optional note for humans",
  ...
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `format` | recommended | Must be `"cupnet-session"` if present |
| `version` | no | Currently `1` |
| `name` | no | Display name (default: `Unnamed session`) |
| `description` | no | Free-text note |
| `navigate.url` | **yes** | Absolute URL (`https://…`). Top-level `"url"` is also accepted |
| `navigate.timeoutMs` | no | Navigation timeout (5s–300s, default 120s) |
| `tab` | no | Tab creation options (see below) |
| `proxy` | no | Proxy profile or inline template |
| `fingerprint` | no | User-Agent / language / timezone override |
| `cookies` | no | Array of cookie objects |
| `storage` | no | `localStorage` / `sessionStorage` key maps |
| `dnsOverrides` | no | Host → IP rules (applied only if `persistDnsOverrides: true`) |
| `persistDnsOverrides` | no | Save DNS rules to global DB (default `false`) |
| `clearCookiesBeforeLoad` | no | Wipe tab cookies before applying profile cookies |
| `clearStorageBeforeLoad` | no | Clear tab storage before navigation |
| `runAfterLoad` | no | JS string or `{ script, delayMs, timeoutMs }` |
| `logging.recording` | no | `true` / `false` to toggle session recording |

---

## Tab options (`tab`)

```json
"tab": {
  "newTab": true,
  "isolated": true,
  "cookieGroupName": "My test client"
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `newTab` | `true` | Open a new tab instead of reusing the active one |
| `isolated` | ignored | Session load always uses the **shared** cookie jar (regular tab) |
| `cookieGroupId` | — | Ignored on load (shared session) |
| `cookieGroupName` | — | Ignored on load (shared session) |

The load dialog can override **new tab** without editing the file. Proxy from the file is applied **globally** (not per-tab).

---

## Proxy

### Saved Proxy Manager profile

```json
"proxy": {
  "profileId": 3,
  "variables": {
    "USER": "myuser",
    "PASS": "secret"
  }
}
```

`profileId` refers to a profile in **Proxy Manager**. Ephemeral `variables` merge with saved template variables (`{USER}`, `{PASS}`, `{RAND:1-999}`, `{SID}`, etc.).

### Inline upstream (`proxy.template`)

```json
"proxy": {
  "template": "http://{USER}:{PASS}@proxy.example.com:8080",
  "variables": {
    "USER": "alice",
    "PASS": "s3cr3t"
  },
  "tlsProfile": "chrome_120",
  "ja3": null
}
```

On load, CupNet **disconnects** the current global proxy, **upserts** `last_session_proxy` from the file, **connects** it globally, and only then opens the tab (cookies + navigation). If connect fails, the session is not opened.

You can inspect or edit **`last_session_proxy`** in **Proxy Manager** after loading a session. Each new session load overwrites it.

Full URL without `{VAR}` placeholders also works — stored as a fixed URL profile.

### Network Activity — Web Request Tools

Right-click an HTTP request row → **Web Request Tools**:

- **Open with tab context** — export + apply a `cupnet-launch` (request URL, tab cookies for that host, current global proxy)
- **Export launch profile…** — save JSON without loading
- **Load launch profile…** — open the load dialog
- **Request Editor** / **Copy as curl**

---

## Cookies

Each cookie needs at least `name`, `value`, and `domain`:

```json
{
  "name": ".AspNetCore.Session",
  "value": "CfDJ8...",
  "domain": "example.com",
  "path": "/",
  "secure": true,
  "httpOnly": true,
  "sameSite": "Lax",
  "expirationDate": 1893456000
}
```

Alternatively provide `"url": "https://example.com/path"` instead of building from domain/path.

Max **5000** cookies per file.

---

## Storage

Injected **after** the first successful navigation:

```json
"storage": {
  "localStorage": {
    "theme": "dark",
    "lastArea": "ru"
  },
  "sessionStorage": {
    "step": "2"
  }
}
```

Max **500** keys per storage type.

---

## DNS overrides

```json
"dnsOverrides": [
  { "host": "api.example.com", "ip": "203.0.113.10", "enabled": true }
],
"persistDnsOverrides": false
```

- With `persistDnsOverrides: false` (default): rules are **not** written to the global DNS database — include them for documentation only, or set `true` when you intentionally want global overrides.
- With `true`: rules are saved to **DNS Manager** and synced to MITM.

---

## Post-load JavaScript (`runAfterLoad`)

Runs in the page context via `executeJavaScript` after `did-finish-load`.

**String form:**

```json
"runAfterLoad": "document.querySelector('#email')?.focus();"
```

**Object form:**

```json
"runAfterLoad": {
  "script": "console.log('CupNet session ready', location.href);",
  "delayMs": 500,
  "timeoutMs": 30000
}
```

Use for autofocus, clicking a button, or triggering in-page helpers. DevTools may be blocked on some sites; the script still runs in the page.

Max script size: **256 KB**.

---

## URL override (UI only)

The JSON must contain a valid `navigate.url` (used for validation and as default). In the load dialog you can type another absolute URL — proxy, cookies, and fingerprint from the file are still applied, but navigation goes to the override address.

---

## Security notes

- Session files often contain **live cookies and proxy credentials**. Treat them like password exports.
- Do not commit real session JSON to git.
- Prefer isolated tabs when testing unknown profiles.
- `persistDnsOverrides: true` changes global DNS for all tabs until you remove rules in DNS Manager.

---

## Example workflow

**Goal:** open a login page with a specific proxy and session cookie, then focus the email field.

1. Export or copy cookies from Cookie Manager (or from a HAR).
2. Create `my-session.json` from `examples/cupnet-session.example.json`.
3. Set `proxy.profileId` or inline template.
4. Paste cookies for the target domain.
5. Set `navigate.url` to the login page.
6. Add `runAfterLoad` to focus the login input.
7. Load via **File → Load Session Profile…**.

---

## Limits

| Limit | Value |
|-------|-------|
| File size | 10 MB |
| Cookies | 5000 |
| Storage keys | 500 per type |
| `runAfterLoad` script | 256 KB |
| DNS overrides | 100 entries in file |

---

## Related

- **Import session bundle** (omnibox) — imports HAR/ZIP log bundles, not tab bootstrap profiles.
- **Cookie Manager** — inspect/edit cookies after load.
- **Proxy Manager** — create `profileId` targets for profiles.
