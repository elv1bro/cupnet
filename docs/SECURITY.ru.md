# CupNet — безопасность (RU)

> English version: [SECURITY.md](../SECURITY.md)

CupNet 2 — локальный Electron-браузер со встроенным MITM-прокси для анализа трафика. Это **инструмент разработчика/отладки**, а не hardened password manager вроде 1Password.

**Данные (macOS):** `~/Library/Application Support/CupNet/`

## Модель угроз

| Угроза | Что возможно | Защита |
|--------|--------------|--------|
| Malware того же пользователя (приложение закрыто) | Чтение `cupnet.db`, CA-ключа, settings | Права файлов `600/700`, шифрование vault и traffic log, proxy URL в OS keychain |
| Malware при разблокированном vault | Dump памяти, IPC, расшифрованный traffic | Auto-lock, IPC guard, master key в RAM без строки пароля |
| Кража бэкапа (Time Machine, диск) | История трафика, encrypted vault blobs | Field-level encryption логов, login/notes, encrypted export по умолчанию |
| Compromised tab renderer | Вызов privileged IPC | Tab WebContents не trusted; vault/proxy/share-cookies — только shell-окна |
| Offline guessing master password | Brute-force по `verify_blob` | Argon2id (CV02), min 12 символов, top-10k blocklist, rate-limit unlock |

**Вне scope:** полная защита при скомпрометированном хосте **пока vault разблокирован**. MITM CA private key остаётся на диске (нужен для работы).

## Данные на диске

| Данные | Где | Защита |
|--------|-----|--------|
| Пароли vault, TOTP | `password_encrypted`, `extra_encrypted` | AES-256-GCM (CV02 + session master key) |
| Логины, notes | `login_encrypted`, `notes_encrypted` | Шифрование при save; lazy migration очищает plaintext |
| HTTP traffic log | `requests.*_enc` | Encrypt / redact (Settings → Security) |
| Proxy URL | `proxy_profiles.url_encrypted` | OS `safeStorage`; save fail-closed |
| Proxy в settings | `settings.json` | `currentProxy` не сохраняется |
| Master password | RAM | **Не хранится** после unlock; только derived key, zeroed on lock |

## Runtime

- **Auto-lock:** `vaultAutoLockMinutes` (default 15) — **Settings → Security**; сброс по активности в shell.
- **Lock:** idle, блокировка экрана, suspend, logout.
- **Rate-limit unlock:** 5 ошибок → 30 с; 10 → 5 мин.
- **IPC guard:** `ipc-trusted-sender.js` — credentials, export, proxy URL, share-cookies только из trusted окон.
- **Preload:** `preload-view.js` — минимальный API для вкладок; полный API — `preload.js` / shell.

## Настройки (Security)

| Ключ | Default | Смысл |
|------|---------|-------|
| `vaultAutoLockMinutes` | `15` | Auto-lock (`0` = выкл.) |
| `trafficLogEncryption` | `encrypt` | `off` / `redact` / `encrypt` |
| `trafficLogRawMode` | `false` | Полный capture без redact/encrypt (debug) |
| `allowPlaintextExport` | `false` | JSON/CSV export credentials |

## Экспорт credentials

- **По умолчанию:** `.cupnet-vault-export` — AES-256-GCM + отдельный export password (min 12 символов).
- **Plaintext JSON/CSV:** только при `allowPlaintextExport` + **диалог подтверждения** в main process.

## Политика пароля

- Минимум **12 символов**.
- Блокировка паролей из **top-10k** списка (`data/common-passwords-10k.txt`, SecLists).

## Ручная проверка

1. **Idle lock:** unlock → подождать N мин → fill credential → locked.
2. **DB login plaintext:** `sqlite3 cupnet.db "SELECT login FROM credentials LIMIT 5"` → пусто или blob.
3. **Traffic:** `SELECT substr(response_body,1,50) FROM requests ORDER BY id DESC LIMIT 3` → не readable JSON при `log_encrypted=1`.
4. **Proxy fail-closed:** без keychain → save proxy → ошибка.
5. **Settings export:** нет `currentProxy`.
6. **File perms:** `cupnet.db` → `-rw-------`.
7. **Tab IPC:** `window.electronAPI?.credentialsGet` из tab DevTools → undefined / denied.
8. **Rate limit:** 10 неверных паролей → backoff.
9. **Secure export:** `.cupnet-vault-export` без export password не открывается.
10. **Plaintext export:** JSON/CSV → confirm dialog; Cancel не пишет файл.

## Автотесты

```bash
npm run test:unit -- tests/unit/password-policy.test.mjs \
  tests/unit/ipc-trusted-sender.test.mjs \
  tests/unit/vault-auto-lock.test.mjs \
  tests/unit/traffic-log-crypto.test.mjs \
  tests/unit/credentials-crypto.test.mjs \
  tests/unit/proxy-save-fail-closed.test.mjs \
  tests/unit/credentials-login-migration.test.mjs
```

## Известные ограничения

- Same-user malware с доступом к RAM во время unlock остаётся в threat model.
- SQLCipher для всей БД — возможная **Фаза 3**.
- MITM CA key на диске — предупреждать пользователей не ставить CA на prod-машины.
- Поиск по login после шифрования — только domain/label (blind index не реализован).
