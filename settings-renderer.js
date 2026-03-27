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

const spDevicesList = document.getElementById('sp-devices-list');
const spDevicesEmpty = document.getElementById('sp-devices-empty');
const spDevicesRefresh = document.getElementById('sp-devices-refresh');
const spCamModeGroup = document.getElementById('sp-cam-mode-group');

let activeTab = 'general';
let perfTimer = null;
let trackingSaveTimer = null;
let deviceSaveTimer = null;
let statusTimer = null;

/** @type {{ cameraMode: string, cameraPriority: string[], cameraDisabledIds: string[], cameraDisabledLabels: string[], microphoneMode: string, microphonePriority: string[] }} */
let devicePermissionsState = {
    cameraMode: 'all',
    cameraPriority: [],
    cameraDisabledIds: [],
    cameraDisabledLabels: [],
    microphoneMode: 'all',
    microphonePriority: [],
};
/** @type {Array<{ deviceId: string, label: string, kind: string }>} */
let orderedCameras = [];
let dragListIndex = null;

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
    if (name === 'devices') refreshCameraDevices();
}

function escapeHtml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/"/g, '&quot;');
}

function mergeCameraOrder(freshList, priorityIds) {
    const map = new Map(freshList.map((d) => [d.deviceId, d]));
    const out = [];
    const seen = new Set();
    for (const id of priorityIds) {
        const d = map.get(id);
        if (d) {
            out.push(d);
            seen.add(id);
        }
    }
    for (const d of freshList) {
        if (!seen.has(d.deviceId)) out.push(d);
    }
    return out;
}

function applyDevicePermissionsToForm(dp) {
    devicePermissionsState = {
        cameraMode: dp.cameraMode === 'none' || dp.cameraMode === 'custom' ? dp.cameraMode : 'all',
        cameraPriority: Array.isArray(dp.cameraPriority) ? [...dp.cameraPriority] : [],
        cameraDisabledIds: Array.isArray(dp.cameraDisabledIds) ? [...dp.cameraDisabledIds] : [],
        cameraDisabledLabels: Array.isArray(dp.cameraDisabledLabels) ? [...dp.cameraDisabledLabels] : [],
        microphoneMode: dp.microphoneMode === 'none' ? 'none' : 'all',
        microphonePriority: Array.isArray(dp.microphonePriority) ? [...dp.microphonePriority] : [],
    };
    const mode = devicePermissionsState.cameraMode;
    spCamModeGroup?.querySelectorAll('input[name="sp-cam-mode"]').forEach((el) => {
        el.checked = el.value === mode;
    });
}

function isCameraDisabledInSettings(d) {
    const ids = new Set(devicePermissionsState.cameraDisabledIds || []);
    const labels = new Set(
        (devicePermissionsState.cameraDisabledLabels || []).map((l) => String(l || '').trim().toLowerCase()).filter(Boolean),
    );
    if (ids.has(d.deviceId)) return true;
    const lab = String(d.label || '').trim().toLowerCase();
    if (lab && labels.has(lab)) return true;
    return false;
}

function renderCameraRows() {
    if (!spDevicesList) return;
    const mode = devicePermissionsState.cameraMode;
    const showCb = mode === 'custom';
    if (!orderedCameras.length) {
        spDevicesList.innerHTML = '';
        if (spDevicesEmpty) spDevicesEmpty.style.display = 'block';
        return;
    }
    if (spDevicesEmpty) spDevicesEmpty.style.display = 'none';

    spDevicesList.innerHTML = orderedCameras.map((d, i) => {
        const label = d.label || '(Unnamed camera)';
        const rowClass = showCb ? 'device-row' : 'device-row mode-all';
        const cb = showCb
            ? `<input type="checkbox" class="device-cb" data-cam-idx="${i}" ${!isCameraDisabledInSettings(d) ? 'checked' : ''}>`
            : '';
        return `<div class="${rowClass}" draggable="true" data-cam-idx="${i}">
            <span class="device-drag-handle" title="Drag to reorder">⋮⋮</span>
            <span class="device-priority-num">#${i + 1}</span>
            ${cb}
            <span class="device-label" title="${escapeHtml(d.deviceId)}">${escapeHtml(label)}</span>
        </div>`;
    }).join('');

    spDevicesList.querySelectorAll('.device-row').forEach((row) => {
        const idx = Number(row.dataset.camIdx);
        row.addEventListener('dragstart', (e) => {
            dragListIndex = idx;
            try {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(idx));
            } catch { /* ignore */ }
        });
        row.addEventListener('dragend', () => {
            dragListIndex = null;
            row.classList.remove('drag-over');
        });
        row.addEventListener('dragover', (e) => {
            e.preventDefault();
            try { e.dataTransfer.dropEffect = 'move'; } catch { /* ignore */ }
            row.classList.add('drag-over');
        });
        row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
        row.addEventListener('drop', (e) => {
            e.preventDefault();
            row.classList.remove('drag-over');
            const from = dragListIndex;
            const to = idx;
            if (from == null || Number.isNaN(from) || from === to) return;
            const item = orderedCameras.splice(from, 1)[0];
            orderedCameras.splice(to, 0, item);
            devicePermissionsState.cameraPriority = orderedCameras.map((c) => c.deviceId);
            renderCameraRows();
            wireCameraCheckboxes();
            scheduleDeviceSave();
        });
    });
}

function wireCameraCheckboxes() {
    if (!spDevicesList || devicePermissionsState.cameraMode !== 'custom') return;
    spDevicesList.querySelectorAll('.device-cb').forEach((cb) => {
        cb.addEventListener('change', () => {
            const idx = Number(cb.dataset.camIdx);
            const cam = orderedCameras[idx];
            if (!cam) return;
            const setIds = new Set(devicePermissionsState.cameraDisabledIds);
            const lab = String(cam.label || '').trim();
            let labels = [...(devicePermissionsState.cameraDisabledLabels || [])];
            if (cb.checked) {
                setIds.delete(cam.deviceId);
                if (lab) {
                    labels = labels.filter((x) => String(x || '').trim().toLowerCase() !== lab.toLowerCase());
                }
            } else {
                setIds.add(cam.deviceId);
                if (lab) labels.push(lab);
            }
            devicePermissionsState.cameraDisabledIds = [...setIds];
            devicePermissionsState.cameraDisabledLabels = [...new Set(labels.map((x) => String(x || '').trim()).filter(Boolean))];
            scheduleDeviceSave();
        });
    });
}

function syncCameraDisabledLabelsFromIds() {
    const ids = new Set(devicePermissionsState.cameraDisabledIds || []);
    const have = new Set(
        (devicePermissionsState.cameraDisabledLabels || []).map((l) => String(l || '').trim().toLowerCase()).filter(Boolean),
    );
    let added = false;
    for (const cam of orderedCameras) {
        if (!ids.has(cam.deviceId) || !cam.label) continue;
        const t = String(cam.label).trim();
        const k = t.toLowerCase();
        if (k && !have.has(k)) {
            devicePermissionsState.cameraDisabledLabels.push(t);
            have.add(k);
            added = true;
        }
    }
    if (added) scheduleDeviceSave();
}

async function refreshCameraDevices() {
    if (!api.enumerateMediaDevices) return;
    try {
        const fresh = await api.enumerateMediaDevices();
        orderedCameras = mergeCameraOrder(Array.isArray(fresh) ? fresh : [], devicePermissionsState.cameraPriority);
        devicePermissionsState.cameraPriority = orderedCameras.map((c) => c.deviceId);
        syncCameraDisabledLabelsFromIds();
        renderCameraRows();
        wireCameraCheckboxes();
    } catch {
        orderedCameras = [];
        renderCameraRows();
    }
}

function collectDevicePermissionsPayload() {
    return {
        cameraMode: devicePermissionsState.cameraMode,
        cameraPriority: [...devicePermissionsState.cameraPriority],
        cameraDisabledIds: [...(devicePermissionsState.cameraDisabledIds || [])],
        cameraDisabledLabels: [...(devicePermissionsState.cameraDisabledLabels || [])],
        microphoneMode: devicePermissionsState.microphoneMode || 'all',
        microphonePriority: [...(devicePermissionsState.microphonePriority || [])],
    };
}

function scheduleDeviceSave() {
    if (deviceSaveTimer) clearTimeout(deviceSaveTimer);
    deviceSaveTimer = setTimeout(async () => {
        deviceSaveTimer = null;
        try {
            await api.saveDevicePermissions(collectDevicePermissionsPayload());
            setStatus('Devices saved');
        } catch { /* ignore */ }
    }, 250);
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

spDevicesRefresh?.addEventListener('click', () => {
    refreshCameraDevices();
});

spCamModeGroup?.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || t.name !== 'sp-cam-mode') return;
    devicePermissionsState.cameraMode = t.value || 'all';
    scheduleDeviceSave();
    renderCameraRows();
    wireCameraCheckboxes();
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
        applyDevicePermissionsToForm(data?.devicePermissions && typeof data.devicePermissions === 'object' ? data.devicePermissions : {});
        if (activeTab === 'devices') refreshCameraDevices();
    } catch {
        setStatus('Failed to load settings');
    }
}

init();
