# CupNet — безопасность (RU)

> English version: [SECURITY.md](../SECURITY.md)

CupNet 2 — локальный Electron-браузер со встроенным MITM-прокси для анализа трафика. Это **инструмент разработчика/отладки**, а не менеджер паролей.

**Данные (macOS):** `~/Library/Application Support/CupNet/`

> **Изменение 2026-09:** встроенный менеджер паролей (credentials vault) и шифрование лог-трафика на диске **удалены** — чтобы сузить и облегчить продукт. Осталось: **экран-гейт разблокировки одного профиля** (запрос пароля при старте), session-key которого защищает **зашифрованные заметки (CN02)** и расшифровку прокси-кредов. Для хранения секретов используйте **зашифрованную заметку**. Тела и заголовки запросов/ответов теперь хранятся в **plaintext** (отладочный лог).

## Модель угроз

| Угроза | Что возможно | Защита |
|--------|--------------|--------|
| Malware того же пользователя (приложение закрыто) | Чтение `cupnet.db`, CA-ключа, settings | Права файлов `600/700`, шифрование заметок (CN02), proxy URL в OS keychain |
| Malware при разблокированном профиле | Dump памяти, IPC, чтение заметок | Auto-lock, IPC guard, master key в RAM без строки пароля |
| Кража бэкапа (Time Machine, диск) | История трафика (plaintext); blob-ы зашифрованных заметок | Шифрование заметок (CN02); traffic log намеренно plaintext |
| Compromised tab renderer | Вызов privileged IPC | Tab WebContents не trusted; профиль/proxy/share-cookies — только shell-окна |
| Offline guessing пароля профиля | Brute-force по `verify_blob` | Argon2id (CV02), min 12 символов, top-10k blocklist, rate-limit unlock |

**Вне scope:** полная защита при скомпрометированном хосте **пока профиль разблокирован**. MITM CA private key остаётся на диске (нужен для работы). Traffic log не конфиденциален на диске by design.

## Данные на диске

| Данные | Где | Защита |
|--------|-----|--------|
| Заметки | `notes.*_encrypted` (CN02) | AES-256-GCM + session master key |
| HTTP traffic log | `requests.*` | **Plaintext** (шифрование на диске удалено) |
| Proxy URL | `proxy_profiles.url_encrypted` | OS `safeStorage`; save fail-closed |
| Proxy в settings | `settings.json` | `currentProxy` не сохраняется |
| Verify blob профиля | `credentials_vault.verify_blob` | Argon2id CV02; пароль не хранится, только derived key |
| Master password | RAM | **Не хранится** после unlock; только derived key, zeroed on lock |

## Runtime

- **Auto-lock:** `vaultAutoLockMinutes` (default 15) — **Settings → Security**; сброс по активности в shell. Лок обнуляет master key, поэтому заметки не расшифровать до следующего unlock.
- **Lock:** idle, блокировка экрана, suspend, кнопка «Lock profile» в профиль-drawer.
- **Rate-limit unlock:** 5 ошибок → 30 с; 10 → 5 мин.
- **IPC guard:** `ipc-trusted-sender.js` — сессия профиля, расшифровка proxy URL, share-cookies только из trusted окон.
- **Preload:** `preload-view.js` — минимальный API для вкладок; полный API — `preload.js` / shell.

## Настройки (Security)

| Ключ | Default | Смысл |
|------|---------|-------|
| `vaultAutoLockMinutes` | `15` | Auto-lock (`0` = выкл.) |

## Политика пароля

- Минимум **12 символов**.
- Блокировка паролей из **top-10k** списка (`data/common-passwords-10k.txt`, SecLists).

## Ручная проверка

1. **Idle lock:** unlock → подождать N мин → открыть зашифрованную заметку → снова запрос пароля.
2. **Notes encryption:** `sqlite3 cupnet.db "SELECT substr(body_encrypted,1,20) FROM notes WHERE is_encrypted=1 LIMIT 3"` → ciphertext, не читаемый текст.
3. **Proxy fail-closed:** без keychain → save proxy → ошибка.
4. **Settings export:** нет `currentProxy`.
5. **File perms:** `cupnet.db` → `-rw-------`.
6. **Tab IPC:** `window.electronAPI?.credentialsGet` из tab DevTools → **undefined** (API кредов удалён).
7. **Rate limit:** 10 неверных паролей → backoff.

## Автотесты

```bash
npm run test:unit -- tests/unit/password-policy.test.mjs \
  tests/unit/ipc-trusted-sender.test.mjs \
  tests/unit/vault-auto-lock.test.mjs \
  tests/unit/credentials-crypto.test.mjs \
  tests/unit/proxy-save-fail-closed.test.mjs
```

`credentials-crypto.js` оставлен несмотря на имя: это библиотека KDF / verify-blob / session-key, используемая гейтом профиля и шифрованием заметок.

## Известные ограничения

- Same-user malware с доступом к RAM во время unlock остаётся в threat model.
- SQLCipher для всей БД не включён (заметки — field-level encryption).
- MITM CA key на диске — предупреждать пользователей не ставить CA на prod-машины.
- Traffic log (запросы/ответы) хранится в plaintext by design — не захватывайте чувствительные сессии, которые нежелательно держать на диске.
- Legacy CN01-заметки, зашифрованные паролем профиля, мигрируют в CN02 при следующем unlock.
