'use strict';

const api = window.electronAPI;

const targetUrlInput = document.getElementById('target-url');
const proxyStatusEl = document.getElementById('proxy-status');
const tlsStatusEl = document.getElementById('tls-status');
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const openDumpBtn = document.getElementById('open-dump-btn');
const copyEndpointsBtn = document.getElementById('copy-endpoints-btn');
const endpointsSearchEl = document.getElementById('endpoints-search');
const stateEl = document.getElementById('state');
const logEl = document.getElementById('log');
const statusMsgEl = document.getElementById('status-msg');
const endpointsTbody = document.getElementById('endpoints-tbody');
const epCountEl = document.getElementById('ep-count');
const nextActionsEl = document.getElementById('next-actions');
const homeStatusEl = document.getElementById('m-home-status');
const homeSizeEl = document.getElementById('m-home-size');
const jsCountEl = document.getElementById('m-js-count');
const endpointsCountEl = document.getElementById('m-endpoints-count');
const cfEl = document.getElementById('m-cf');
const durationEl = document.getElementById('m-duration');

let ctxTimer = null;
let allEndpoints = [];

function appendLog(line) {
    const safe = (line || '').toString();
    logEl.textContent += (logEl.textContent ? '\n' : '') + safe;
    logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(msg) {
    statusMsgEl.textContent = msg;
}

function setRunning(running, stateText) {
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    stateEl.textContent = stateText || (running ? 'running...' : 'idle');
    if (running) setStatus('Scout is running...');
}

function isHttpUrl(v) {
    return /^https?:\/\//i.test((v || '').trim());
}

function classifyEndpoint(ep) {
    const s = String(ep || '').toLowerCase();
    if (s.includes('/auth') || s.includes('/signin') || s.includes('/signup') || s.includes('/login')) return 'auth';
    if (s.includes('/otp') || s.includes('verifyotp') || s.includes('phone-otp')) return 'otp';
    if (s.includes('/slot') || s.includes('/appointment') || s.includes('/reserve')) return 'booking';
    if (s.includes('/payment') || s.includes('/invoice') || s.includes('/tran_')) return 'payment';
    if (s.includes('/profile') || s.includes('/user')) return 'profile';
    if (s.startsWith('/')) return 'api-path';
    return 'other';
}

function escHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function renderEndpoints() {
    const q = (endpointsSearchEl.value || '').trim().toLowerCase();
    const list = !q ? allEndpoints : allEndpoints.filter(e => e.toLowerCase().includes(q));
    epCountEl.textContent = String(list.length);
    if (!list.length) {
        endpointsTbody.innerHTML = '<tr><td colspan="2" style="color:#64748b;padding:18px 10px">No endpoints yet</td></tr>';
        return;
    }
    endpointsTbody.innerHTML = list.map((ep) => {
        const cat = classifyEndpoint(ep);
        return `<tr><td class="endpoint-path" title="${escHtml(ep)}">${escHtml(ep)}</td><td><span class="endpoint-cat">${cat}</span></td></tr>`;
    }).join('');
}

function setNextActions(items) {
    const arr = Array.isArray(items) && items.length
        ? items
        : ['Открыть endpoints и собрать sequence запросов в Request Editor.'];
    nextActionsEl.innerHTML = arr.map(v => `<li>${escHtml(v)}</li>`).join('');
}

function fmtBytes(n) {
    const num = Number(n) || 0;
    if (num < 1024) return `${num} B`;
    if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
    return `${(num / (1024 * 1024)).toFixed(2)} MB`;
}

function clearSummary() {
    homeStatusEl.textContent = '-';
    homeStatusEl.classList.remove('warn');
    homeSizeEl.textContent = '-';
    jsCountEl.textContent = '-';
    endpointsCountEl.textContent = '-';
    cfEl.textContent = '-';
    cfEl.classList.remove('warn');
    durationEl.textContent = '-';
}

function applySummary(summary) {
    if (!summary) return;
    const hp = summary.homepage || {};
    homeStatusEl.textContent = hp.statusCode ? String(hp.statusCode) : '-';
    homeStatusEl.classList.toggle('warn', Number(hp.statusCode) >= 400);
    homeSizeEl.textContent = fmtBytes(hp.bodyLength || 0);
    jsCountEl.textContent = String((summary.jsBundles || []).length);
    endpointsCountEl.textContent = String(summary.endpointCount || 0);
    cfEl.textContent = summary.cloudflareDetected ? 'Detected' : 'No';
    cfEl.classList.toggle('warn', !!summary.cloudflareDetected);
    durationEl.textContent = `${Math.round((summary.durationMs || 0) / 1000)}s`;
    setNextActions(summary.nextActions || []);
}

async function refreshContext() {
    try {
        const ctx = await api.getIvacScoutContext();
        if (!ctx) return;
        proxyStatusEl.textContent = ctx.proxyLabel || 'Direct';
        tlsStatusEl.textContent = ctx.tlsProfile || 'chrome';
        if (isHttpUrl(ctx.url)) targetUrlInput.value = ctx.url;
    } catch {
        // ignore
    }
}

startBtn.addEventListener('click', async () => {
    await refreshContext();
    const url = (targetUrlInput.value || '').trim();
    if (!url) return;

    allEndpoints = [];
    renderEndpoints();
    clearSummary();
    setNextActions(['Ждем завершения сканирования и summary...']);
    logEl.textContent = '';
    setRunning(true, 'starting...');
    appendLog(`[ui] start: ${url}`);
    try {
        await api.runIvacScout({ url });
    } catch (e) {
        appendLog(`[ui] failed to start: ${e.message}`);
        setRunning(false, 'failed');
    }
});

stopBtn.addEventListener('click', async () => {
    try {
        await api.stopIvacScout();
        appendLog('[ui] stop requested');
    } catch (e) {
        appendLog(`[ui] stop error: ${e.message}`);
    }
});

openDumpBtn.addEventListener('click', () => {
    api.openIvacDumpFolder();
});

copyEndpointsBtn.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(allEndpoints.join('\n'));
        setStatus(`Copied ${allEndpoints.length} endpoints`);
    } catch {
        setStatus('Failed to copy endpoints');
    }
});

endpointsSearchEl.addEventListener('input', renderEndpoints);

api.onIvacScoutLog((line) => {
    appendLog(line);
    const txt = String(line || '');
    if (/^\s*\/[^\s]+/.test(txt)) {
        const ep = txt.trim();
        if (!allEndpoints.includes(ep)) {
            allEndpoints.push(ep);
            allEndpoints.sort();
            renderEndpoints();
        }
    }
});

api.onIvacScoutState((state) => {
    if (state && state.running) setRunning(true, 'running...');
    else setRunning(false, 'idle');
});

api.onIvacScoutDone((res) => {
    if (res && res.ok) {
        appendLog(`[ui] done (exit=${res.exitCode})`);
        setStatus('Scout done');
    } else if (res) {
        appendLog(`[ui] failed (exit=${res.exitCode})`);
        setStatus(`Scout failed (exit=${res.exitCode})`);
    }
    if (res && res.summary) applySummary(res.summary);
    setRunning(false, 'idle');
});

renderEndpoints();
clearSummary();
setNextActions([]);
refreshContext();
ctxTimer = setInterval(refreshContext, 1000);
window.addEventListener('beforeunload', () => {
    if (ctxTimer) clearInterval(ctxTimer);
});
