'use strict';

function api() {
    const bridge = window.sessionProfileAPI;
    if (!bridge) {
        throw new Error('Launch Profile bridge is unavailable. Restart CupNet and try again.');
    }
    return bridge;
}

const $ = (id) => document.getElementById(id);

const els = {
    filePath: $('file-path'),
    browseBtn: $('browse-btn'),
    templateBtn: $('template-btn'),
    loadBtn: $('load-btn'),
    cancelBtn: $('cancel-btn'),
    statusText: $('status-text'),
    cookieBadge: $('cookie-badge'),
    name: $('pf-name'),
    description: $('pf-description'),
    format: $('pf-format'),
    version: $('pf-version'),
    recording: $('pf-recording'),
    url: $('pf-url'),
    timeout: $('pf-timeout'),
    newTab: $('pf-new-tab'),
    proxyTemplate: $('pf-proxy-template'),
    proxyTls: $('pf-proxy-tls'),
    proxyProfileId: $('pf-proxy-profile-id'),
    proxyVars: $('pf-proxy-vars'),
    ua: $('pf-ua'),
    language: $('pf-language'),
    timezone: $('pf-timezone'),
    clearCookies: $('pf-clear-cookies'),
    clearStorage: $('pf-clear-storage'),
    cookies: $('pf-cookies'),
    scriptDelay: $('pf-script-delay'),
    scriptTimeout: $('pf-script-timeout'),
    script: $('pf-script'),
    storage: $('pf-storage'),
    persistDns: $('pf-persist-dns'),
    dns: $('pf-dns'),
    rawJson: $('pf-raw-json'),
    applyJsonBtn: $('apply-json-btn'),
    refreshJsonBtn: $('refresh-json-btn'),
};

/** @type {string|null} */
let sourcePath = null;
let validateTimer = null;

const BLANK_TEMPLATE = {
    format: 'cupnet-launch',
    version: 1,
    name: 'New launch profile',
    description: '',
    tab: { newTab: true },
    navigate: { url: '', timeoutMs: 120000 },
    proxy: null,
    fingerprint: null,
    cookies: [],
    clearCookiesBeforeLoad: false,
    clearStorageBeforeLoad: false,
};

function parseJsonField(text, fallback, label) {
    const t = String(text || '').trim();
    if (!t) return { ok: true, value: fallback };
    try {
        return { ok: true, value: JSON.parse(t) };
    } catch (e) {
        return { ok: false, error: `${label}: invalid JSON — ${e.message}` };
    }
}

function setStatus(msg, kind = 'warn') {
    if (!els.statusText) return;
    els.statusText.textContent = msg;
    els.statusText.className = `status-text ${kind}`;
}

function updateCookieBadge(count) {
    if (els.cookieBadge) els.cookieBadge.textContent = String(count);
}

function countCookiesFromText(text) {
    const p = parseJsonField(text, [], 'Cookies');
    if (!p.ok || !Array.isArray(p.value)) return 0;
    return p.value.length;
}

/** @param {object} profile */
function fillFormFromProfile(profile) {
    const p = profile || {};
    if (els.name) els.name.value = p.name || '';
    if (els.description) els.description.value = p.description || '';
    if (els.format) els.format.value = p.format === 'cupnet-session' ? 'cupnet-session' : 'cupnet-launch';
    if (els.recording) els.recording.checked = p.logging?.recording != null ? !!p.logging.recording : false;

    if (els.url) els.url.value = p.navigate?.url || '';
    if (els.timeout) els.timeout.value = String(p.navigate?.timeoutMs ?? 120000);
    if (els.newTab) els.newTab.checked = p.tab?.newTab !== false;

    if (els.proxyTemplate) els.proxyTemplate.value = p.proxy?.template || '';
    if (els.proxyTls) els.proxyTls.value = p.proxy?.tlsProfile || '';
    if (els.proxyProfileId) {
        els.proxyProfileId.value = p.proxy?.profileId != null ? String(p.proxy.profileId) : '';
    }
    if (els.proxyVars) {
        els.proxyVars.value = p.proxy?.variables && Object.keys(p.proxy.variables).length
            ? JSON.stringify(p.proxy.variables, null, 2)
            : '';
    }

    if (els.ua) els.ua.value = p.fingerprint?.userAgent || '';
    if (els.language) els.language.value = p.fingerprint?.language || '';
    if (els.timezone) els.timezone.value = p.fingerprint?.timezone || '';

    if (els.clearCookies) els.clearCookies.checked = !!p.clearCookiesBeforeLoad;
    if (els.clearStorage) els.clearStorage.checked = !!p.clearStorageBeforeLoad;
    if (els.cookies) {
        els.cookies.value = Array.isArray(p.cookies) && p.cookies.length
            ? JSON.stringify(p.cookies, null, 2)
            : '';
    }
    updateCookieBadge(Array.isArray(p.cookies) ? p.cookies.length : 0);

    if (els.script) {
        const script = typeof p.runAfterLoad === 'string'
            ? p.runAfterLoad
            : (p.runAfterLoad?.script || '');
        els.script.value = script;
    }
    if (els.scriptDelay) els.scriptDelay.value = String(p.runAfterLoad?.delayMs ?? 0);
    if (els.scriptTimeout) els.scriptTimeout.value = String(p.runAfterLoad?.timeoutMs ?? 30000);

    if (els.storage) {
        const hasStorage = p.storage && (
            (p.storage.localStorage && Object.keys(p.storage.localStorage).length)
            || (p.storage.sessionStorage && Object.keys(p.storage.sessionStorage).length)
        );
        els.storage.value = hasStorage ? JSON.stringify(p.storage, null, 2) : '';
    }
    if (els.persistDns) els.persistDns.checked = !!p.persistDnsOverrides;
    if (els.dns) {
        els.dns.value = Array.isArray(p.dnsOverrides) && p.dnsOverrides.length
            ? JSON.stringify(p.dnsOverrides, null, 2)
            : '';
    }

    refreshRawJsonFromForm();
    scheduleValidate();
}

function buildProfileFromForm() {
    const format = els.format?.value === 'cupnet-session' ? 'cupnet-session' : 'cupnet-launch';

    const cookiesParsed = parseJsonField(els.cookies?.value, [], 'Cookies');
    if (!cookiesParsed.ok) return cookiesParsed;

    const proxyVarsParsed = parseJsonField(els.proxyVars?.value, {}, 'Proxy variables');
    if (!proxyVarsParsed.ok) return proxyVarsParsed;

    const storageParsed = parseJsonField(els.storage?.value, null, 'Storage');
    if (!storageParsed.ok) return storageParsed;

    const dnsParsed = parseJsonField(els.dns?.value, [], 'DNS overrides');
    if (!dnsParsed.ok) return dnsParsed;

    /** @type {Record<string, unknown>} */
    const profile = {
        format,
        version: 1,
        name: String(els.name?.value || '').trim() || 'Unnamed session',
        description: String(els.description?.value || '').trim(),
        tab: { newTab: !!els.newTab?.checked },
        navigate: {
            url: String(els.url?.value || '').trim(),
            timeoutMs: Math.min(300000, Math.max(5000, parseInt(els.timeout?.value, 10) || 120000)),
        },
        cookies: cookiesParsed.value,
        clearCookiesBeforeLoad: !!els.clearCookies?.checked,
        clearStorageBeforeLoad: !!els.clearStorage?.checked,
    };

    if (els.recording?.checked) {
        profile.logging = { recording: true };
    }

    const proxyTemplate = String(els.proxyTemplate?.value || '').trim();
    const proxyProfileIdRaw = String(els.proxyProfileId?.value || '').trim();
    const proxyProfileId = proxyProfileIdRaw ? Number(proxyProfileIdRaw) : null;
    if (proxyTemplate || (Number.isFinite(proxyProfileId) && proxyProfileId > 0)) {
        profile.proxy = {
            ...(Number.isFinite(proxyProfileId) && proxyProfileId > 0 ? { profileId: proxyProfileId } : {}),
            ...(proxyTemplate ? { template: proxyTemplate } : {}),
            variables: proxyVarsParsed.value && typeof proxyVarsParsed.value === 'object' ? proxyVarsParsed.value : {},
            ...(String(els.proxyTls?.value || '').trim()
                ? { tlsProfile: String(els.proxyTls.value).trim() }
                : {}),
        };
    }

    const ua = String(els.ua?.value || '').trim();
    const lang = String(els.language?.value || '').trim();
    const tz = String(els.timezone?.value || '').trim();
    if (ua || lang || tz) {
        profile.fingerprint = {
            ...(ua ? { userAgent: ua } : {}),
            ...(lang ? { language: lang } : {}),
            ...(tz ? { timezone: tz } : {}),
        };
    }

    const script = String(els.script?.value || '').trim();
    if (script) {
        profile.runAfterLoad = {
            script,
            delayMs: Math.max(0, parseInt(els.scriptDelay?.value, 10) || 0),
            timeoutMs: Math.min(300000, Math.max(1000, parseInt(els.scriptTimeout?.value, 10) || 30000)),
        };
    }

    if (storageParsed.value && typeof storageParsed.value === 'object') {
        profile.storage = storageParsed.value;
    }
    if (Array.isArray(dnsParsed.value) && dnsParsed.value.length) {
        profile.dnsOverrides = dnsParsed.value;
    }
    if (els.persistDns?.checked) {
        profile.persistDnsOverrides = true;
    }

    return { ok: true, value: profile };
}

function refreshRawJsonFromForm() {
    const built = buildProfileFromForm();
    if (!built.ok || !els.rawJson) return;
    els.rawJson.value = JSON.stringify(built.value, null, 2);
}

function scheduleValidate() {
    if (validateTimer) clearTimeout(validateTimer);
    validateTimer = setTimeout(() => { void runValidate(); }, 180);
}

async function runValidate() {
    updateCookieBadge(countCookiesFromText(els.cookies?.value));

    const built = buildProfileFromForm();
    if (!built.ok) {
        setStatus(built.error || 'Fix form errors', 'err');
        if (els.loadBtn) els.loadBtn.disabled = true;
        return;
    }

    const validated = await api().validateProfile(built.value);
    if (!validated.ok) {
        setStatus(validated.error || 'Profile validation failed', 'err');
        if (els.loadBtn) els.loadBtn.disabled = true;
        return;
    }

    const p = validated.profile;
    const parts = [];
    if (p.navigate?.url) parts.push('navigate');
    if (p.proxy) parts.push('proxy');
    if (p.cookies?.length) parts.push(`${p.cookies.length} cookie(s)`);
    if (p.fingerprint) parts.push('fingerprint');
    if (p.runAfterLoad?.script) parts.push('post-load script');
    if (p.storage) parts.push('storage');
    if (p.dnsOverrides?.length) parts.push('DNS');

    setStatus(parts.length
        ? `Ready to launch · ${parts.join(' · ')}`
        : 'Ready — review settings before launch', 'ok');
    if (els.loadBtn) els.loadBtn.disabled = false;
}

async function initModal() {
    try {
        const lastPath = await api().getLastLaunchProfilePath();
        if (lastPath) {
            const ok = await importFile(lastPath, { silent: true });
            if (ok) return;
        }
    } catch (_) { /* ignore */ }
    loadBlankTemplate();
}

async function browseFile() {
    const pick = await api().pickSessionProfileFile();
    if (!pick?.success || pick.canceled) return;
    await importFile(pick.path);
}

async function importFile(filePath, opts = {}) {
    const read = await api().readSessionProfileFile(filePath);
    if (!read?.success) {
        sourcePath = null;
        const msg = read?.error || 'Could not read file';
        if (opts.silent) {
            loadBlankTemplate();
            setStatus(`${msg} — use Import… to choose another file`, 'warn');
        } else {
            setStatus(msg, 'err');
            if (els.loadBtn) els.loadBtn.disabled = true;
        }
        return false;
    }
    sourcePath = read.path || filePath;
    if (els.filePath) els.filePath.value = sourcePath;
    try {
        await api().setLastLaunchProfilePath(sourcePath);
    } catch (_) { /* ignore */ }
    fillFormFromProfile(read.profile);
    if (!opts.silent) {
        setStatus('Imported — edit any field, then Launch', 'ok');
    } else {
        setStatus('Last profile loaded — Import… to change file', 'ok');
    }
    return true;
}

function loadBlankTemplate() {
    sourcePath = null;
    if (els.filePath) els.filePath.value = '';
    fillFormFromProfile(BLANK_TEMPLATE);
    setStatus('Blank template — configure and launch', 'ok');
}

function switchPanel(panelId) {
    document.querySelectorAll('.nav-item').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.panel === panelId);
    });
    document.querySelectorAll('.panel').forEach((panel) => {
        const on = panel.id === `panel-${panelId}`;
        panel.classList.toggle('active', on);
        panel.hidden = !on;
    });
}

function applyRawJsonToForm() {
    void (async () => {
        const parsed = parseJsonField(els.rawJson?.value, null, 'Profile JSON');
        if (!parsed.ok) {
            setStatus(parsed.error || 'Invalid JSON', 'err');
            return;
        }
        const validated = await api().validateProfile(parsed.value);
        if (!validated.ok) {
            setStatus(validated.error || 'Invalid profile', 'err');
            return;
        }
        fillFormFromProfile(validated.profile);
        setStatus('JSON applied to form', 'ok');
    })();
}

async function submitLaunch() {
    const built = buildProfileFromForm();
    if (!built.ok) {
        setStatus(built.error || 'Fix form errors', 'err');
        return;
    }
    const validated = await api().validateProfile(built.value);
    if (!validated.ok) {
        setStatus(validated.error || 'Validation failed', 'err');
        return;
    }

    if (els.loadBtn) {
        els.loadBtn.disabled = true;
        els.loadBtn.textContent = 'Launching…';
    }
    setStatus('Applying profile (proxy → tab → navigate)…', 'warn');

    try {
        const result = await api().loadSessionProfile({
            profile: validated.profile,
            sourcePath: sourcePath || undefined,
        });
        if (!result?.success && !result?.started) {
            setStatus(result?.error || 'Launch failed', 'err');
            if (els.loadBtn) {
                els.loadBtn.disabled = false;
                els.loadBtn.textContent = 'Launch';
            }
        }
    } catch (e) {
        setStatus(e?.message || 'Launch failed', 'err');
        if (els.loadBtn) {
            els.loadBtn.disabled = false;
            els.loadBtn.textContent = 'Launch';
        }
    }
}

document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => switchPanel(btn.dataset.panel || 'general'));
});

const watchIds = [
    'pf-name', 'pf-description', 'pf-format', 'pf-recording', 'pf-url', 'pf-timeout', 'pf-new-tab',
    'pf-proxy-template', 'pf-proxy-tls', 'pf-proxy-profile-id', 'pf-proxy-vars',
    'pf-ua', 'pf-language', 'pf-timezone',
    'pf-clear-cookies', 'pf-clear-storage', 'pf-cookies',
    'pf-script', 'pf-script-delay', 'pf-script-timeout',
    'pf-storage', 'pf-persist-dns', 'pf-dns',
];
for (const id of watchIds) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('input', scheduleValidate);
    el.addEventListener('change', scheduleValidate);
}

els.browseBtn?.addEventListener('click', () => { void browseFile(); });
els.templateBtn?.addEventListener('click', loadBlankTemplate);
els.loadBtn?.addEventListener('click', () => { void submitLaunch(); });
els.cancelBtn?.addEventListener('click', () => api().closeModal());
els.applyJsonBtn?.addEventListener('click', applyRawJsonToForm);
els.refreshJsonBtn?.addEventListener('click', () => {
    refreshRawJsonFromForm();
    scheduleValidate();
});

if (!window.sessionProfileAPI) {
    setStatus('Launch Profile bridge unavailable — fully restart CupNet', 'err');
    if (els.loadBtn) els.loadBtn.disabled = true;
    if (els.browseBtn) els.browseBtn.disabled = true;
} else {
    void initModal();
}
