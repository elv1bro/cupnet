'use strict';

const fs = require('fs').promises;
const path = require('path');
const {
    encryptCredentialField,
    decryptCredentialField,
    createVaultVerifyBlob,
    verifyVaultPassword,
} = require('../../../credentials-crypto.js');
const { getNoteDomainFromUrl, noteMatchesUrlMatch } = require('../../../note-domain-utils.js');

/** Map of vaultId -> masterPassword for unlocked vaults. */
const _vaultPasswords = new Map();
/** Currently active vault id. */
let _activeVaultId = null;
/** Pending credential capture (waiting for user confirm/dismiss). */
let _pendingCapture = null;

function clearCredentialsVaultSession() {
    _vaultPasswords.clear();
    _activeVaultId = null;
    _pendingCapture = null;
}

function _isUnlocked() {
    return _activeVaultId != null && _vaultPasswords.has(_activeVaultId);
}

function _getActiveVaultPassword() {
    if (_activeVaultId == null) return null;
    return _vaultPasswords.get(_activeVaultId) || null;
}

function _requireMaster() {
    const pw = _getActiveVaultPassword();
    if (!pw) {
        const err = new Error('Vault is locked');
        err.code = 'CREDENTIALS_LOCKED';
        throw err;
    }
    return pw;
}

function _anyVaultUnlocked() {
    return _vaultPasswords.size > 0;
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
 * @param {string} master
 * @param {object} p
 * @param {{ last_ip?: string, last_proxy_profile_id?: number|null, last_proxy_profile_name?: string, pageUrl?: string }} grabMeta
 * @returns {number|null} new row id or null if row skipped
 */
function _insertCredentialFromImport(ctx, master, p, grabMeta) {
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
    const passwordEnc = encryptCredentialField(passwordPlain, master);
    const extraEnc = encryptCredentialField(extraJson, master);

    const rec = {
        id: null,
        vault_id: _activeVaultId || 1,
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

function registerCredentialsIpc(ctx) {
    function _toolbarRefresh() {
        try {
            if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) {
                ctx.mainWindow.webContents.send('credentials-toolbar-refresh');
            }
        } catch (_) { /* ignore */ }
    }

    ctx.ipcMain.handle('credentials-vault-status', () => {
        try {
            if (!ctx.db) return { exists: false, unlocked: false };
            const vaults = ctx.db.listVaults();
            if (!vaults.length) return { exists: false, unlocked: false };
            const activeVault = _activeVaultId != null
                ? ctx.db.getCredentialsVaultMeta(_activeVaultId)
                : vaults[0];
            return {
                exists: true,
                unlocked: _isUnlocked(),
                activeVaultId: _activeVaultId,
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

    ctx.ipcMain.handle('credentials-vault-list', () => {
        try {
            if (!ctx.db) return [];
            return ctx.db.listVaults().map(v => ({
                ...v,
                unlocked: _vaultPasswords.has(v.id),
                isActive: v.id === _activeVaultId,
            }));
        } catch { return []; }
    });

    ctx.ipcMain.handle('credentials-vault-create', (_, payload) => {
        try {
            if (!ctx.db) return { success: false, error: 'Database unavailable' };
            const name = String(payload?.name || '').trim();
            if (!name) return { success: false, error: 'Vault name is required' };
            const pw = String(payload?.password || '');
            const confirm = String(payload?.confirm || '');
            if (pw.length < 8) return { success: false, error: 'Master password must be at least 8 characters' };
            if (pw !== confirm) return { success: false, error: 'Passwords do not match' };
            const blob = createVaultVerifyBlob(pw);
            const id = ctx.db.createVault(name, blob);
            _vaultPasswords.set(id, pw);
            _activeVaultId = id;
            ctx.db.updateVaultLastLogin(id);
            _toolbarRefresh();
            return { success: true, id };
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    ctx.ipcMain.handle('credentials-vault-setup', (_, payload) => {
        try {
            if (!ctx.db) return { success: false, error: 'Database unavailable' };
            const vaults = ctx.db.listVaults();
            if (vaults.length > 0) {
                return { success: false, error: 'Vault already exists' };
            }
            const pw = String(payload?.password || '');
            const confirm = String(payload?.confirm || '');
            if (pw.length < 8) return { success: false, error: 'Master password must be at least 8 characters' };
            if (pw !== confirm) return { success: false, error: 'Passwords do not match' };
            const blob = createVaultVerifyBlob(pw);
            const id = ctx.db.createVault(String(payload?.name || 'Default'), blob);
            _vaultPasswords.set(id, pw);
            _activeVaultId = id;
            ctx.db.updateVaultLastLogin(id);
            _toolbarRefresh();
            return { success: true, id };
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    ctx.ipcMain.handle('credentials-unlock', (_, password, vaultId) => {
        try {
            if (!ctx.db) return { success: false, error: 'Database unavailable' };
            const targetId = vaultId != null ? Number(vaultId) : null;
            let meta;
            if (targetId != null) {
                meta = ctx.db.getCredentialsVaultMeta(targetId);
            } else {
                const vaults = ctx.db.listVaults();
                meta = vaults.length === 1 ? ctx.db.getCredentialsVaultMeta(vaults[0].id) : null;
                if (!meta && _activeVaultId != null) meta = ctx.db.getCredentialsVaultMeta(_activeVaultId);
                if (!meta && vaults.length > 0) meta = ctx.db.getCredentialsVaultMeta(vaults[0].id);
            }
            if (!meta) return { success: false, error: 'No vault — create one first' };
            const pw = String(password || '');
            if (!verifyVaultPassword(meta.verify_blob, pw)) {
                return { success: false, error: 'Invalid master password' };
            }
            _vaultPasswords.set(meta.id, pw);
            _activeVaultId = meta.id;
            ctx.db.updateVaultLastLogin(meta.id);
            _toolbarRefresh();
            return { success: true, vaultId: meta.id };
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    ctx.ipcMain.handle('credentials-vault-switch', (_, vaultId, password) => {
        try {
            if (!ctx.db) return { success: false, error: 'Database unavailable' };
            const vid = Number(vaultId);
            const meta = ctx.db.getCredentialsVaultMeta(vid);
            if (!meta) return { success: false, error: 'Vault not found' };
            if (_vaultPasswords.has(vid)) {
                _activeVaultId = vid;
                _toolbarRefresh();
                return { success: true };
            }
            const pw = String(password || '');
            if (!pw) return { success: false, error: 'Password required to unlock vault' };
            if (!verifyVaultPassword(meta.verify_blob, pw)) {
                return { success: false, error: 'Invalid master password' };
            }
            _vaultPasswords.set(vid, pw);
            _activeVaultId = vid;
            ctx.db.updateVaultLastLogin(vid);
            _toolbarRefresh();
            return { success: true };
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    ctx.ipcMain.handle('credentials-vault-delete', (_, vaultId, password) => {
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
                if (!verifyVaultPassword(meta.verify_blob, pw)) {
                    return { success: false, error: 'Invalid password' };
                }
            }

            ctx.db.deleteVault(vid);
            _vaultPasswords.delete(vid);
            if (_activeVaultId === vid) {
                _activeVaultId = null;
                const remaining = ctx.db.listVaults();
                if (remaining.length > 0) _activeVaultId = remaining[0].id;
            }
            _toolbarRefresh();
            return { success: true };
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    ctx.ipcMain.handle('credentials-vault-rename', (_, vaultId, name) => {
        try {
            _requireMaster();
            ctx.db.renameVault(vaultId, name);
            return { success: true };
        } catch (e) {
            return { success: false, error: String(e?.message || e) };
        }
    });

    ctx.ipcMain.handle('credentials-lock', () => {
        _vaultPasswords.clear();
        _activeVaultId = null;
        _pendingCapture = null;
        _toolbarRefresh();
        return { success: true };
    });

    ctx.ipcMain.handle('credentials-list', (_, filter) => {
        _requireMaster();
        const f = { ...(filter || {}), vaultId: _activeVaultId };
        let rows = ctx.db.listCredentials(f);
        if (f.refineByUrlMatch && f.pageUrl) {
            const pu = String(f.pageUrl);
            rows = rows.filter((r) => noteMatchesUrlMatch(r.url_match || '', pu));
        }
        return rows;
    });

    ctx.ipcMain.handle('credentials-get', (_, id) => {
        const master = _requireMaster();
        const row = ctx.db.getCredential(id);
        if (!row) return null;
        let password = '';
        if (row.password_encrypted && Buffer.isBuffer(row.password_encrypted)) {
            try {
                password = decryptCredentialField(row.password_encrypted, master);
            } catch (e) {
                ctx.sysLog?.('warn', 'credentials', 'decrypt password: ' + String(e?.message || e));
                password = '';
            }
        }
        let extra = {};
        if (row.extra_encrypted && Buffer.isBuffer(row.extra_encrypted)) {
            try {
                const json = decryptCredentialField(row.extra_encrypted, master);
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
                    try { value = decryptCredentialField(f.value_encrypted, master); } catch { value = ''; }
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
            login: row.login || '',
            password,
            extra,
            notes: row.notes || '',
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

    ctx.ipcMain.handle('credentials-save', (_, payload) => {
        try {
            const master = _requireMaster();
            const p = payload || {};
            let domain = String(p.domain || '').trim().toLowerCase();
            const pageUrl = String(p.page_url || '');
            if (!domain && pageUrl) domain = getNoteDomainFromUrl(pageUrl);
            if (!domain) domain = '(no site)';

            const passwordPlain = p.password != null ? String(p.password) : '';
            const extraObj = p.extra && typeof p.extra === 'object' && !Array.isArray(p.extra) ? p.extra : {};
            const extraJson = JSON.stringify(extraObj);
            const passwordEnc = encryptCredentialField(passwordPlain, master);
            const extraEnc = encryptCredentialField(extraJson, master);

            const rec = {
                id: p.id ? Number(p.id) : null,
                vault_id: _activeVaultId || 1,
                item_type: p.item_type || 'login',
                domain,
                url_match: String(p.url_match ?? ''),
                label: String(p.label ?? ''),
                login: String(p.login ?? ''),
                password_encrypted: passwordEnc,
                extra_encrypted: extraEnc,
                notes: String(p.notes ?? ''),
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
                        ? encryptCredentialField(f.value ? '1' : '0', master)
                        : encryptCredentialField(String(f.value ?? ''), master),
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

    ctx.ipcMain.handle('credentials-import-batch', async (_, payload) => {
        try {
            const master = _requireMaster();
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
            const runInsert = (row) => _insertCredentialFromImport(ctx, master, row, grabMeta);

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

    ctx.ipcMain.handle('credentials-delete', (_, id, permanent) => {
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

    ctx.ipcMain.handle('credentials-restore', (_, id) => {
        try {
            _requireMaster();
            ctx.db.restoreCredential(id);
            return { success: true };
        } catch (e) {
            if (e?.code === 'CREDENTIALS_LOCKED') return { success: false, error: 'Vault is locked' };
            return { success: false, error: String(e?.message || e) };
        }
    });

    ctx.ipcMain.handle('credentials-purge-trash', () => {
        try {
            _requireMaster();
            ctx.db.purgeTrash(_activeVaultId);
            return { success: true };
        } catch (e) {
            if (e?.code === 'CREDENTIALS_LOCKED') return { success: false, error: 'Vault is locked' };
            return { success: false, error: String(e?.message || e) };
        }
    });

    ctx.ipcMain.handle('credentials-count-trash', () => {
        try {
            _requireMaster();
            return { count: ctx.db.countTrashItems(_activeVaultId) };
        } catch { return { count: 0 }; }
    });

    ctx.ipcMain.handle('credentials-type-counts', () => {
        try {
            _requireMaster();
            return ctx.db.countCredentialsByType(_activeVaultId);
        } catch { return { login: 0, card: 0, identity: 0, note: 0, total: 0 }; }
    });

    ctx.ipcMain.handle('credentials-favorite', (_, id, value) => {
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
    ctx.ipcMain.handle('credentials-folders-list', () => {
        try {
            _requireMaster();
            return ctx.db.listCredentialFolders(_activeVaultId);
        } catch { return []; }
    });

    ctx.ipcMain.handle('credentials-folder-create', (_, name, parentId) => {
        try {
            _requireMaster();
            const id = ctx.db.createCredentialFolder(name, parentId, _activeVaultId);
            return { success: true, id };
        } catch (e) {
            return { success: false, error: String(e?.message || e) };
        }
    });

    ctx.ipcMain.handle('credentials-folder-rename', (_, id, name) => {
        try {
            _requireMaster();
            ctx.db.renameCredentialFolder(id, name);
            return { success: true };
        } catch (e) {
            return { success: false, error: String(e?.message || e) };
        }
    });

    ctx.ipcMain.handle('credentials-folder-delete', (_, id) => {
        try {
            _requireMaster();
            ctx.db.deleteCredentialFolder(id);
            return { success: true };
        } catch (e) {
            return { success: false, error: String(e?.message || e) };
        }
    });

    ctx.ipcMain.handle('credentials-move-to-folder', (_, credentialId, folderId) => {
        try {
            _requireMaster();
            ctx.db.moveCredentialToFolder(credentialId, folderId);
            return { success: true };
        } catch (e) {
            return { success: false, error: String(e?.message || e) };
        }
    });

    // ── URIs ────────────────────────────────────────────────────────────────
    ctx.ipcMain.handle('credentials-uris-get', (_, credentialId) => {
        try {
            _requireMaster();
            return ctx.db.listCredentialUris(credentialId);
        } catch { return []; }
    });

    ctx.ipcMain.handle('credentials-uris-save', (_, credentialId, uris) => {
        try {
            _requireMaster();
            ctx.db.saveCredentialUris(credentialId, uris);
            return { success: true };
        } catch (e) {
            return { success: false, error: String(e?.message || e) };
        }
    });

    // ── Custom fields ───────────────────────────────────────────────────────
    ctx.ipcMain.handle('credentials-fields-get', (_, credentialId) => {
        try {
            const master = _requireMaster();
            const rows = ctx.db.listCredentialCustomFields(credentialId);
            return rows.map((r) => {
                let value = '';
                if (r.field_type === 'hidden' && r.value_encrypted && Buffer.isBuffer(r.value_encrypted)) {
                    try { value = decryptCredentialField(r.value_encrypted, master); } catch { value = ''; }
                } else if (r.value_encrypted && Buffer.isBuffer(r.value_encrypted)) {
                    try { value = decryptCredentialField(r.value_encrypted, master); } catch { value = ''; }
                }
                return { id: r.id, name: r.name, value, field_type: r.field_type, sort_order: r.sort_order };
            });
        } catch { return []; }
    });

    ctx.ipcMain.handle('credentials-fields-save', (_, credentialId, fields) => {
        try {
            const master = _requireMaster();
            const encrypted = (fields || []).map((f) => ({
                name: f.name,
                field_type: f.field_type || 'text',
                value_encrypted: f.field_type === 'checkbox'
                    ? encryptCredentialField(f.value ? '1' : '0', master)
                    : encryptCredentialField(String(f.value ?? ''), master),
            }));
            ctx.db.saveCredentialCustomFields(credentialId, encrypted);
            return { success: true };
        } catch (e) {
            return { success: false, error: String(e?.message || e) };
        }
    });

    // ── Vault hint ──────────────────────────────────────────────────────────
    ctx.ipcMain.handle('credentials-vault-set-hint', (_, hint) => {
        try {
            _requireMaster();
            ctx.db.setVaultHint(_activeVaultId, hint);
            return { success: true };
        } catch (e) {
            return { success: false, error: String(e?.message || e) };
        }
    });

    ctx.ipcMain.handle('credentials-get-tab-proxy-ip', async () => {
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

    ctx.ipcMain.handle('credentials-site-matches', (_, payload) => {
        try {
            const vaults = ctx.db?.listVaults?.() || [];
            if (!vaults.length) return { exists: false, unlocked: false, matches: [] };
            if (!_isUnlocked()) return { exists: true, unlocked: false, matches: [] };
            const pageUrl = String(payload?.pageUrl || '');
            if (!/^https?:\/\//i.test(pageUrl)) return { exists: true, unlocked: true, matches: [] };
            const domain = String(payload?.domain || '').trim().toLowerCase() || getNoteDomainFromUrl(pageUrl);
            if (!domain) return { exists: true, unlocked: true, matches: [] };
            let rows = ctx.db.listCredentials({ domain, limit: 2000, vaultId: _activeVaultId });
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

    ctx.ipcMain.handle('credentials-site-match-count', (_, payload) => {
        try {
            const vaults = ctx.db?.listVaults?.() || [];
            if (!vaults.length) return { exists: false, unlocked: false, count: 0 };
            const unlocked = _isUnlocked();
            const pageUrl = String(payload?.pageUrl || '');
            if (!/^https?:\/\//i.test(pageUrl)) return { exists: true, unlocked, count: 0 };
            const domain = String(payload?.domain || '').trim().toLowerCase() || getNoteDomainFromUrl(pageUrl);
            if (!domain) return { exists: true, unlocked, count: 0 };
            const vid = _activeVaultId != null ? _activeVaultId : vaults[0].id;
            let rows = ctx.db.listCredentials({ domain, limit: 2000, vaultId: vid });
            rows = rows.filter((r) => noteMatchesUrlMatch(r.url_match || '', pageUrl));
            return { exists: true, unlocked, count: rows.length };
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', 'site-match-count: ' + String(e?.message || e));
            return { exists: true, unlocked: _isUnlocked(), count: 0 };
        }
    });

    /** Unlock vault and return site matches for pageUrl in one round-trip (toolbar popup). */
    ctx.ipcMain.handle('credentials-unlock-and-get-matches', (_, payload) => {
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
                if (!meta && _activeVaultId != null) meta = ctx.db.getCredentialsVaultMeta(_activeVaultId);
                if (!meta && vaults.length > 0) meta = ctx.db.getCredentialsVaultMeta(vaults[0].id);
            }
            if (!meta) return { success: false, error: 'No vault — create one first' };
            if (!verifyVaultPassword(meta.verify_blob, pw)) {
                return { success: false, error: 'Invalid master password' };
            }
            _vaultPasswords.set(meta.id, pw);
            _activeVaultId = meta.id;
            ctx.db.updateVaultLastLogin(meta.id);
            _toolbarRefresh();

            if (!/^https?:\/\//i.test(pageUrl)) {
                return { success: true, vaultId: meta.id, matches: [] };
            }
            const domain = getNoteDomainFromUrl(pageUrl);
            if (!domain) return { success: true, vaultId: meta.id, matches: [] };
            let rows = ctx.db.listCredentials({ domain, limit: 2000, vaultId: _activeVaultId });
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

    ctx.ipcMain.handle('credentials-fill-active-tab', async (_, payload) => {
        try {
            const master = _requireMaster();
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

            let rows = ctx.db.listCredentials({ domain, limit: 2000, vaultId: _activeVaultId });
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
                    password = decryptCredentialField(row.password_encrypted, master);
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

    function _saveCapturedCredential(capture, master, vaultId) {
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

        const passwordEnc = encryptCredentialField(password, master);
        const extraEnc = encryptCredentialField('{}', master);
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

                const needsUnlock = !_isUnlocked();
                const shellWc = ctx.mainWindow && !ctx.mainWindow.isDestroyed()
                    ? ctx.mainWindow.webContents
                    : null;
                if (shellWc) {
                    shellWc.send('show-credential-save-bar', {
                        login,
                        domain,
                        needsUnlock,
                        vaultId: _activeVaultId,
                    });
                }
            } catch (e) {
                ctx.sysLog?.('warn', 'credentials', 'form-captured: ' + String(e?.message || e));
            }
        })();
    });

    ctx.ipcMain.handle('credential-capture-confirm', () => {
        try {
            if (!_pendingCapture) return { success: false, error: 'No pending capture' };
            const master = _requireMaster();
            _saveCapturedCredential(_pendingCapture, master, _activeVaultId || 1);
            _pendingCapture = null;
            return { success: true };
        } catch (e) {
            if (e?.code === 'CREDENTIALS_LOCKED') return { success: false, error: 'Vault is locked' };
            ctx.sysLog?.('warn', 'credentials', 'capture-confirm: ' + String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    ctx.ipcMain.handle('credential-capture-dismiss', () => {
        _pendingCapture = null;
        return { success: true };
    });

    ctx.ipcMain.handle('credential-capture-unlock-and-save', (_, password) => {
        try {
            if (!_pendingCapture) return { success: false, error: 'No pending capture' };
            if (!ctx.db) return { success: false, error: 'Database unavailable' };

            const vaults = ctx.db.listVaults();
            if (!vaults.length) return { success: false, error: 'No vault exists' };

            const targetVaultId = _activeVaultId || vaults[0].id;
            const meta = ctx.db.getCredentialsVaultMeta(targetVaultId);
            if (!meta) return { success: false, error: 'Vault not found' };

            const pw = String(password || '');
            if (!verifyVaultPassword(meta.verify_blob, pw)) {
                return { success: false, error: 'Invalid master password' };
            }

            _vaultPasswords.set(meta.id, pw);
            _activeVaultId = meta.id;
            ctx.db.updateVaultLastLogin(meta.id);

            _saveCapturedCredential(_pendingCapture, pw, meta.id);
            _pendingCapture = null;
            _toolbarRefresh();
            return { success: true, vaultId: meta.id };
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', 'capture-unlock: ' + String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });

    ctx.ipcMain.handle('credentials-export', async (_, payload) => {
        try {
            const master = _requireMaster();
            if (!ctx.db) return { canceled: false, error: 'Database unavailable' };
            const format = String(payload?.format || 'json').toLowerCase();
            if (!['json', 'csv'].includes(format)) return { canceled: false, error: 'Invalid format' };

            const allRows = ctx.db.listCredentials({ vaultId: _activeVaultId, limit: 2000 });
            const idRows = allRows.map(r => ({ id: r.id }));
            const items = [];
            for (const { id } of idRows) {
                const row = ctx.db.getCredential(id);
                if (!row) continue;
                let password = '';
                if (row.password_encrypted && Buffer.isBuffer(row.password_encrypted)) {
                    try {
                        password = decryptCredentialField(row.password_encrypted, master);
                    } catch {
                        password = '';
                    }
                }
                let extra = {};
                if (row.extra_encrypted && Buffer.isBuffer(row.extra_encrypted)) {
                    try {
                        const json = decryptCredentialField(row.extra_encrypted, master);
                        extra = _parseExtraJson(json);
                    } catch {
                        extra = {};
                    }
                }
                items.push({
                    id: row.id,
                    domain: row.domain,
                    url_match: row.url_match || '',
                    label: row.label || '',
                    login: row.login || '',
                    password,
                    extra,
                    notes: row.notes || '',
                    tags: row.tags || '',
                    last_ip: row.last_ip || '',
                    last_proxy_profile_id: row.last_proxy_profile_id,
                    last_proxy_profile_name: row.last_proxy_profile_name || '',
                    last_used_at: row.last_used_at,
                    is_favorite: !!row.is_favorite,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                });
            }

            let content = '';
            let ext = 'json';
            const escapeCsv = (v) => {
                const s = String(v ?? '');
                if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
                return s;
            };
            if (format === 'json') {
                content = JSON.stringify(items, null, 2);
                ext = 'json';
            } else {
                const cols = ['id', 'domain', 'url_match', 'label', 'login', 'password', 'tags', 'notes',
                    'last_ip', 'last_proxy_profile_name', 'last_used_at', 'is_favorite'];
                content = `${cols.map(escapeCsv).join(',')}\n${items.map((r) =>
                    cols.map((c) => escapeCsv(r[c])).join(',')).join('\n')}`;
                ext = 'csv';
            }

            const win = ctx.credentialsWindow && !ctx.credentialsWindow.isDestroyed()
                ? ctx.credentialsWindow
                : (ctx.mainWindow && !ctx.mainWindow.isDestroyed() ? ctx.mainWindow : null);
            const docDir = ctx.app?.getPath?.('documents') || '';
            const defaultPath = docDir ? path.join(docDir, `credentials-export.${ext}`) : `credentials-export.${ext}`;
            const { canceled, filePath } = await ctx.dialog.showSaveDialog(win || undefined, {
                defaultPath,
                filters: [{ name: format === 'json' ? 'JSON' : 'CSV', extensions: [ext] }],
            });
            if (canceled || !filePath) return { canceled: true };

            await fs.writeFile(filePath, content, 'utf8');
            return { canceled: false, filePath };
        } catch (e) {
            if (e?.code === 'CREDENTIALS_LOCKED') return { canceled: false, error: 'Vault is locked' };
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { canceled: false, error: String(e?.message || e) };
        }
    });

    ctx.ipcMain.handle('credentials-change-master', (_, payload) => {
        try {
            const oldPw = String(payload?.oldPassword || '');
            const newPw = String(payload?.newPassword || '');
            const confirm = String(payload?.confirm || '');
            if (!_activeVaultId) return { success: false, error: 'No active vault' };
            const meta = ctx.db.getCredentialsVaultMeta(_activeVaultId);
            if (!meta) return { success: false, error: 'No vault' };
            if (newPw.length < 8) return { success: false, error: 'New password must be at least 8 characters' };
            if (newPw !== confirm) return { success: false, error: 'Confirmation does not match' };
            if (!verifyVaultPassword(meta.verify_blob, oldPw)) {
                return { success: false, error: 'Current password is wrong' };
            }
            const currentPw = _vaultPasswords.get(_activeVaultId);
            if (currentPw == null || oldPw !== currentPw) {
                return { success: false, error: 'Unlock the vault before changing master password' };
            }

            const rows = ctx.db.getAllCredentialCipherRows(_activeVaultId);
            for (const row of rows) {
                let pwPlain = '';
                if (row.password_encrypted && Buffer.isBuffer(row.password_encrypted)) {
                    try {
                        pwPlain = decryptCredentialField(row.password_encrypted, oldPw);
                    } catch { /* keep empty */ }
                }
                let extraJson = '{}';
                if (row.extra_encrypted && Buffer.isBuffer(row.extra_encrypted)) {
                    try {
                        extraJson = decryptCredentialField(row.extra_encrypted, oldPw);
                    } catch {
                        extraJson = '{}';
                    }
                }
                const newPwEnc = encryptCredentialField(pwPlain, newPw);
                const newExtraEnc = encryptCredentialField(extraJson, newPw);
                ctx.db.updateCredentialCipherFields(row.id, newPwEnc, newExtraEnc);

                try {
                    const fields = ctx.db.listCredentialCustomFields(row.id);
                    if (fields.length) {
                        const reEncrypted = fields.map((f) => {
                            let val = '';
                            if (f.value_encrypted && Buffer.isBuffer(f.value_encrypted)) {
                                try { val = decryptCredentialField(f.value_encrypted, oldPw); } catch { val = ''; }
                            }
                            return {
                                name: f.name,
                                field_type: f.field_type,
                                value_encrypted: encryptCredentialField(val, newPw),
                            };
                        });
                        ctx.db.saveCredentialCustomFields(row.id, reEncrypted);
                    }
                } catch { /* ignore individual field errors */ }
            }

            const newBlob = createVaultVerifyBlob(newPw);
            ctx.db.updateCredentialsVaultVerifyBlob(_activeVaultId, newBlob);
            _vaultPasswords.set(_activeVaultId, newPw);
            return { success: true };
        } catch (e) {
            ctx.sysLog?.('warn', 'credentials', String(e?.message || e));
            return { success: false, error: String(e?.message || e) };
        }
    });
}

module.exports = { registerCredentialsIpc, clearCredentialsVaultSession };
