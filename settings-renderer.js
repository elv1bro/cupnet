'use strict';

const api = window.electronAPI;

const tabBtns = document.querySelectorAll('.sp-tab-btn');
const tabBodies = document.querySelectorAll('.sp-tab-body');
const savedStatus = document.getElementById('settings-saved-status');
const settingsAppVersion = document.getElementById('settings-app-version');

const spFilters = document.getElementById('sp-filter-patterns');
const spSaveFilters = document.getElementById('sp-save-filters');
const spPasteUnlock = document.getElementById('sp-paste-unlock');
const spBypassDomains = document.getElementById('sp-bypass-domains');
const spSaveBypass = document.getElementById('sp-save-bypass');

const spTrackClick = document.getElementById('sp-track-click');
const spTrackPageLoad = document.getElementById('sp-track-page-load');
const spTrackPending = document.getElementById('sp-track-network-pending');
const spTrackMouse = document.getElementById('sp-track-mouse');
const spTrackTypingEnd = document.getElementById('sp-track-typing-end');
const spTrackScrollEnd = document.getElementById('sp-track-scroll-end');
const spTrackRule = document.getElementById('sp-track-rule');
const spTrackPendingThreshold = document.getElementById('sp-track-pending-threshold');
const spTrackCooldownMs = document.getElementById('sp-track-cooldown-ms');
const spTrackMaxPerMinute = document.getElementById('sp-track-max-per-minute');
const spTrackEnableAll = document.getElementById('sp-track-enable-all');
const spTrackDisableAll = document.getElementById('sp-track-disable-all');

const spPerfTbody = document.getElementById('sp-perf-tbody');
const spPerfUpdated = document.getElementById('sp-perf-updated');

let activeTab = 'general';
let perfTimer = null;
let trackingSaveTimer = null;
let statusTimer = null;

function setStatus(text) {
    if (!savedStatus) return;
    savedStatus.textContent = text || '';
    if (statusTimer) clearTimeout(statusTimer);
    if (text) {
        statusTimer = setTimeout(() => {
            savedStatus.textContent = '';
            statusTimer = null;
        }, 1600);
    }
}

function switchTab(name) {
    activeTab = name;
    tabBtns.forEach((btn) => btn.classList.toggle('active', btn.dataset.spTab === name));
    tabBodies.forEach((body) => body.classList.toggle('active', body.id === `sp-tab-${name}`));
    if (name === 'performance') startPerfPoll();
    else stopPerfPoll();
}

tabBtns.forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.spTab)));

function applyTrackingSettings(cfg = {}) {
    if (spTrackClick) spTrackClick.checked = cfg.onUserClick !== false;
    if (spTrackPageLoad) spTrackPageLoad.checked = cfg.onPageLoadComplete !== false;
    if (spTrackPending) spTrackPending.checked = cfg.onNetworkPendingChange !== false;
    if (spTrackMouse) spTrackMouse.checked = !!cfg.onMouseActivity;
    if (spTrackScrollEnd) spTrackScrollEnd.checked = !!cfg.onScrollEnd;
    if (spTrackRule) spTrackRule.checked = cfg.onRuleMatchScreenshot !== false;
    if (spTrackPendingThreshold) spTrackPendingThreshold.value = Math.max(1, Math.min(50, Number(cfg.pendingDeltaThreshold) || 3));
    if (spTrackCooldownMs) spTrackCooldownMs.value = Math.max(200, Math.min(30000, Number(cfg.cooldownMs) || 2000));
    if (spTrackMaxPerMinute) spTrackMaxPerMinute.value = Math.max(1, Math.min(120, Number(cfg.maxPerMinute) || 12));
}

function collectTrackingSettings() {
    return {
        onUserClick: spTrackClick?.checked !== false,
        onPageLoadComplete: spTrackPageLoad?.checked !== false,
        onNetworkPendingChange: spTrackPending?.checked !== false,
        onMouseActivity: !!spTrackMouse?.checked,
        onTypingEnd: spTrackTypingEnd?.checked !== false,
        onScrollEnd: !!spTrackScrollEnd?.checked,
        onRuleMatchScreenshot: spTrackRule?.checked !== false,
        pendingDeltaThreshold: Math.max(1, Math.min(50, Number(spTrackPendingThreshold?.value) || 3)),
        cooldownMs: Math.max(200, Math.min(30000, Number(spTrackCooldownMs?.value) || 2000)),
        maxPerMinute: Math.max(1, Math.min(120, Number(spTrackMaxPerMinute?.value) || 12)),
    };
}

function setAllTracking(enabled) {
    const v = !!enabled;
    if (spTrackClick) spTrackClick.checked = v;
    if (spTrackPageLoad) spTrackPageLoad.checked = v;
    if (spTrackPending) spTrackPending.checked = v;
    if (spTrackMouse) spTrackMouse.checked = v;
    if (spTrackTypingEnd) spTrackTypingEnd.checked = v;
    if (spTrackScrollEnd) spTrackScrollEnd.checked = v;
    if (spTrackRule) spTrackRule.checked = v;
}

function scheduleTrackingSave() {
    if (trackingSaveTimer) clearTimeout(trackingSaveTimer);
    trackingSaveTimer = setTimeout(async () => {
        trackingSaveTimer = null;
        try {
            await api.saveTrackingSettings(collectTrackingSettings());
            setStatus('Tracking saved');
        } catch {}
    }, 250);
}

function fmtMb(kb) {
    return (Number(kb || 0) / 1024).toFixed(1);
}

function typeClass(type) {
    if (type === 'Browser') return '#60a5fa';
    if (type === 'Renderer') return '#22c55e';
    if (type === 'GPU') return '#f59e0b';
    return '#c084fc';
}

function renderPerfRows(metrics) {
    if (!spPerfTbody) return;
    if (!Array.isArray(metrics) || !metrics.length) {
        spPerfTbody.innerHTML = '<tr><td colspan="6" style="color:#9ca3af;text-align:center;padding:12px">No data</td></tr>';
        return;
    }
    spPerfTbody.innerHTML = metrics.map((m) => {
        const cpu = Number(m.cpuPercent || 0);
        const cpuCls = cpu > 30 ? ' style="color:#f87171;font-weight:700"' : '';
        const name = m.name ? ` (${m.name})` : '';
        return `<tr>
            <td><span style="color:${typeClass(m.type)}">${m.type}${name}</span></td>
            <td>${m.pid}</td>
            <td class="num"${cpuCls}>${cpu.toFixed(1)}%</td>
            <td class="num">${fmtMb(m.memWorkingSet)}</td>
            <td class="num">${fmtMb(m.memPrivate)}</td>
            <td>${m.sandboxed ? 'yes' : 'no'}</td>
        </tr>`;
    }).join('');
    if (spPerfUpdated) spPerfUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

async function fetchAndRenderPerf() {
    try {
        const metrics = await api.getAppMetrics();
        renderPerfRows(metrics);
    } catch {}
}

function startPerfPoll() {
    stopPerfPoll();
    fetchAndRenderPerf();
    perfTimer = setInterval(fetchAndRenderPerf, 3000);
}

function stopPerfPoll() {
    if (perfTimer) {
        clearInterval(perfTimer);
        perfTimer = null;
    }
}

spPasteUnlock?.addEventListener('change', async () => {
    try {
        await api.setPasteUnlock(spPasteUnlock.checked);
        setStatus('Saved');
    } catch {}
});

spSaveFilters?.addEventListener('click', async () => {
    const patterns = (spFilters?.value || '').split('\n').map((l) => l.trim()).filter(Boolean);
    try {
        await api.saveFilterPatterns(patterns);
        setStatus('Filters saved');
    } catch {}
});

spSaveBypass?.addEventListener('click', async () => {
    const domains = (spBypassDomains?.value || '').split('\n').map((l) => l.trim()).filter(Boolean);
    try {
        await api.saveBypassDomains(domains);
        setStatus('Bypass saved');
    } catch {}
});

[
    spTrackClick, spTrackPageLoad, spTrackPending, spTrackMouse, spTrackTypingEnd, spTrackScrollEnd, spTrackRule,
    spTrackPendingThreshold, spTrackCooldownMs, spTrackMaxPerMinute,
].forEach((el) => el?.addEventListener('change', scheduleTrackingSave));

spTrackEnableAll?.addEventListener('click', () => {
    setAllTracking(true);
    scheduleTrackingSave();
});

spTrackDisableAll?.addEventListener('click', () => {
    setAllTracking(false);
    scheduleTrackingSave();
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopPerfPoll();
    else if (activeTab === 'performance') startPerfPoll();
});

async function init() {
    try {
        const v = await api.getAppVersion?.();
        if (settingsAppVersion && v) settingsAppVersion.textContent = `v${v}`;
        const data = await api.getSettingsAll();
        if (spFilters) spFilters.value = (data?.filterPatterns || []).join('\n');
        if (spBypassDomains) spBypassDomains.value = (data?.bypassDomains || []).join('\n');
        if (spPasteUnlock) spPasteUnlock.checked = data?.pasteUnlock !== false;
        applyTrackingSettings(data?.tracking || {});
    } catch {
        setStatus('Failed to load settings');
    }
}

init();
