'use strict';

const api = window.breakpointAPI;
let currentId = null;

function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function utf8FromBase64(b64) {
    try {
        const clean = String(b64).replace(/\s/g, '');
        const binary = atob(clean);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return new TextDecoder('utf-8').decode(bytes);
    } catch {
        return '';
    }
}

function bodyFromSnapshot(snap) {
    if (snap.body != null && snap.body !== '') return String(snap.body);
    if (snap.bodyBase64) return utf8FromBase64(snap.bodyBase64);
    return '';
}

function fillForm(payload) {
    const snap = payload.snapshot || {};
    currentId = payload.id;
    document.getElementById('bp-title').textContent = `Breakpoint — ${esc(payload.ruleName || 'Rule')}`;
    document.getElementById('bp-meta').innerHTML =
        `Match URL: <code>${esc(payload.matchUrl || '')}</code><br>Wire URL: <code>${esc(payload.wireUrl || '')}</code>`;
    document.getElementById('bp-url').value = snap.url || '';
    document.getElementById('bp-method').value = snap.method || 'GET';
    try {
        document.getElementById('bp-headers').value = JSON.stringify(snap.headers || {}, null, 2);
    } catch {
        document.getElementById('bp-headers').value = '{}';
    }
    document.getElementById('bp-body').value = bodyFromSnapshot(snap);
}

async function doForward() {
    if (!currentId || !api) return;
    let headers = {};
    try {
        headers = JSON.parse(document.getElementById('bp-headers').value || '{}');
    } catch {
        await api.resume({ id: currentId, action: 'forward', patch: null });
        return;
    }
    const patch = {
        url: document.getElementById('bp-url').value.trim(),
        method: document.getElementById('bp-method').value.trim() || 'GET',
        headers,
        body: document.getElementById('bp-body').value,
    };
    await api.resume({ id: currentId, action: 'forward', patch });
}

async function doBlock() {
    if (!currentId || !api) return;
    await api.resume({ id: currentId, action: 'block' });
}

document.getElementById('bp-forward').addEventListener('click', () => { void doForward(); });
document.getElementById('bp-modify').addEventListener('click', () => { void doForward(); });
document.getElementById('bp-block').addEventListener('click', () => { void doBlock(); });

if (api && api.onBreakpointSet) {
    api.onBreakpointSet((payload) => {
        fillForm(payload || {});
    });
}
