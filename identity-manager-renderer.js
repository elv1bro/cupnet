'use strict';

/**
 * Browser Identity window — edits settings.identity through identity:get / identity:set.
 * Live preview via identity:preview (resolved in main, same code path as the applier).
 */
const api = window.electronAPI;
const catalog = window.cupnetBrowserIdentityCatalog;

const TIMEZONES = [
    'UTC', 'Europe/London', 'Europe/Dublin', 'Europe/Lisbon', 'Europe/Madrid', 'Europe/Paris', 'Europe/Amsterdam', 'Europe/Brussels',
    'Europe/Berlin', 'Europe/Zurich', 'Europe/Vienna', 'Europe/Prague', 'Europe/Warsaw', 'Europe/Rome', 'Europe/Stockholm', 'Europe/Oslo',
    'Europe/Copenhagen', 'Europe/Helsinki', 'Europe/Athens', 'Europe/Bucharest', 'Europe/Kyiv', 'Europe/Istanbul', 'Europe/Moscow',
    'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Jakarta', 'Asia/Singapore', 'Asia/Hong_Kong',
    'Asia/Shanghai', 'Asia/Taipei', 'Asia/Manila', 'Asia/Seoul', 'Asia/Tokyo', 'Australia/Perth', 'Australia/Sydney', 'Pacific/Auckland',
    'America/Sao_Paulo', 'America/Argentina/Buenos_Aires', 'America/Santiago', 'America/Bogota', 'America/Lima', 'America/Mexico_City',
    'America/New_York', 'America/Toronto', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Vancouver',
    'America/Anchorage', 'Pacific/Honolulu', 'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi',
];
const LANGUAGES = [
    'en-US,en;q=0.9', 'en-GB,en;q=0.9', 'de-DE,de;q=0.9,en;q=0.8', 'fr-FR,fr;q=0.9,en;q=0.8', 'es-ES,es;q=0.9,en;q=0.8',
    'it-IT,it;q=0.9,en;q=0.8', 'pt-BR,pt;q=0.9,en;q=0.8', 'pt-PT,pt;q=0.9,en;q=0.8', 'nl-NL,nl;q=0.9,en;q=0.8', 'pl-PL,pl;q=0.9,en;q=0.8',
    'ru-RU,ru;q=0.9,en;q=0.8', 'uk-UA,uk;q=0.9,en;q=0.8', 'tr-TR,tr;q=0.9,en;q=0.8', 'ja-JP,ja;q=0.9,en;q=0.8', 'ko-KR,ko;q=0.9,en;q=0.8',
    'zh-CN,zh;q=0.9,en;q=0.8', 'zh-TW,zh;q=0.9,en;q=0.8', 'ar-SA,ar;q=0.9,en;q=0.8', 'hi-IN,hi;q=0.9,en;q=0.8', 'id-ID,id;q=0.9,en;q=0.8',
    'sv-SE,sv;q=0.9,en;q=0.8', 'da-DK,da;q=0.9,en;q=0.8', 'nb-NO,nb;q=0.9,en;q=0.8', 'fi-FI,fi;q=0.9,en;q=0.8', 'cs-CZ,cs;q=0.9,en;q=0.8',
];

const $ = (id) => document.getElementById(id);
const els = {
    chip: $('chip-effective'), chipText: $('chip-text'),
    bannerOverride: $('banner-override'), bannerCdp: $('banner-cdp'),
    modeSeg: $('mode-seg'), tplGrid: $('tpl-grid'), customUa: $('custom-ua-field'), ua: $('f-ua'), engineNote: $('engine-note'),
    tz: $('f-timezone'), lang: $('f-language'), followGeo: $('f-follow-geo'), geoStatus: $('geo-status'), engineHints: $('f-engine-hints'), engineHintsRow: $('engine-hints-row'),
    tls: $('f-tls'), ja3Mode: $('f-ja3-mode'), ja3Field: $('ja3-field'), ja3: $('f-ja3'), http1: $('f-http1'), adv: $('adv-tls'),
    pv: { ua: $('pv-ua'), ch: $('pv-ch'), plat: $('pv-plat'), mobile: $('pv-mobile'), lang: $('pv-lang'), navplat: $('pv-navplat'), tz: $('pv-tz'), tls: $('pv-tls') },
    status: $('status'), apply: $('btn-apply'), revert: $('btn-revert'), autoCheck: $('f-auto-check'),
};

/** @type {object|null} settings as loaded from main (for Revert / dirty check) */
let saved = null;
/** @type {object} editable form state (same shape as settings.identity) */
let form = null;
let templates = [];
let previewTimer = null;

function setStatus(text, cls = '') {
    els.status.textContent = text || '';
    els.status.className = `status ${cls}`.trim();
}

function fillDatalists() {
    $('tz-list').innerHTML = TIMEZONES.map((z) => `<option value="${z}"></option>`).join('');
    $('lang-list').innerHTML = LANGUAGES.map((l) => `<option value="${l}"></option>`).join('');
}

function renderTemplates() {
    els.tplGrid.innerHTML = '';
    for (const t of templates) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tpl-card' + (form.mode === 'template' && form.templateId === t.id ? ' on' : '');
        b.dataset.id = t.id;
        const ver = (t.userAgent.match(/(?:Edg|OPR|Chrome|Firefox|Version)\/(\d+)/) || [])[1] || '';
        const verLabel = t.id.startsWith('edge') ? (t.userAgent.match(/Edg\/(\d+)/) || [])[1]
            : t.id.startsWith('opera') ? (t.userAgent.match(/OPR\/(\d+)/) || [])[1] : ver;
        b.innerHTML = `<div class="lbl">${t.label.replace(' · ', ` ${verLabel} · `)}</div><div class="sub" title="${t.userAgent}">${t.userAgent}</div>`;
        b.addEventListener('click', () => {
            form.mode = 'template';
            form.templateId = t.id;
            form.tlsProfile = null; // follow the template
            syncForm();
        });
        els.tplGrid.appendChild(b);
    }
}

function syncForm() {
    for (const b of els.modeSeg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === form.mode);
    els.tplGrid.classList.toggle('hidden', form.mode !== 'template');
    els.customUa.classList.toggle('hidden', form.mode !== 'custom');
    els.engineNote.classList.toggle('hidden', form.mode !== 'engine');
    els.engineHintsRow?.classList.toggle('hidden', form.mode !== 'engine');
    if (els.engineHints) els.engineHints.checked = form.engineHints !== false;
    if (els.followGeo) els.followGeo.checked = form.followProxyGeo === true;
    for (const c of els.tplGrid.querySelectorAll('.tpl-card')) c.classList.toggle('on', form.mode === 'template' && c.dataset.id === form.templateId);
    if (els.ua.value !== (form.userAgent || '')) els.ua.value = form.userAgent || '';
    if (els.tz.value !== (form.timezone || '')) els.tz.value = form.timezone || '';
    if (els.lang.value !== (form.language || '')) els.lang.value = form.language || '';
    els.tls.value = form.tlsProfile || '';
    els.ja3Mode.value = form.tlsJa3Mode === 'custom' ? 'custom' : 'template';
    els.ja3Field.classList.toggle('hidden', form.tlsJa3Mode !== 'custom');
    if (els.ja3.value !== (form.tlsJa3Custom || '')) els.ja3.value = form.tlsJa3Custom || '';
    els.http1.checked = !!form.forceHttp1;
    if (form.tlsJa3Mode === 'custom' || form.forceHttp1 || form.tlsProfile) els.adv.open = true;
    const dirty = JSON.stringify(form) !== JSON.stringify(saved);
    els.apply.disabled = !dirty;
    els.revert.disabled = !dirty;
    schedulePreview();
}

function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 80);
}

function cell(el, value) {
    if (value == null || value === '') { el.textContent = '— (not sent / engine value)'; el.className = 'none'; }
    else { el.textContent = value; el.className = ''; }
}

async function renderPreview() {
    let p = null;
    try { p = await api.previewIdentity(form); } catch { p = null; }
    if (!p) p = { headers: null, tlsProfile: '', navigatorPlatform: null, timezone: form.timezone };
    const h = p.headers || {};
    cell(els.pv.ua, h['user-agent'] || null);
    cell(els.pv.ch, h['sec-ch-ua'] || null);
    cell(els.pv.plat, h['sec-ch-ua-platform'] || null);
    cell(els.pv.mobile, h['sec-ch-ua-mobile'] || null);
    cell(els.pv.lang, h['accept-language'] || (form.language || null));
    cell(els.pv.navplat, p.navigatorPlatform || null);
    cell(els.pv.tz, p.timezone || null);
    cell(els.pv.tls, `${p.tlsProfile || ''}${p.ja3 ? ' · custom JA3' : ''}${p.forceHttp1 ? ' · HTTP/1.1' : ''}`);
}

function renderStatus(st) {
    if (!st) return;
    const eff = st.effective || {};
    const src = st.source || 'global';
    els.chipText.innerHTML = `<b>${eff.description || '—'}</b>${src !== 'global' ? ' · override' : ''}`;
    els.chip.className = 'chip' + (eff.mode && eff.mode !== 'engine' ? ' active' : '') + (src !== 'global' ? ' override' : '');
    if (src === 'proxy-profile') {
        els.bannerOverride.style.display = 'block';
        els.bannerOverride.textContent = `The connected proxy profile "${st.proxyOverrideName || ''}" owns the identity (its Identity override is on). Editing here changes THIS profile\u2019s identity and re-applies it live. The global identity applies again after disconnect.`;
    } else {
        els.bannerOverride.style.display = 'none';
    }
    if (els.geoStatus) {
        const g = st.geoHint;
        if (g && st.settings?.followProxyGeo) {
            els.geoStatus.textContent = st.geoApplied
                ? `Following proxy egress: ${g.country ? g.country.toUpperCase() + ' · ' : ''}${g.timezone || '—'} · ${g.language || '—'}`
                : `Proxy egress known (${g.country ? g.country.toUpperCase() : '?'}), but the connected profile's identity override takes precedence.`;
        } else if (st.settings?.followProxyGeo) {
            els.geoStatus.textContent = 'No proxy connected — the values below apply until a proxy with a known egress country connects.';
        } else {
            els.geoStatus.textContent = '';
        }
    }
    if (st.cdpEnabled === false) {
        els.bannerCdp.style.display = 'block';
        els.bannerCdp.textContent = 'JavaScript-side emulation (navigator.userAgentData / timezone) is disabled by CUPNET_IDENTITY_CDP=0 — only the wire headers are rewritten.';
    } else {
        els.bannerCdp.style.display = 'none';
    }
}

async function load() {
    const st = await api.getIdentity();
    if (!st || !st.success) { setStatus(st?.error || 'Failed to load identity', 'err'); return; }
    templates = st.templates || catalog.listTemplates();
    saved = { ...st.settings };
    form = { ...st.settings };
    renderTemplates();
    renderStatus(st);
    syncForm();
}

/** Switch the editor mode (segment click, `#mode=custom` hash, or a command from the main process). */
function setMode(mode) {
    if (!form || !['engine', 'template', 'custom'].includes(mode)) return false;
    form.mode = mode;
    if (form.mode !== 'engine') form.tlsProfile = null;
    syncForm();
    if (mode === 'custom') { try { els.ua.focus(); els.ua.select(); } catch { /* ignore */ } }
    return true;
}

/** Mode requested by the opener (sub-windows.js loads the page with `#mode=custom`). */
function requestedModeFromHash() {
    const m = /(?:^|[#&])mode=(engine|template|custom)(?:&|$)/.exec(String(location.hash || ''));
    return m ? m[1] : null;
}

function wire() {
    els.modeSeg.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-mode]');
        if (!b) return;
        setMode(b.dataset.mode);
    });
    api.onIdentityManagerCommand?.((cmd) => { if (cmd && cmd.mode) setMode(cmd.mode); });
    els.ua.addEventListener('input', () => { form.userAgent = els.ua.value; form.tlsProfile = form.tlsProfile || null; syncForm(); });
    els.tz.addEventListener('input', () => { form.timezone = els.tz.value.trim(); syncForm(); });
    els.lang.addEventListener('input', () => { form.language = els.lang.value.trim(); syncForm(); });
    els.tls.addEventListener('change', () => { form.tlsProfile = els.tls.value || null; syncForm(); });
    els.ja3Mode.addEventListener('change', () => { form.tlsJa3Mode = els.ja3Mode.value; syncForm(); });
    els.ja3.addEventListener('input', () => { form.tlsJa3Custom = els.ja3.value.trim(); syncForm(); });
    els.http1.addEventListener('change', () => { form.forceHttp1 = els.http1.checked; syncForm(); });
    els.engineHints?.addEventListener('change', () => { form.engineHints = els.engineHints.checked; syncForm(); });
    els.followGeo?.addEventListener('change', () => { form.followProxyGeo = els.followGeo.checked; syncForm(); });

    els.revert.addEventListener('click', () => { form = { ...saved }; syncForm(); setStatus(''); });
    $('btn-verify')?.addEventListener('click', async () => {
        try { await api.openIdentityCheck?.(); } catch (e) { setStatus(e?.message || String(e), 'err'); }
    });
    els.apply.addEventListener('click', async () => {
        els.apply.disabled = true;
        setStatus('Applying…');
        try {
            const autoCheck = !!(els.autoCheck && els.autoCheck.checked);
            const res = await api.applyIdentity(form, { autoCheck });
            if (!res || !res.success) { setStatus(res?.error || 'Apply failed', 'err'); els.apply.disabled = false; return; }
            saved = { ...res.settings };
            form = { ...res.settings };
            renderStatus(res);
            syncForm();
            setStatus(`Applied to MITM and all open tabs. Reload pages to see the new navigator.* values.${autoCheck ? ' Check opened.' : ''}`, 'ok');
        } catch (e) {
            setStatus(e?.message || String(e), 'err');
            els.apply.disabled = false;
        }
    });
    document.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (!els.apply.disabled) els.apply.click(); }
        if (e.key === 'Escape') window.close();
    });
    api.onIdentityChanged?.((st) => {
        renderStatus(st);
        // Another window changed the identity, or a proxy connected/disconnected (source flip): reflect
        // the now-governing identity unless the form has unsaved edits.
        if (st?.settings && JSON.stringify(form) === JSON.stringify(saved)) {
            saved = { ...st.settings };
            form = { ...st.settings };
            syncForm();
        }
    });
}

fillDatalists();
wire();
load().then(() => { const m = requestedModeFromHash(); if (m) setMode(m); }).catch((e) => setStatus(e?.message || String(e), 'err'));
