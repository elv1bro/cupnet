# CupNet Security

> Russian: [docs/SECURITY.ru.md](docs/SECURITY.ru.md)

CupNet 2 is a local Electron browser with an embedded MITM proxy for traffic analysis. It is a **developer/debugging tool**, not a hardened password manager. This document describes the threat model, protections added in Phases 1–2, and how to verify them.

## Threat model

| Attacker | What they can do today | Mitigations |
|----------|------------------------|-------------|
| Same-user malware while app is closed | Read `cupnet.db`, MITM CA key, settings | File permissions (`chmod 600/700`), encrypted vault fields, encrypted traffic log (when unlocked session key existed at insert), proxy URLs in OS keychain |
| Same-user malware while vault unlocked | Memory dump, IPC calls, read decrypted traffic | Auto-lock, IPC trusted-sender guard, no master password string in RAM (derived key only) |
| Stolen backup (Time Machine, disk) | Full traffic history if captured plaintext; encrypted vault blobs | Field-level traffic encryption, login/notes encryption, encrypted vault export default |
| Compromised tab renderer | Call privileged IPC | Tab WebContents registered as untrusted; vault/proxy/share-cookies require shell window |
| Offline guessing | Brute-force master password via `verify_blob` | Argon2id (CV02), min 12-char policy, top-10k common-password blocklist, unlock rate limit with backoff |

**Out of scope:** surviving a fully compromised host while the vault is unlocked. MITM CA private key remains on disk (required for operation).

## Data at rest

| Data | Location | Protection |
|------|----------|------------|
| Vault passwords, TOTP extras | `credentials.password_encrypted`, `extra_encrypted` | AES-256-GCM; CV02 uses session master key |
| Logins, notes | `credentials.login_encrypted`, `notes_encrypted` | Encrypted on save; lazy migration clears plaintext |
| Traffic log bodies/headers | `requests.*_enc`, `log_encrypted` | Encrypted when vault unlocked (`trafficLogEncryption: encrypt`) |
| Proxy upstream URL | `proxy_profiles.url_encrypted` | OS `safeStorage`; save fails closed if unavailable |
| Proxy in settings JSON | `settings.json` | `currentProxy` stripped on save/export |
| Master password | RAM | **Not stored** after unlock; 32-byte derived key only, zeroed on lock |

## Runtime controls

- **Auto-lock:** `vaultAutoLockMinutes` (default 15); resets on `vault-session-activity` IPC (mouse/navigation throttled in shell).
- **Lock triggers:** idle timer, screen lock, system suspend, manual logout.
- **Unlock rate limit:** 5 failures → 30s; 10 failures → 5 min (per vault, in memory).
- **IPC guard:** `ipc-trusted-sender.js` — vault, credentials export, proxy URL decrypt, share-cookies restricted to trusted shell windows. Tab-owned cookie read/write allowed only for matching tab id.
- **Preload split:** `preload-view.js` — navigation, UI prefs, tab cookies, credential capture only. `preload.js` / `preload-shell.js` — full privileged API.

## Settings (Security)

| Key | Default | Meaning |
|-----|---------|---------|
| `vaultAutoLockMinutes` | `15` | Idle auto-lock (`0` = off). Configure in **Settings → Security**. |
| `trafficLogEncryption` | `encrypt` | `off` / `redact` / `encrypt` |
| `trafficLogRawMode` | `false` | Opt-in full capture without redaction/encryption |
| `allowPlaintextExport` | `false` | Block JSON/CSV credential export |

## Credential export

- **Default:** `.cupnet-vault-export` — AES-256-GCM JSON envelope with separate export password (min 12 chars).
- **Plaintext JSON/CSV:** only when `allowPlaintextExport` is enabled; main process shows a confirmation dialog before writing.

## Manual verification checklist

1. **Idle lock:** Unlock profile → wait `vaultAutoLockMinutes` → credential fill returns locked error.
2. **DB plaintext logins:** Quit app → `sqlite3 cupnet.db "SELECT login FROM credentials LIMIT 5"` → empty or only legacy rows before migration.
3. **Traffic encryption:** `SELECT substr(response_body,1,50) FROM requests ORDER BY id DESC LIMIT 3` → not readable JSON when `log_encrypted=1`.
4. **Proxy fail-closed:** Without OS keychain → save proxy profile → error, no credentials in `url_display`.
5. **Settings export:** Export settings JSON → no `currentProxy` field.
6. **File permissions:** `ls -la ~/Library/Application\ Support/CupNet/cupnet.db` → `-rw-------`.
7. **Tab IPC:** From tab DevTools, `window.electronAPI?.credentialsGet` → undefined or invoke denied.
8. **Unlock rate limit:** 10 wrong passwords → backoff message with retry seconds.
9. **Secure export:** `.cupnet-vault-export` file does not open without export password.

## CI grep guards

```bash
rg "password:\s*String\(password\)" main-process/   # expect 0 in profile-session active state
rg "credentials-get" preload-view.js                 # expect 0
```

## Unit tests

```bash
npm run test:unit -- tests/unit/password-policy.test.mjs \
  tests/unit/ipc-trusted-sender.test.mjs \
  tests/unit/vault-auto-lock.test.mjs \
  tests/unit/traffic-log-crypto.test.mjs \
  tests/unit/credentials-crypto.test.mjs
```

## Known limitations

- SQLCipher full-database encryption is not enabled (field-level encryption instead).
- MITM CA key file remains on disk with restrictive permissions.
- Legacy CN01 notes encrypted with profile password are migrated to CN02 on next profile unlock.
- Search by credential login is limited to domain/label when login is encrypted (no blind index yet).
