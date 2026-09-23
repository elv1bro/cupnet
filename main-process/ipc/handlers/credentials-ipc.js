'use strict';

const fs = require('fs').promises;
const path = require('path');
const {
    encryptCredentialField,
    decryptCredentialField,
    createVaultVerifyBlob,
    verifyVaultPassword,
    encryptFieldForStorage,
    decryptFieldFromStorage,
    encryptCredentialFieldWithKey,
    deriveMasterKey,
} = require('../../../credentials-crypto.js');
const { getNoteDomainFromUrl, noteMatchesUrlMatch } = require('../../../note-domain-utils.js');
const vaultCrypto = require('../../services/credentials-vault-crypto.js');
const vaultSession = vaultCrypto.vaultSession;
const { validatePassword } = require('../../services/password-policy.js');
const settingsStore = require('../../services/settings-store.js');
const profileSession = require('../../services/profile-session.js');
const { writeFileSecureAsync } = require('../../services/secure-fs.js');
const { guardIpcHandler } = require('../ipc-trusted-sender.js');
const crypto = require('crypto');

/** Pending credential capture (waiting for user confirm/dismiss). */
let _pendingCapture = null;

function clearCredentialsVaultSession() {
    vaultSession.lockAll('credentials-clear');
    _pendingCapture = null;
}

function _isUnlocked() {
    return vaultCrypto.isUnlocked();
}

function _requireMaster() {
    vaultCrypto.requireUnlockedMasterKey();
}

function _anyVaultUnlocked() {
    return vaultCrypto.isUnlocked();
}

function _activeVaultId() {
    return vaultCrypto.activeVaultId();
}

function _resolveCaptureVaultId(ctx) {
    const fromSession = _activeVaultId();
    if (fromSession != null) return fromSession;
    const fromProfile = settingsStore.getActiveProfileVaultId();
    if (fromProfile != null) return fromProfile;
    const vaults = ctx.db?.listVaults?.() || [];
    return vaults[0]?.id ?? 1;
}

function _encField(plain) {
    return vaultCrypto.enc(plain);
}

function _decField(buf, passwordFallback) {
    return vaultCrypto.dec(buf, passwordFallback);
}

function _parseExtraJson(s) {
    if (s == null || s === '') return {};
    try {
        const j = JSON.parse(s);
        return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
    } catch {
        return {};
    }
}

const BATCH_IMPORT_MAX = 5000;

/**
 * @param {object} ctx
 * @param {object} p
 * @param {{ last_ip?: string, last_proxy_profile_id?: number|null, last_proxy_profile_name?: string, pageUrl?: string }} grabMeta
 * @returns {number|null} new row id or null if row skipped
 */
function _insertCredentialFromImport(ctx, p, grabMeta) {
    const login = String(p.login ?? '').trim();
    const passwordPlain = p.password != null ? String(p.password) : '';
    const itemType = p.item_type || 'login';
    if (itemType === 'login' && !login && !passwordPlain) return null;
    if (itemType === 'note' && !p.notes && !p.label) return null;

    let domain = String(p.domain || '').trim().toLowerCase();
    const pageUrl = String(grabMeta?.pageUrl || p.page_url || '');
    if (!domain && pageUrl) domain = getNoteDomainFromUrl(pageUrl);
    if (!domain) domain = '(no site)';

    const extraObj = p.extra && typeof p.extra === 'object' && !Array.isArray(p.extra) ? p.extra : {};
    const extraJson = JSON.stringify(extraObj);
    const passwordEnc = _encField(passwordPlain);
    const extraEnc = _encField(extraJson);

    const rec = {
        id: null,
        vault_id: _activeVaultId() || 1,
        item_type: itemType,
        domain,
        url_match: String(p.url_match ?? ''),
        label: String(p.label ?? ''),
        login,
        password_encrypted: passwordEnc,
        extra_encrypted: extraEnc,
        notes: String(p.notes ?? ''),
        last_ip: String(grabMeta?.last_ip ?? p.last_ip ?? ''),
        last_proxy_profile_id: grabMeta?.last_proxy_profile_id != null
            ? grabMeta.last_proxy_profile_id
            : (p.last_proxy_profile_id != null ? p.last_proxy_profile_id : null),
        last_proxy_profile_name: String(grabMeta?.last_proxy_profile_name ?? p.last_proxy_profile_name ?? ''),
        last_used_at: new Date().toISOString(),
        tags: String(p.tags ?? ''),
        is_favorite: false,
    };
    return ctx.db.saveCredential(rec);
}

function _plainLogin(row) {
    if (row.login_encrypted && Buffer.isBuffer(row.login_encrypted)) {
        try { return _decField(row.login_encrypted); } catch { return ''; }
    }
    return row.login || '';
}

function _plainNotes(row) {
    if (row.notes_encrypted && Buffer.isBuffer(row.notes_encrypted)) {
        try { return _decField(row.notes_encrypted); } catch { return ''; }
    }
    return row.notes || '';
}

function _buildEncryptedVaultExport(items, exportPassword) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(String(exportPassword), salt, 32);
    const iv = crypto.randomBytes(12);
    const payload = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), items });
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return JSON.stringify({
        format: 'cupnet-vault-export',
        version: 1,
        salt: salt.toString('base64'),
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        data: enc.toString('base64'),
    }, null, 2);
}

function registerCredentialsIpc(ctx) {
    const handle = (channel, fn) => ctx.ipcMain.handle(channel, guardIpcHandler(channel, fn));

    function _toolbarRefresh() {
        try {
            if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
                ctx.mainWindow.webContents.send('credentials-toolbar-refresh');
            }
        } catch (_) { /* ignore */ }
    }

    async function _unlockVaultRecord(meta, password) {
        const unlock = await vaultSession.unlockVault({
            vaultId: meta.id,
            name: meta.name,
            password,
            verifyBlob: meta.verify_blob,
        });
        if (!unlock.success) return unlock;
        if (unlock.upgradedVerifyBlob) {
            ctx.db.updateCredentialsVaultVerifyBlob(meta.id, unlock.upgradedVerifyBlob);
        }
        ctx.db.updateVaultLastLogin(meta.id);
        settingsStore.setActiveProfileVaultId(meta.id);
        try { migratePlaintextCredentialFields(ctx.db, meta.id); } catch { /* ignore */ }
        _toolbarRefresh();
        return { success: true, vaultId: meta.id };
    }

    handle('credentials-vault-status', () => {
        try {
            if (!ctx.db) return { exists: false, unlocked: false };
            const vaults = ctx.db.listVaults();
            if (!vaults.length) return { exists: false, unlocked: false };
            const aid = _activeVaultId();
            const activeVault = aid != null
                ? ctx.db.getCredentialsVaultMeta(aid)
                : vaults[0];
            return {
                exists: true,
                unlocked: _isUnlocked(),
                activeVaultId: aid,
                activeVaultName: activeVault?.name || '',
                createdAt: activeVault?.created_at || null,
                hint: activeVault?.hint || '',
                vaultCount: vaults.length,
            };
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { exists: false, unlocked: false, error: String(e?.message || e) };
        }
    });

    handle('credentials-vault-list', () => {
        try {
            if (!ctx.db) return [];
            const aid = _activeVaultId();
            return ctx.db.listVaults().map(v => ({
                ...v,
                unlocked: vaultSession.isVaultUnlocked(v.id),
                isActive: v.id === aid,
            }));
        } catch { return []; }
    });

    handle('credentials-vault-create', async (_, payload) => {
        try {
            if (!ctx.db) return { success: false, error: 'Database unavailable' };
            const name = String(payload?.name || '').trim();
            if (!name) return { success: false, error: 'Vault name is required' };
            const pw = String(payload?.password || '');
            const confirm = String(payload?.confirm || '');
            const pwCheck = validatePassword(pw);
            if (!pwCheck.ok) return { success: false, error: pwCheck.error };
            if (pw !== confirm) return { success: false, error: 'Passwords do not match' };
            const blob = await createVaultVerifyBlob(pw);
            const id = ctx.db.createVault(name, blob);
            const meta = ctx.db.getCredentialsVaultMeta(id);
            return await _unlockVaultRecord(meta, pw);
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    handle('credentials-vault-setup', async (_, payload) => {
        try {
            if (!ctx.db) return { success: false, error: 'Database unavailable' };
            const vaults = ctx.db.listVaults();
            if (vaults.length > 0) {
                return { success: false, error: 'Vault already exists' };
            }
            const pw = String(payload?.password || '');
            const confirm = String(payload?.confirm || '');
            const pwCheck = validatePassword(pw);
            if (!pwCheck.ok) return { success: false, error: pwCheck.error };
            if (pw !== confirm) return { success: false, error: 'Passwords do not match' };
            const blob = await createVaultVerifyBlob(pw);
            const id = ctx.db.createVault(String(payload?.name || 'Default'), blob);
            const meta = ctx.db.getCredentialsVaultMeta(id);
            return await _unlockVaultRecord(meta, pw);
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    handle('credentials-unlock', async (_, password, vaultId) => {
        try {
            if (!ctx.db) return { success: false, error: 'Database unavailable' };
            const targetId = vaultId != null ? Number(vaultId) : null;
            let meta;
            if (targetId != null) {
                meta = ctx.db.getCredentialsVaultMeta(targetId);
            } else {
                const vaults = ctx.db.listVaults();
                meta = vaults.length === 1 ? ctx.db.getCredentialsVaultMeta(vaults[0].id) : null;
                const aid = _activeVaultId();
                if (!meta && aid != null) meta = ctx.db.getCredentialsVaultMeta(aid);
                if (!meta && vaults.length > 0) meta = ctx.db.getCredentialsVaultMeta(vaults[0].id);
            }
            if (!meta) return { success: false, error: 'No vault — create one first' };
            return await _unlockVaultRecord(meta, String(password || ''));
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    handle('credentials-vault-switch', async (_, vaultId, password) => {
        try {
            if (!ctx.db) return { success: false, error: 'Database unavailable' };
            const vid = Number(vaultId);
            const meta = ctx.db.getCredentialsVaultMeta(vid);
            if (!meta) return { success: false, error: 'Vault not found' };
            if (vaultSession.isVaultUnlocked(vid) && _activeVaultId() === vid) {
                _toolbarRefresh();
                return { success: true };
            }
            const pw = String(password || '');
            if (!pw) return { success: false, error: 'Password required to unlock vault' };
            return await _unlockVaultRecord(meta, pw);
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    handle('credentials-vault-delete', async (_, vaultId, password) => {
        try {
            if (!ctx.db) return { success: false, error: 'Database unavailable' };
            const vid = Number(vaultId);
            const meta = ctx.db.getCredentialsVaultMeta(vid);
            if (!meta) return { success: false, error: 'Vault not found' };

            const needsPassword = !!meta.last_login_at &&
                (Date.now() - new Date(meta.last_login_at).getTime()) < 30 * 24 * 60 * 60 * 1000;

            if (needsPassword) {
                const pw = String(password || '');
                if (!pw) return { success: false, error: 'Vault was used within last 30 days — password required to delete' };
                if (!(await verifyVaultPassword(meta.verify_blob, pw))) {
                    return { success: false, error: 'Invalid password' };
                }
            }

            ctx.db.deleteVault(vid);
            vaultSession.lockVault(vid);
            _toolbarRefresh();
            return { success: true };
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    handle('credentials-vault-rename', (_, vaultId, name) => {
        try {
            _requireMaster();
            ctx.db.renameVault(vaultId, name);
            return { success: true };
        } catch (e) {
            return { success: false, error: String(e?.message || e) };
        }
    });

    handle('credentials-lock', () => {
        clearCredentialsVaultSession();
        _toolbarRefresh();
        return { success: true };
    });

    handle('credentials-list', (_, filter) => {
        _requireMaster();
        const f = { ...(filter || {}), vaultId: _activeVaultId() };
        let rows = ctx.db.listCredentials(f);
        if (f.refineByUrlMatch && f.pageUrl) {
            const pu = String(f.pageUrl);
            rows = rows.filter((r) => noteMatchesUrlMatch(r.url_match || '', pu));
        }
        return rows;
    });

    handle('credentials-get', (_, id) => {
        _requireMaster();
        const row = ctx.db.getCredential(id);
        if (!row) return null;
        let password = '';
        if (row.password_encrypted && Buffer.isBuffer(row.password_encrypted)) {
            try {
                password = _decField(row.password_encrypted);
            } catch (e) {
                ctx.sysLog?.('warn', 'credentials', 'decrypt password: ' + String(e?.message || e));
                password = '';
            }
        }
        let extra = {};
        if (row.extra_encrypted && Buffer.isBuffer(row.extra_encrypted)) {
            try {
                const json = _decField(row.extra_encrypted);
                extra = _parseExtraJson(json);
            } catch (e) {
                ctx.sysLog?.('warn', 'credentials', 'decrypt extra: ' + String(e?.message || e));
                extra = {};
            }
        }
        let uris = [];
        try { uris = ctx.db.listCredentialUris(row.id); } catch { /* ignore */ }
        let customFields = [];
        try {
            const rawFields = ctx.db.listCredentialCustomFields(row.id);
            customFields = rawFields.map((f) => {
                let value = '';
                if (f.value_encrypted && Buffer.isBuffer(f.value_encrypted)) {
                    try { value = _decField(f.value_encrypted); } catch { value = ''; }
                }
                return { id: f.id, name: f.name, value, field_type: f.field_type, sort_order: f.sort_order };
            });
        } catch { /* ignore */ }
        return {
            id: row.id,
            item_type: row.item_type || 'login',
            domain: row.domain,
            url_match: row.url_match || '',
            label: row.label || '',
            login: _plainLogin(row),
            password,
            extra,
            notes: _plainNotes(row),
            last_ip: row.last_ip || '',
            last_proxy_profile_id: row.last_proxy_profile_id,
            last_proxy_profile_name: row.last_proxy_profile_name || '',
            last_used_at: row.last_used_at || null,
            tags: row.tags || '',
            is_favorite: !!row.is_favorite,
            folder_id: row.folder_id || null,
            deleted_at: row.deleted_at || null,
            uris,
            customFields,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    });

    handle('credentials-save', (_, payload) => {
        try {
            _requireMaster();
            const p = payload || {};
            let domain = String(p.domain || '').trim().toLowerCase();
            const pageUrl = String(p.page_url || '');
            if (!domain && pageUrl) domain = getNoteDomainFromUrl(pageUrl);
            if (!domain) domain = '(no site)';

            const passwordPlain = p.password != null ? String(p.password) : '';
            const extraObj = p.extra && typeof p.extra === 'object' && !Array.isArray(p.extra) ? p.extra : {};
            const extraJson = JSON.stringify(extraObj);
            const passwordEnc = _encField(passwordPlain);
            const extraEnc = _encField(extraJson);
            const loginPlain = String(p.login ?? '');
            const notesPlain = String(p.notes ?? '');
            const key = vaultCrypto.requireUnlockedMasterKey();

            const rec = {
                id: p.id ? Number(p.id) : null,
                vault_id: _activeVaultId() || 1,
                item_type: p.item_type || 'login',
                domain,
                url_match: String(p.url_match ?? ''),
                label: String(p.label ?? ''),
                login: '',
                login_encrypted: loginPlain ? encryptCredentialFieldWithKey(loginPlain, key) : null,
                password_encrypted: passwordEnc,
                extra_encrypted: extraEnc,
                notes: '',
                notes_encrypted: notesPlain ? encryptCredentialFieldWithKey(notesPlain, key) : null,
                last_ip: String(p.last_ip ?? ''),
                last_proxy_profile_id: p.last_proxy_profile_id,
                last_proxy_profile_name: String(p.last_proxy_profile_name ?? ''),
                last_used_at: p.last_used_at != null ? String(p.last_used_at) : new Date().toISOString(),
                tags: String(p.tags ?? ''),
                is_favorite: !!p.is_favorite,
                folder_id: p.folder_id != null ? Number(p.folder_id) : null,
            };

            const id = ctx.db.saveCredential(rec);

            if (Array.isArray(p.uris)) {
                ctx.db.saveCredentialUris(id, p.uris);
            }
            if (Array.isArray(p.customFields)) {
                const encrypted = p.customFields.map((f) => ({
                    name: f.name,
                    field_type: f.field_type || 'text',
                    value_encrypted: f.field_type === 'checkbox'
                        ? _encField(f.value ? '1' : '0')
                        : _encField(String(f.value ?? '')),
                }));
                ctx.db.saveCredentialCustomFields(id, encrypted);
            }

            return { success: true, id };
        } catch (e) {
            if (e?.code === 'CREDENTIALS_LOCKED') return { success: false, error: 'Vault is locked' };
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    handle('credentials-import-batch', async (_, payload) => {
        try {
            _requireMaster();
            const items = payload?.items;
            if (!Array.isArray(items) || items.length === 0) {
                return { success: false, error: 'No items to import' };
            }
            if (items.length > BATCH_IMPORT_MAX) {
                return { success: false, error: `Maximum ${BATCH_IMPORT_MAX} rows per batch` };
            }

            let grabMeta = {
                pageUrl: String(payload?.pageUrl || ''),
                last_ip: '',
                last_proxy_profile_id: null,
                last_proxy_profile_name: '',
            };
            if (payload?.grabIp) {
                try {
                    const tab = ctx.tabManager?.getActiveTab?.();
                    const tabId = tab?.id || null;
                    const geo = typeof ctx.checkCurrentIpGeo === 'function'
                        ? await ctx.checkCurrentIpGeo(tabId)
                        : { ip: '' };
                    grabMeta.last_ip = geo?.ip && geo.ip !== 'unknown' ? String(geo.ip) : String(geo?.ip || '');
                    let proxyProfileId = tab?.proxyProfileId != null ? Number(tab.proxyProfileId) : null;
                    let proxyProfileName = '';
                    if (proxyProfileId && ctx.db?.getProxyProfileEncrypted) {
                        const prof = ctx.db.getProxyProfileEncrypted(proxyProfileId);
                        if (prof?.name) proxyProfileName = String(prof.name);
                    }
                    grabMeta.last_proxy_profile_id = proxyProfileId;
                    grabMeta.last_proxy_profile_name = proxyProfileName;
                } catch (e) {
                    ctx.sysLog?.('warn', 'credentials', 'batch grab ip: ' + String(e?.message || e));
                }
            }

            const sqlite = ctx.db.getDb && ctx.db.getDb();
            const runInsert = (row) => _insertCredentialFromImport(ctx, row, grabMeta);

            let imported = 0;
            let skipped = 0;
            const ids = [];
            const applyRows = (rows) => {
                for (const row of rows) {
                    const id = runInsert(row);
                    if (id == null) skipped++;
                    else {
                        imported++;
                        ids.push(id);
                    }
                }
            };
            if (sqlite && typeof sqlite.transaction === 'function') {
                sqlite.transaction(applyRows)(items);
            } else {
                applyRows(items);
            }

            return { success: true, imported, skipped, ids };
        } catch (e) {
            if (e?.code === 'CREDENTIALS_LOCKED') return { success: false, error: 'Vault is locked' };
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    handle('credentials-delete', (_, id, permanent) => {
        try {
            _requireMaster();
            if (permanent) {
                ctx.db.deleteCredential(id);
            } else {
                ctx.db.softDeleteCredential(id);
            }
            return { success: true };
        } catch (e) {
            if (e?.code === 'CREDENTIALS_LOCKED') return { success: false, error: 'Vault is locked' };
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    handle('credentials-restore', (_, id) => {
        try {
            _requireMaster();
            ctx.db.restoreCredential(id);
            return { success: true };
        } catch (e) {
            if (e?.code === 'CREDENTIALS_LOCKED') return { success: false, error: 'Vault is locked' };
            return { success: false, error: String(e?.message || e) };
        }
    });

    handle('credentials-purge-trash', () => {
        try {
            _requireMaster();
            ctx.db.purgeTrash(_activeVaultId());
            return { success: true };
        } catch (e) {
            if (e?.code === 'CREDENTIALS_LOCKED') return { success: false, error: 'Vault is locked' };
            return { success: false, error: String(e?.message || e) };
        }
    });

    handle('credentials-count-trash', () => {
        try {
            _requireMaster();
            return { count: ctx.db.countTrashItems(_activeVaultId()) };
        } catch { return { count: 0 }; }
    });

    handle('credentials-type-counts', () => {
        try {
            _requireMaster();
            return ctx.db.countCredentialsByType(_activeVaultId());
        } catch { return { login: 0, card: 0, identity: 0, note: 0, total: 0 }; }
    });

    handle('credentials-favorite', (_, id, value) => {
        try {
            _requireMaster();
            ctx.db.setCredentialFavorite(id, !!value);
            return { success: true };
        } catch (e) {
            if (e?.code === 'CREDENTIALS_LOCKED') return { success: false, error: 'Vault is locked' };
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    // ── Folders ──────────────────────────────────────────────────────────────
    handle('credentials-folders-list', () => {
        try {
            _requireMaster();
            return ctx.db.listCredentialFolders(_activeVaultId());
        } catch { return []; }
    });

    handle('credentials-folder-create', (_, name, parentId) => {
        try {
            _requireMaster();
            const id = ctx.db.createCredentialFolder(name, parentId, _activeVaultId());
            return { success: true, id };
        } catch (e) {
            return { success: false, error: String(e?.message || e) };
        }
    });

    handle('credentials-folder-rename', (_, id, name) => {
        try {
            _requireMaster();
            ctx.db.renameCredentialFolder(id, name);
            return { success: true };
        } catch (e) {
            return { success: false, error: String(e?.message || e) };
        }
    });

    handle('credentials-folder-delete', (_, id) => {
        try {
            _requireMaster();
            ctx.db.deleteCredentialFolder(id);
            return { success: true };
        } catch (e) {
            return { success: false, error: String(e?.message || e) };
        }
    });

    handle('credentials-move-to-folder', (_, credentialId, folderId) => {
        try {
            _requireMaster();
            ctx.db.moveCredentialToFolder(credentialId, folderId);
            return { success: true };
        } catch (e) {
            return { success: false, error: String(e?.message || e) };
        }
    });

    // ── URIs ────────────────────────────────────────────────────────────────
    handle('credentials-uris-get', (_, credentialId) => {
        try {
            _requireMaster();
            return ctx.db.listCredentialUris(credentialId);
        } catch { return []; }
    });

    handle('credentials-uris-save', (_, credentialId, uris) => {
        try {
            _requireMaster();
            ctx.db.saveCredentialUris(credentialId, uris);
            return { success: true };
        } catch (e) {
            return { success: false, error: String(e?.message || e) };
        }
    });

    // ── Custom fields ───────────────────────────────────────────────────────
    handle('credentials-fields-get', (_, credentialId) => {
        try {
            _requireMaster();
            const rows = ctx.db.listCredentialCustomFields(credentialId);
            return rows.map((r) => {
                let value = '';
                if (r.field_type === 'hidden' && r.value_encrypted && Buffer.isBuffer(r.value_encrypted)) {
                    try { value = _decField(r.value_encrypted); } catch { value = ''; }
                } else if (r.value_encrypted && Buffer.isBuffer(r.value_encrypted)) {
                    try { value = _decField(r.value_encrypted); } catch { value = ''; }
                }
                return { id: r.id, name: r.name, value, field_type: r.field_type, sort_order: r.sort_order };
            });
        } catch { return []; }
    });

    handle('credentials-fields-save', (_, credentialId, fields) => {
        try {
            _requireMaster();
            const encrypted = (fields || []).map((f) => ({
                name: f.name,
                field_type: f.field_type || 'text',
                value_encrypted: f.field_type === 'checkbox'
                    ? _encField(f.value ? '1' : '0')
                    : _encField(String(f.value ?? '')),
            }));
            ctx.db.saveCredentialCustomFields(credentialId, encrypted);
            return { success: true };
        } catch (e) {
            return { success: false, error: String(e?.message || e) };
        }
    });

    // ── Vault hint ──────────────────────────────────────────────────────────
    handle('credentials-vault-set-hint', (_, hint) => {
        try {
            _requireMaster();
            ctx.db.setVaultHint(_activeVaultId(), hint);
            return { success: true };
        } catch (e) {
            return { success: false, error: String(e?.message || e) };
        }
    });

    handle('credentials-get-tab-proxy-ip', async () => {
        try {
            const tab = ctx.tabManager?.getActiveTab?.();
            const tabId = tab?.id || null;
            const geo = typeof ctx.checkCurrentIpGeo === 'function'
                ? await ctx.checkCurrentIpGeo(tabId)
                : { ip: 'unknown' };
            const ip = geo?.ip && geo.ip !== 'unknown' ? String(geo.ip) : String(geo?.ip || '');
            let proxyProfileId = tab?.proxyProfileId != null ? Number(tab.proxyProfileId) : null;
            let proxyProfileName = '';
            if (proxyProfileId && ctx.db?.getProxyProfileEncrypted) {
                const prof = ctx.db.getProxyProfileEncrypted(proxyProfileId);
                if (prof?.name) proxyProfileName = String(prof.name);
            }
            return {
                ip,
                city: geo?.city || '',
                country: geo?.country || '',
                proxyProfileId,
                proxyProfileName,
            };
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', 'get-tab-proxy-ip: ' + String(e?.message || e));
            return { ip: '', proxyProfileId: null, proxyProfileName: '', error: String(e?.message || e) };
        }
    });

    handle('credentials-site-matches', (_, payload) => {
        try {
            const vaults = ctx.db?.listVaults?.() || [];
            if (!vaults.length) return { exists: false, unlocked: false, matches: [] };
            if (!_isUnlocked()) return { exists: true, unlocked: false, matches: [] };
            const pageUrl = String(payload?.pageUrl || '');
            if (!/^https?:\/\//i.test(pageUrl)) return { exists: true, unlocked: true, matches: [] };
            const domain = String(payload?.domain || '').trim().toLowerCase() || getNoteDomainFromUrl(pageUrl);
            if (!domain) return { exists: true, unlocked: true, matches: [] };
            let rows = ctx.db.listCredentials({ domain, limit: 2000, vaultId: _activeVaultId() });
            rows = rows.filter((r) => noteMatchesUrlMatch(r.url_match || '', pageUrl));
            const matches = rows.map((r) => ({
                id: r.id,
                login: String(r.login || ''),
                label: String(r.label || ''),
            }));
            return { exists: true, unlocked: true, matches };
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', 'site-matches: ' + String(e?.message || e));
            return { exists: true, unlocked: _isUnlocked(), matches: [] };
        }
    });

    handle('credentials-site-match-count', (_, payload) => {
        try {
            const vaults = ctx.db?.listVaults?.() || [];
            if (!vaults.length) return { exists: false, unlocked: false, count: 0 };
            const unlocked = _isUnlocked();
            const pageUrl = String(payload?.pageUrl || '');
            if (!/^https?:\/\//i.test(pageUrl)) return { exists: true, unlocked, count: 0 };
            const domain = String(payload?.domain || '').trim().toLowerCase() || getNoteDomainFromUrl(pageUrl);
            if (!domain) return { exists: true, unlocked, count: 0 };
            const vid = _activeVaultId() != null ? _activeVaultId() : vaults[0].id;
            let rows = ctx.db.listCredentials({ domain, limit: 2000, vaultId: vid });
            rows = rows.filter((r) => noteMatchesUrlMatch(r.url_match || '', pageUrl));
            return { exists: true, unlocked, count: rows.length };
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', 'site-match-count: ' + String(e?.message || e));
            return { exists: true, unlocked: _isUnlocked(), count: 0 };
        }
    });

    /** Unlock vault and return site matches for pageUrl in one round-trip (toolbar popup). */
    handle('credentials-unlock-and-get-matches', async (_, payload) => {
        try {
            if (!ctx.db) return { success: false, error: 'Database unavailable' };
            const pageUrl = String(payload?.pageUrl || '');
            const pw = String(payload?.password || '');
            const targetId = payload?.vaultId != null ? Number(payload.vaultId) : null;
            let meta;
            if (targetId != null) {
                meta = ctx.db.getCredentialsVaultMeta(targetId);
            } else {
                const vaults = ctx.db.listVaults();
                meta = vaults.length === 1 ? ctx.db.getCredentialsVaultMeta(vaults[0].id) : null;
                if (!meta && _activeVaultId() != null) meta = ctx.db.getCredentialsVaultMeta(_activeVaultId());
                if (!meta && vaults.length > 0) meta = ctx.db.getCredentialsVaultMeta(vaults[0].id);
            }
            if (!meta) return { success: false, error: 'No vault — create one first' };
            const unlock = await _unlockVaultRecord(meta, pw);
            if (!unlock.success) return unlock;

            if (!/^https?:\/\//i.test(pageUrl)) {
                return { success: true, vaultId: meta.id, matches: [] };
            }
            const domain = getNoteDomainFromUrl(pageUrl);
            if (!domain) return { success: true, vaultId: meta.id, matches: [] };
            let rows = ctx.db.listCredentials({ domain, limit: 2000, vaultId: _activeVaultId() });
            rows = rows.filter((r) => noteMatchesUrlMatch(r.url_match || '', pageUrl));
            const matches = rows.map((r) => ({
                id: r.id,
                login: String(r.login || ''),
                label: String(r.label || ''),
            }));
            return { success: true, vaultId: meta.id, matches };
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', 'unlock-and-get-matches: ' + String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    function _fillScript(login, password) {
        const lj = JSON.stringify(String(login ?? ''));
        const pj = JSON.stringify(String(password ?? ''));
        return `(function(){
            const login = ${lj};
            const password = ${pj};
            const pwd = document.querySelector('input[type="password"]');
            if (!pwd) return { ok:false, error:'No password field' };
            const form = pwd.closest('form');
            let userEl = null;
            if (form) {
                const inputs = form.querySelectorAll('input');
                for (let i = 0; i < inputs.length; i++) {
                    const el = inputs[i];
                    if (el === pwd) continue;
                    const t = (el.type || '').toLowerCase();
                    if (t === 'password' || t === 'hidden' || t === 'submit' || t === 'button' || t === 'reset' || t === 'image' || t === 'file') continue;
                    userEl = el;
                    break;
                }
            }
            if (!userEl) {
                let n = pwd.previousElementSibling;
                while (n && n.tagName !== 'INPUT') n = n.previousElementSibling;
                if (n && n.tagName === 'INPUT' && (n.type || '').toLowerCase() !== 'password') userEl = n;
            }
            if (userEl) {
                userEl.focus();
                userEl.value = login;
                userEl.dispatchEvent(new Event('input', { bubbles: true }));
                userEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
            pwd.focus();
            pwd.value = password;
            pwd.dispatchEvent(new Event('input', { bubbles: true }));
            pwd.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok:true };
        })();`;
    }

    handle('credentials-fill-active-tab', async (_, payload) => {
        try {
            _requireMaster();
            const tab = ctx.tabManager?.getActiveTab?.();
            if (!tab?.view?.webContents || tab.view.webContents.isDestroyed()) {
                return { success: false, error: 'No active tab' };
            }
            const wc = tab.view.webContents;
            const pageUrl = wc.getURL();
            if (!/^https?:\/\//i.test(pageUrl)) {
                return { success: false, error: 'Not a web page' };
            }
            const domain = getNoteDomainFromUrl(pageUrl);
            if (!domain) return { success: false, error: 'Could not detect site' };

            let rows = ctx.db.listCredentials({ domain, limit: 2000, vaultId: _activeVaultId() });
            rows = rows.filter((r) => noteMatchesUrlMatch(r.url_match || '', pageUrl));
            if (!rows.length) return { success: false, error: 'No saved credentials for this site' };

            const wantId = payload?.credentialId != null ? Number(payload.credentialId) : null;
            let pick = rows[0];
            if (wantId && Number.isFinite(wantId)) {
                const found = rows.find((r) => r.id === wantId);
                if (found) pick = found;
            }

            const row = ctx.db.getCredential(pick.id);
            if (!row) return { success: false, error: 'Entry not found' };
            let password = '';
            if (row.password_encrypted && Buffer.isBuffer(row.password_encrypted)) {
                try {
                    password = _decField(row.password_encrypted);
                } catch {
                    password = '';
                }
            }
            const login = String(row.login || '');
            const res = await wc.executeJavaScript(_fillScript(login, password));
            if (!res || !res.ok) {
                return { success: false, error: (res && res.error) || 'Fill failed' };
            }

            let lastIp = '';
            let proxyProfileId = tab.proxyProfileId != null ? Number(tab.proxyProfileId) : null;
            let proxyProfileName = '';
            try {
                const geo = typeof ctx.checkCurrentIpGeo === 'function'
                    ? await ctx.checkCurrentIpGeo(tab.id)
                    : { ip: '' };
                lastIp = geo?.ip && geo.ip !== 'unknown' ? String(geo.ip) : String(geo?.ip || '');
                if (proxyProfileId && ctx.db?.getProxyProfileEncrypted) {
                    const prof = ctx.db.getProxyProfileEncrypted(proxyProfileId);
                    if (prof?.name) proxyProfileName = String(prof.name);
                }
            } catch (_) { /* ignore */ }

            ctx.db.updateCredentialLastUsedMeta(row.id, {
                last_used_at: new Date().toISOString(),
                last_ip: lastIp,
                last_proxy_profile_id: proxyProfileId,
                last_proxy_profile_name: proxyProfileName,
            });
            _toolbarRefresh();
            return { success: true, id: row.id };
        } catch (e) {
            if (e?.code === 'CREDENTIALS_LOCKED') return { success: false, error: 'Unlock the vault first' };
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    function _saveCapturedCredential(capture, vaultId) {
        _requireMaster();
        const { login, password, domain, pageUrl, lastIp, proxyProfileId, proxyProfileName } = capture;
        let urlMatch = '';
        try {
            const u = new URL(/^https?:\/\//i.test(pageUrl) ? pageUrl : `https://${pageUrl}`);
            urlMatch = `${u.origin}/*`;
        } catch { urlMatch = ''; }

        const existing = ctx.db.listCredentials({ domain, limit: 2000, vaultId });
        const sameLogin = login
            ? existing.find((r) => String(r.login || '').trim() === login)
            : null;

        const passwordEnc = _encField(password);
        const extraEnc = _encField('{}');
        const now = new Date().toISOString();

        if (sameLogin) {
            const full = ctx.db.getCredential(sameLogin.id);
            if (!full) return;
            ctx.db.saveCredential({
                id: sameLogin.id,
                vault_id: vaultId,
                domain,
                url_match: full.url_match || urlMatch,
                label: full.label || '',
                login,
                password_encrypted: passwordEnc,
                extra_encrypted: full.extra_encrypted || extraEnc,
                notes: full.notes || '',
                last_ip: lastIp,
                last_proxy_profile_id: proxyProfileId,
                last_proxy_profile_name: proxyProfileName,
                last_used_at: now,
                tags: full.tags || '',
                is_favorite: !!full.is_favorite,
            });
        } else {
            ctx.db.saveCredential({
                id: null,
                vault_id: vaultId,
                domain,
                url_match: urlMatch,
                label: login || domain,
                login,
                password_encrypted: passwordEnc,
                extra_encrypted: extraEnc,
                notes: '',
                last_ip: lastIp,
                last_proxy_profile_id: proxyProfileId,
                last_proxy_profile_name: proxyProfileName,
                last_used_at: now,
                tags: '',
                is_favorite: false,
            });
        }
        _toolbarRefresh();
    }

    ctx.ipcMain.on('credential-form-captured', (event, payload) => {
        (async () => {
            try {
                if (!ctx.db) return;
                const vaults = ctx.db.listVaults();
                if (!vaults.length) return;
                const wc = event.sender;
                if (!wc || wc.isDestroyed()) return;
                const pageUrl = wc.getURL();
                if (!/^https?:\/\//i.test(pageUrl)) return;
                if (/file:|cupnet:|chrome-devtools:/i.test(pageUrl)) return;

                const login = String(payload?.login ?? '').trim();
                const password = payload?.password != null ? String(payload.password) : '';
                if (!password) return;

                const domain = getNoteDomainFromUrl(pageUrl);
                if (!domain) return;

                let lastIp = '';
                let proxyProfileId = null;
                let proxyProfileName = '';
                const tabId = ctx.tabManager?.getTabIdByWebContentsId?.(wc.id);
                if (tabId != null) {
                    const tab = ctx.tabManager.getTab(tabId);
                    proxyProfileId = tab?.proxyProfileId != null ? Number(tab.proxyProfileId) : null;
                    if (proxyProfileId && ctx.db?.getProxyProfileEncrypted) {
                        const prof = ctx.db.getProxyProfileEncrypted(proxyProfileId);
                        if (prof?.name) proxyProfileName = String(prof.name);
                    }
                    try {
                        if (typeof ctx.checkCurrentIpGeo === 'function') {
                            const geo = await ctx.checkCurrentIpGeo(tabId);
                            lastIp = geo?.ip && geo.ip !== 'unknown' ? String(geo.ip) : String(geo?.ip || '');
                        }
                    } catch (_) { /* ignore */ }
                }

                _pendingCapture = { login, password, domain, pageUrl, lastIp, proxyProfileId, proxyProfileName };

                if (_isUnlocked()) vaultSession.bumpActivity();

                const captureVaultId = _resolveCaptureVaultId(ctx);
                const needsUnlock = !vaultSession.isVaultUnlocked(captureVaultId);
                const shellWc = ctx.mainWindow && !ctx.mainWindow.isDestroyed()
                    ? ctx.mainWindow.webContents
                    : null;
                if (shellWc) {
                    shellWc.send('show-credential-save-bar', {
                        login,
                        domain,
                        needsUnlock,
                        vaultId: captureVaultId,
                        profileName: profileSession.getProfileName() || '',
                    });
                }
            } catch (e) {
                ctx.sysLog?.('warn', 'credentials', 'form-captured: ' + String(e?.message || e));
            }
        })();
    });

    handle('credential-capture-confirm', () => {
        try {
            if (!_pendingCapture) return { success: false, error: 'No pending capture' };
            _requireMaster();
            _saveCapturedCredential(_pendingCapture, _resolveCaptureVaultId(ctx));
            _pendingCapture = null;
            return { success: true };
        } catch (e) {
            if (e?.code === 'CREDENTIALS_LOCKED') return { success: false, error: 'Vault is locked' };
            ctx.sysLog?.('warn', 'credentials', 'capture-confirm: ' + String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    handle('credential-capture-dismiss', () => {
        _pendingCapture = null;
        return { success: true };
    });

    handle('credential-capture-unlock-and-save', async (_, password) => {
        try {
            if (!_pendingCapture) return { success: false, error: 'No pending capture' };
            if (!ctx.db) return { success: false, error: 'Database unavailable' };

            const vaults = ctx.db.listVaults();
            if (!vaults.length) return { success: false, error: 'No vault exists' };

            const targetVaultId = _resolveCaptureVaultId(ctx);
            const meta = ctx.db.getCredentialsVaultMeta(targetVaultId);
            if (!meta) return { success: false, error: 'Vault not found' };

            const unlock = await _unlockVaultRecord(meta, String(password || ''));
            if (!unlock.success) return unlock;

            _saveCapturedCredential(_pendingCapture, meta.id);
            _pendingCapture = null;
            return { success: true, vaultId: meta.id };
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', 'capture-unlock: ' + String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    handle('credentials-export', async (_, payload) => {
        try {
            _requireMaster();
            if (!ctx.db) return { canceled: false, error: 'Database unavailable' };
            const format = String(payload?.format || 'vault').toLowerCase();
            const settings = settingsStore.getCached() || settingsStore.loadSettings();
            const allowPlain = !!settings.allowPlaintextExport;

            if (['json', 'csv'].includes(format) && !allowPlain) {
                return {
                    canceled: false,
                    error: 'Plaintext export is disabled. Use encrypted vault export or enable it in Settings → Security.',
                };
            }
            if (['json', 'csv'].includes(format) && allowPlain) {
                const win = ctx.credentialsWindow && !ctx.credentialsWindow.isDestroyed()
                    ? ctx.credentialsWindow
                    : (ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow : null);
                const label = format.toUpperCase();
                const choice = ctx.dialog.showMessageBoxSync(win || undefined, {
                    type: 'warning',
                    buttons: ['Cancel', `Export plaintext ${label}`],
                    defaultId: 0,
                    cancelId: 0,
                    title: 'Export credentials as plaintext',
                    message: `Save all vault passwords as readable ${label}?`,
                    detail: 'The exported file will contain usernames and passwords in plaintext. '
                        + 'Anyone with access to the file or backups can read them. '
                        + 'Prefer encrypted .cupnet-vault-export when possible.',
                    noLink: true,
                });
                if (choice !== 1) return { canceled: true };
            }
            if (!['json', 'csv', 'vault', 'cupnet-vault-export'].includes(format)) {
                return { canceled: false, error: 'Invalid format' };
            }

            const allRows = ctx.db.listCredentials({ vaultId: _activeVaultId(), limit: 2000 });
            const items = [];
            for (const row of allRows) {
                const full = ctx.db.getCredential(row.id);
                if (!full) continue;
                let password = '';
                if (full.password_encrypted && Buffer.isBuffer(full.password_encrypted)) {
                    try { password = _decField(full.password_encrypted); } catch { password = ''; }
                }
                let extra = {};
                if (full.extra_encrypted && Buffer.isBuffer(full.extra_encrypted)) {
                    try { extra = _parseExtraJson(_decField(full.extra_encrypted)); } catch { extra = {}; }
                }
                items.push({
                    id: full.id,
                    domain: full.domain,
                    url_match: full.url_match || '',
                    label: full.label || '',
                    login: _plainLogin(full),
                    password,
                    extra,
                    notes: _plainNotes(full),
                    tags: full.tags || '',
                    last_ip: full.last_ip || '',
                    last_proxy_profile_id: full.last_proxy_profile_id,
                    last_proxy_profile_name: full.last_proxy_profile_name || '',
                    last_used_at: full.last_used_at,
                    is_favorite: !!full.is_favorite,
                    created_at: full.created_at,
                    updated_at: full.updated_at,
                });
            }

            let content = '';
            let ext = 'cupnet-vault-export';
            let filterName = 'CupNet Vault Export';

            if (format === 'json' || format === 'csv') {
                const escapeCsv = (v) => {
                    const s = String(v ?? '');
                    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
                    return s;
                };
                if (format === 'json') {
                    content = JSON.stringify(items, null, 2);
                    ext = 'json';
                    filterName = 'JSON';
                } else {
                    const cols = ['id', 'domain', 'url_match', 'label', 'login', 'password', 'tags', 'notes',
                        'last_ip', 'last_proxy_profile_name', 'last_used_at', 'is_favorite'];
                    content = `${cols.map(escapeCsv).join(',')}\n${items.map((r) =>
                        cols.map((c) => escapeCsv(r[c])).join(',')).join('\n')}`;
                    ext = 'csv';
                    filterName = 'CSV';
                }
            } else {
                const exportPassword = String(payload?.exportPassword || '');
                if (!exportPassword) return { canceled: false, error: 'Export password is required' };
                const pwCheck = validatePassword(exportPassword);
                if (!pwCheck.ok) return { canceled: false, error: pwCheck.error };
                content = _buildEncryptedVaultExport(items, exportPassword);
            }

            const win = ctx.credentialsWindow && !ctx.credentialsWindow.isDestroyed()
                ? ctx.credentialsWindow
                : (ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow : null);
            const docDir = ctx.app?.getPath?.('documents') || '';
            const defaultPath = docDir
                ? path.join(docDir, `credentials-export.${ext}`)
                : `credentials-export.${ext}`;
            const { canceled, filePath } = await ctx.dialog.showSaveDialog(win || undefined, {
                defaultPath,
                filters: [{ name: filterName, extensions: [ext] }],
            });
            if (canceled || !filePath) return { canceled: true };

            await writeFileSecureAsync(filePath, content, 'utf8');
            return { canceled: false, filePath };
        } catch (e) {
            if (e?.code === 'CREDENTIALS_LOCKED') return { canceled: false, error: 'Vault is locked' };
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { canceled: false, error: String(e?.message || e) };
        }
    });

    handle('credentials-change-master', async (_, payload) => {
        try {
            const oldPw = String(payload?.oldPassword || '');
            const newPw = String(payload?.newPassword || '');
            const confirm = String(payload?.confirm || '');
            const vid = _activeVaultId();
            if (!vid) return { success: false, error: 'No active vault' };
            const meta = ctx.db.getCredentialsVaultMeta(vid);
            if (!meta) return { success: false, error: 'No vault' };
            const pwCheck = validatePassword(newPw);
            if (!pwCheck.ok) return { success: false, error: pwCheck.error };
            if (newPw !== confirm) return { success: false, error: 'Confirmation does not match' };
            if (!(await verifyVaultPassword(meta.verify_blob, oldPw))) {
                return { success: false, error: 'Current password is wrong' };
            }
            if (!vaultSession.isVaultUnlocked(vid)) {
                return { success: false, error: 'Unlock the vault before changing master password' };
            }

            const newBlob = await createVaultVerifyBlob(newPw);
            const newKey = await deriveMasterKey(newPw, newBlob.subarray(5, 21));
            const rows = ctx.db.getAllCredentialCipherRows(vid);
            for (const row of rows) {
                let pwPlain = '';
                if (row.password_encrypted && Buffer.isBuffer(row.password_encrypted)) {
                    try { pwPlain = _decField(row.password_encrypted, oldPw); } catch { /* empty */ }
                }
                let extraJson = '{}';
                if (row.extra_encrypted && Buffer.isBuffer(row.extra_encrypted)) {
                    try { extraJson = _decField(row.extra_encrypted, oldPw); } catch { extraJson = '{}'; }
                }
                ctx.db.updateCredentialCipherFields(
                    row.id,
                    encryptCredentialFieldWithKey(pwPlain, newKey),
                    encryptCredentialFieldWithKey(extraJson, newKey),
                );
                try {
                    const fields = ctx.db.listCredentialCustomFields(row.id);
                    if (fields.length) {
                        const reEncrypted = fields.map((f) => {
                            let val = '';
                            if (f.value_encrypted && Buffer.isBuffer(f.value_encrypted)) {
                                try { val = _decField(f.value_encrypted, oldPw); } catch { val = ''; }
                            }
                            return {
                                name: f.name,
                                field_type: f.field_type,
                                value_encrypted: encryptCredentialFieldWithKey(val, newKey),
                            };
                        });
                        ctx.db.saveCredentialCustomFields(row.id, reEncrypted);
                    }
                } catch { /* ignore */ }
            }

            ctx.db.updateCredentialsVaultVerifyBlob(vid, newBlob);
            await vaultSession.unlockVault({ vaultId: vid, name: meta.name, password: newPw, verifyBlob: newBlob });
            return { success: true };
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });
}

function migratePlaintextCredentialFields(db, vaultId) {
    if (!db || typeof db.listCredentials !== 'function') return;
    const key = vaultSession.getMasterKey();
    if (!key) return;
    const rows = db.listCredentials({ vaultId, limit: 10000 });
    for (const row of rows) {
        const full = db.getCredential(row.id);
        if (!full) continue;
        let changed = false;
        const patch = { id: full.id };
        if (full.login && String(full.login).trim() && !full.login_encrypted) {
            patch.login_encrypted = encryptCredentialFieldWithKey(String(full.login), key);
            patch.login = '';
            changed = true;
        }
        if (full.notes && String(full.notes).trim() && !full.notes_encrypted) {
            patch.notes_encrypted = encryptCredentialFieldWithKey(String(full.notes), key);
            patch.notes = '';
            changed = true;
        }
        if (changed && typeof db.updateCredentialSensitiveFields === 'function') {
            db.updateCredentialSensitiveFields(patch);
        }
    }
}

module.exports = {
    registerCredentialsIpc,
    clearCredentialsVaultSession,
    migratePlaintextCredentialFields,
};
