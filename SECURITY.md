# CupNet Security

> Russian: [docs/SECURITY.ru.md](docs/SECURITY.ru.md)

CupNet 2 is a local Electron browser with an embedded MITM proxy for traffic analysis. It is a **developer/debugging tool**, not a password manager.

> **2026-09 change:** the in-app password manager (credentials vault) and traffic-log at-rest encryption were **removed** to reduce scope and risk. What remains: a **single profile unlock gate** (a password prompt at startup) whose session key protects **encrypted notes (CN02)** and proxy-credential decryption. To store secrets, use an **encrypted note**. Traffic-log request/response bodies and headers are now stored as **plaintext** (a debugging log).

## Threat model

| Attacker | What they can do today | Mitigations |
|----------|------------------------|-------------|
| Same-user malware while app is closed | Read `cupnet.db`, MITM CA key, settings | File permissions (`chmod 600/700`), encrypted notes (CN02), proxy URLs in OS keychain |
| Same-user malware while profile unlocked | Memory dump, IPC calls, read notes | Auto-lock, IPC trusted-sender guard, no master password string in RAM (derived key only) |
| Stolen backup (Time Machine, disk) | Full traffic history (plaintext log); encrypted note blobs | Notes encryption (CN02); traffic log is intentionally plaintext |
| Compromised tab renderer | Call privileged IPC | Tab WebContents registered as untrusted; profile/proxy/share-cookies require shell window |
| Offline guessing | Brute-force profile password via `verify_blob` | Argon2id (CV02), min 12-char policy, top-10k common-password blocklist, unlock rate limit with backoff |

**Out of scope:** surviving a fully compromised host while the profile is unlocked. MITM CA private key remains on disk (required for operation). The traffic log is not confidential at rest by design.

## Data at rest

| Data | Location | Protection |
|------|----------|------------|
| Notes | `notes.*_encrypted` (CN02) | AES-256-GCM with the session master key |
| Traffic log bodies/headers | `requests.*` | **Plaintext** (at-rest encryption removed) |
| Proxy upstream URL | `proxy_profiles.url_encrypted` | OS `safeStorage`; save fails closed if unavailable |
| Proxy in settings JSON | `settings.json` | `currentProxy` stripped on save/export |
| Profile verify blob | `credentials_vault.verify_blob` | Argon2id CV02; no password stored, derived key only |
| Master password | RAM | **Not stored** after unlock; 32-byte derived key only, zeroed on lock |

## Runtime controls

- **Auto-lock:** `vaultAutoLockMinutes` (default 15); resets on `vault-session-activity` IPC (mouse/navigation throttled in shell). Locking the session zeroes the master key, so encrypted notes cannot be read until the next unlock.
- **Lock triggers:** idle timer, screen lock, system suspend, manual logout.
- **Unlock rate limit:** 5 failures → 30s; 10 failures → 5 min (per profile, in memory).
- **IPC guard:** `ipc-trusted-sender.js` — profile session, proxy URL decrypt, share-cookies restricted to trusted shell windows. Tab-owned cookie read/write allowed only for matching tab id.
- **Preload split:** `preload-view.js` — navigation, UI prefs, tab cookies. `preload.js` / `preload-shell.js` — full privileged API.

## Settings (Security)

| Key | Default | Meaning |
|-----|---------|---------|
| `vaultAutoLockMinutes` | `15` | Idle auto-lock (`0` = off). Configure in **Settings → Security**. |

## Manual verification checklist

1. **Idle lock:** Unlock profile → wait `vaultAutoLockMinutes` → opening an encrypted note prompts for the password again.
2. **Notes encryption:** Quit app → `sqlite3 cupnet.db "SELECT substr(body_encrypted,1,20) FROM notes WHERE is_encrypted=1 LIMIT 3"` → binary/ciphertext, not readable text.
3. **Proxy fail-closed:** Without OS keychain → save proxy profile → error, no credentials in `url_display`.
4. **Settings export:** Export settings JSON → no `currentProxy` field.
5. **File permissions:** `ls -la ~/Library/Application\ Support/CupNet/cupnet.db` → `-rw-------`.
6. **Tab IPC:** From tab DevTools, `window.electronAPI?.credentialsGet` → **undefined** (the credentials API was removed).
7. **Unlock rate limit:** 10 wrong passwords → backoff message with retry seconds.

## Unit tests

```bash
npm run test:unit -- tests/unit/password-policy.test.mjs \
  tests/unit/ipc-trusted-sender.test.mjs \
  tests/unit/vault-auto-lock.test.mjs \
  tests/unit/credentials-crypto.test.mjs
```

`credentials-crypto.js` is retained despite its name: it is the KDF / verify-blob / session-key library used by the profile gate and note encryption.

## Known limitations

- SQLCipher full-database encryption is not enabled (notes use field-level encryption).
- MITM CA key file remains on disk with restrictive permissions.
- The traffic log (requests/responses) is stored in plaintext by design; do not capture sensitive sessions you would not want on disk.
- Legacy CN01 notes encrypted with a profile password are migrated to CN02 on next profile unlock.
