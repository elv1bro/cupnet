'use strict';

const api = window.electronAPI;

const tabBtns = document.querySelectorAll('.sp-tab-btn');
const tabBodies = document.querySelectorAll('.sp-tab-body');
const settingsSubtitle = document.getElementById('settings-subtitle');
const persistEl = document.getElementById('settings-persist-status');
const settingsAppVersion = document.getElementById('settings-app-version');
const settingsSidebarVersion = document.getElementById('settings-sidebar-version');
const sidebarWrap = document.getElementById('settings-sidebar-wrap');
const sidebarCollapseBtn = document.getElementById('sidebar-collapse-btn');

const spFilters = document.getElementById('sp-filter-patterns');
const spPasteUnlock = document.getElementById('sp-paste-unlock');
const spMaxTabsWarning = document.getElementById('sp-max-tabs-warning');
const spMaxTabsErr = document.getElementById('sp-max-tabs-warning-err');
const spFiltersErr = document.getElementById('sp-filter-patterns-err');

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
const spTrackPendingErr = document.getElementById('sp-track-pending-threshold-err');
const spTrackCooldownErr = document.getElementById('sp-track-cooldown-ms-err');
const spTrackMaxErr = document.getElementById('sp-track-max-per-minute-err');
const spTrackEnableAll = document.getElementById('sp-track-enable-all');
const spTrackDisableAll = document.getElementById('sp-track-disable-all');

const spPerfTbody = document.getElementById('sp-perf-tbody');
const spPerfUpdated = document.getElementById('sp-perf-updated');

const spDevicesList = document.getElementById('sp-devices-list');
const spDevicesEmpty = document.getElementById('sp-devices-empty');
const spDevicesRefresh = document.getElementById('sp-devices-refresh');
const spCamModeGroup = document.getElementById('sp-cam-mode-group');

const hubSearch = document.getElementById('settings-hub-search');
const spHomepageUrl = document.getElementById('sp-homepage-url');
const spHomepageErr = document.getElementById('sp-homepage-url-err');
const spSearchEngine = document.getElementById('sp-search-engine');
const spSearchEngineCustom = document.getElementById('sp-search-engine-custom');
const spSearchEngineCustomWrap = document.getElementById('sp-search-engine-custom-wrap');
const spOnboardingStatus = document.getElementById('sp-onboarding-status');
const spResetOnboarding = document.getElementById('sp-reset-onboarding');
const spEffectiveTraffic = document.getElementById('sp-effective-traffic');
const spActivityMonitorEnabled = document.getElementById('sp-activity-monitor-enabled');
const spActivityRate = document.getElementById('sp-activity-rate');
const spActivityRateVal = document.getElementById('sp-activity-rate-val');
const spActivityStorageStack = document.getElementById('sp-activity-storage-stack');

const spExportSettings = document.getElementById('sp-export-settings');
const spImportSettings = document.getElementById('sp-import-settings');
const spResetAllSettings = document.getElementById('sp-reset-all-settings');
const spImportFile = document.getElementById('sp-import-file');

const spUiTheme = document.getElementById('sp-ui-theme');
const spUiScale = document.getElementById('sp-ui-scale');
const spToolbarToolsPlacement = document.getElementById('sp-toolbar-tools-placement');
const spToolbarToolsMiniAlign = document.getElementById('sp-toolbar-tools-mini-align');
const spToolbarMiniAlignWrap = document.getElementById('sp-toolbar-mini-align-wrap');

let activeTab = 'general';
let perfTimer = null;
let trackingSaveTimer = null;
let deviceSaveTimer = null;
let homepageSaveTimer = null;
let searchEngineSaveTimer = null;
let filtersSaveTimer = null;
let activitySaveTimer = null;
let maxTabsSaveDebounce = null;

let saveInFlight = 0;

function setPersistState(state, detail) {
    if (!persistEl) return;
    persistEl.dataset.state = state;
    const map = {
        saved: 'All changes saved',
        saving: 'Saving…',
        unsaved: 'Unsaved changes',
        error: detail || 'Could not save',
    };
    persistEl.textContent = map[state] || detail || '';
}

function beginSave() {
    saveInFlight += 1;
    setPersistState('saving');
}

function endSave(ok, errDetail) {
    saveInFlight = Math.max(0, saveInFlight - 1);
    if (saveInFlight > 0) return;
    if (ok) setPersistState('saved');
    else setPersistState('error', errDetail || 'Save failed');
}

function markUnsaved() {
    if (persistEl && persistEl.dataset.state !== 'saving') setPersistState('unsaved');
}

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

const TAB_SUBTITLE_DEFAULT = 'Startup, behavior, appearance, network, capture, and certificate';

function switchTab(name) {
    activeTab = name;
    tabBtns.forEach((btn) => {
        const is = btn.dataset.spTab === name;
        btn.classList.toggle('active', is);
        btn.setAttribute('aria-current', is ? 'page' : 'false');
    });
    tabBodies.forEach((body) => body.classList.toggle('active', body.id === `sp-tab-${name}`));
    const btn = document.querySelector(`.sp-tab-btn[data-sp-tab="${name}"]`);
    if (settingsSubtitle && btn?.dataset?.spTitle) {
        settingsSubtitle.textContent = btn.dataset.spTitle;
    } else if (settingsSubtitle) {
        settingsSubtitle.textContent = TAB_SUBTITLE_DEFAULT;
    }
    if (name === 'performance') startPerfPoll();
    else stopPerfPoll();
    if (name === 'devices') refreshCameraDevices();
    applySettingsHubFilter();
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
    markUnsaved();
    deviceSaveTimer = setTimeout(async () => {
        deviceSaveTimer = null;
        beginSave();
        try {
            await api.saveDevicePermissions(collectDevicePermissionsPayload());
            endSave(true);
        } catch {
            endSave(false, 'Could not save devices');
        }
    }, 250);
}

tabBtns.forEach((btn) => btn.addEventListener('click', () => switchTab(btn.dataset.spTab)));

function applyTrackingSettings(cfg = {}) {
    if (spTrackClick) spTrackClick.checked = cfg.onUserClick !== false;
    if (spTrackPageLoad) spTrackPageLoad.checked = cfg.onPageLoadComplete !== false;
    if (spTrackPending) spTrackPending.checked = cfg.onNetworkPendingChange !== false;
    if (spTrackMouse) spTrackMouse.checked = !!cfg.onMouseActivity;
    if (spTrackTypingEnd) spTrackTypingEnd.checked = cfg.onTypingEnd !== false;
    if (spTrackScrollEnd) spTrackScrollEnd.checked = !!cfg.onScrollEnd;
    if (spTrackRule) spTrackRule.checked = cfg.onRuleMatchScreenshot !== false;
    if (spTrackPendingThreshold) spTrackPendingThreshold.value = Math.max(1, Math.min(50, Number(cfg.pendingDeltaThreshold) || 3));
    if (spTrackCooldownMs) spTrackCooldownMs.value = Math.max(200, Math.min(30000, Number(cfg.cooldownMs) || 2000));
    if (spTrackMaxPerMinute) spTrackMaxPerMinute.value = Math.max(1, Math.min(120, Number(cfg.maxPerMinute) || 12));
    clearFieldError(spTrackPendingThreshold, spTrackPendingErr);
    clearFieldError(spTrackCooldownMs, spTrackCooldownErr);
    clearFieldError(spTrackMaxPerMinute, spTrackMaxErr);
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

function validateTrackingLimits() {
    let ok = true;
    const pt = Number(spTrackPendingThreshold?.value);
    if (!Number.isFinite(pt) || pt < 1 || pt > 50) {
        showFieldError(spTrackPendingThreshold, spTrackPendingErr, 'Enter a number between 1 and 50');
        ok = false;
    } else clearFieldError(spTrackPendingThreshold, spTrackPendingErr);
    const cd = Number(spTrackCooldownMs?.value);
    if (!Number.isFinite(cd) || cd < 200 || cd > 30000) {
        showFieldError(spTrackCooldownMs, spTrackCooldownErr, 'Enter 200–30000 ms');
        ok = false;
    } else clearFieldError(spTrackCooldownMs, spTrackCooldownErr);
    const mx = Number(spTrackMaxPerMinute?.value);
    if (!Number.isFinite(mx) || mx < 1 || mx > 120) {
        showFieldError(spTrackMaxPerMinute, spTrackMaxErr, 'Enter 1–120');
        ok = false;
    } else clearFieldError(spTrackMaxPerMinute, spTrackMaxErr);
    return ok;
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
    if (!validateTrackingLimits()) {
        markUnsaved();
        return;
    }
    if (trackingSaveTimer) clearTimeout(trackingSaveTimer);
    markUnsaved();
    trackingSaveTimer = setTimeout(async () => {
        trackingSaveTimer = null;
        beginSave();
        try {
            await api.saveTrackingSettings(collectTrackingSettings());
            endSave(true);
        } catch (e) {
            const msg = e && e.message ? String(e.message) : 'Could not save tracking settings';
            if (typeof showToast === 'function') showToast(msg, { type: 'error' });
            endSave(false, msg);
        }
    }, 250);
}

function fmtMb(kb) {
    return (Number(kb || 0) / 1024).toFixed(1);
}

function typeClass(type) {
    if (type === 'Browser') return '#60a5fa';
    if (type === 'Renderer') return '#22c55e';
    if (type === 'GPU') return '#f59e0b';
    if (type === 'CupNet') return '#c026d3';
    return '#c084fc';
}

function renderPerfRows(metrics) {
    if (!spPerfTbody) return;
    if (!Array.isArray(metrics) || !metrics.length) {
        spPerfTbody.innerHTML = '<tr><td colspan="6" style="color:#9ca3af;text-align:center;padding:12px">No data</td></tr>';
        return;
    }
    const hasCupnet = metrics.some((m) => m.cupnet);
    const parts = [];
    let sepDone = false;
    for (const m of metrics) {
        if (m.cupnet && !sepDone && hasCupnet) {
            parts.push(
                '<tr class="sp-perf-group-row"><td colspan="6">CupNet (out-of-process helpers)</td></tr>',
            );
            sepDone = true;
        }
        const cpu = Number(m.cpuPercent || 0);
        const cpuCls = cpu > 30 ? ' style="color:#f87171;font-weight:700"' : '';
        const name = m.name ? ` (${m.name})` : '';
        parts.push(`<tr>
            <td><span style="color:${typeClass(m.type)}">${m.type}${name}</span></td>
            <td>${m.pid}</td>
            <td class="num"${cpuCls}>${cpu.toFixed(1)}%</td>
            <td class="num">${fmtMb(m.memWorkingSet)}</td>
            <td class="num">${fmtMb(m.memPrivate)}</td>
            <td>${m.sandboxed ? 'yes' : 'no'}</td>
        </tr>`);
    }
    spPerfTbody.innerHTML = parts.join('');
    if (spPerfUpdated) spPerfUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

async function fetchAndRenderPerf() {
    try {
        const metrics = await api.getAppMetrics();
        renderPerfRows(metrics);
    } catch (e) {
        if (spPerfTbody) {
            spPerfTbody.innerHTML =
                '<tr><td colspan="6" style="color:#f87171;text-align:center;padding:12px">Could not load metrics</td></tr>';
        }
        const msg = e && e.message ? String(e.message) : 'Could not load process metrics';
        if (typeof showToast === 'function') showToast(msg, { type: 'warning', duration: 2200 });
    }
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

function showFieldError(inputEl, errEl, msg) {
    if (errEl) {
        errEl.textContent = msg;
        errEl.hidden = false;
    }
    if (inputEl) inputEl.classList.add('sp-input-error');
}

function clearFieldError(inputEl, errEl) {
    if (errEl) {
        errEl.textContent = '';
        errEl.hidden = true;
    }
    if (inputEl) inputEl.classList.remove('sp-input-error');
}

function readMaxTabsBeforeWarningInput() {
    const v = Math.floor(Number(spMaxTabsWarning?.value));
    if (!Number.isFinite(v)) return null;
    return Math.max(1, Math.min(200, v));
}

function validateMaxTabs() {
    const n = readMaxTabsBeforeWarningInput();
    if (n == null) {
        showFieldError(spMaxTabsWarning, spMaxTabsErr, 'Enter a number between 1 and 200');
        return false;
    }
    clearFieldError(spMaxTabsWarning, spMaxTabsErr);
    return true;
}

async function saveMaxTabsBeforeWarning() {
    if (!api.setMaxTabsBeforeWarning) return;
    if (!validateMaxTabs()) return;
    beginSave();
    try {
        const n = readMaxTabsBeforeWarningInput();
        const res = await api.setMaxTabsBeforeWarning(n);
        if (spMaxTabsWarning && res?.maxTabsBeforeWarning != null) {
            spMaxTabsWarning.value = String(res.maxTabsBeforeWarning);
        }
        endSave(true);
    } catch (e) {
        const msg = e && e.message ? String(e.message) : 'Could not save tab limit';
        if (typeof showToast === 'function') showToast(msg, { type: 'error' });
        endSave(false, msg);
    }
}

function scheduleMaxTabsBeforeWarningSave() {
    if (maxTabsSaveDebounce) clearTimeout(maxTabsSaveDebounce);
    markUnsaved();
    maxTabsSaveDebounce = setTimeout(() => {
        maxTabsSaveDebounce = null;
        saveMaxTabsBeforeWarning();
    }, 550);
}

spPasteUnlock?.addEventListener('change', async () => {
    beginSave();
    try {
        await api.setPasteUnlock(spPasteUnlock.checked);
        endSave(true);
    } catch (e) {
        const msg = e && e.message ? String(e.message) : 'Could not save paste unlock setting';
        if (typeof showToast === 'function') showToast(msg, { type: 'error' });
        endSave(false, msg);
    }
});

spMaxTabsWarning?.addEventListener('input', () => { scheduleMaxTabsBeforeWarningSave(); });
spMaxTabsWarning?.addEventListener('change', () => { saveMaxTabsBeforeWarning(); });
spMaxTabsWarning?.addEventListener('blur', () => {
    if (maxTabsSaveDebounce) {
        clearTimeout(maxTabsSaveDebounce);
        maxTabsSaveDebounce = null;
    }
    saveMaxTabsBeforeWarning();
});
spMaxTabsWarning?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        if (maxTabsSaveDebounce) {
            clearTimeout(maxTabsSaveDebounce);
            maxTabsSaveDebounce = null;
        }
        saveMaxTabsBeforeWarning();
        spMaxTabsWarning?.blur();
    }
});

function scheduleHomepageSave() {
    if (homepageSaveTimer) clearTimeout(homepageSaveTimer);
    markUnsaved();
    homepageSaveTimer = setTimeout(async () => {
        homepageSaveTimer = null;
        if (!api.setHomepage) return;
        beginSave();
        try {
            await api.setHomepage((spHomepageUrl?.value || '').trim());
            clearFieldError(spHomepageUrl, spHomepageErr);
            endSave(true);
        } catch (e) {
            const msg = e && e.message ? String(e.message) : 'Could not save homepage';
            showFieldError(spHomepageUrl, spHomepageErr, msg);
            endSave(false, msg);
        }
    }, 500);
}

spHomepageUrl?.addEventListener('input', () => { scheduleHomepageSave(); });
spHomepageUrl?.addEventListener('blur', () => {
    if (homepageSaveTimer) {
        clearTimeout(homepageSaveTimer);
        homepageSaveTimer = null;
    }
    saveHomepageNow();
});

async function saveHomepageNow() {
    if (!api.setHomepage) return;
    beginSave();
    try {
        await api.setHomepage((spHomepageUrl?.value || '').trim());
        clearFieldError(spHomepageUrl, spHomepageErr);
        endSave(true);
    } catch (e) {
        const msg = e && e.message ? String(e.message) : 'Could not save homepage';
        showFieldError(spHomepageUrl, spHomepageErr, msg);
        endSave(false, msg);
    }
}

function syncSearchEngineCustomVisibility() {
    const c = spSearchEngine && spSearchEngine.value === 'custom';
    if (spSearchEngineCustom) spSearchEngineCustom.hidden = !c;
    if (spSearchEngineCustomWrap) spSearchEngineCustomWrap.hidden = !c;
}

function scheduleSearchEngineSave() {
    if (searchEngineSaveTimer) clearTimeout(searchEngineSaveTimer);
    markUnsaved();
    searchEngineSaveTimer = setTimeout(async () => {
        searchEngineSaveTimer = null;
        if (!api.saveSearchEngineSettings) return;
        beginSave();
        try {
            await api.saveSearchEngineSettings({
                searchEngine: spSearchEngine?.value || 'duckduckgo',
                searchEngineCustomUrl: (spSearchEngineCustom?.value || '').trim(),
            });
            endSave(true);
        } catch (e) {
            endSave(false, e && e.message ? String(e.message) : 'Search engine save failed');
        }
    }, 400);
}

spSearchEngine?.addEventListener('change', () => {
    syncSearchEngineCustomVisibility();
    scheduleSearchEngineSave();
});
spSearchEngineCustom?.addEventListener('input', () => { scheduleSearchEngineSave(); });

function scheduleFiltersSave() {
    if (filtersSaveTimer) clearTimeout(filtersSaveTimer);
    markUnsaved();
    filtersSaveTimer = setTimeout(async () => {
        filtersSaveTimer = null;
        const patterns = (spFilters?.value || '').split('\n').map((l) => l.trim()).filter(Boolean);
        beginSave();
        try {
            await api.saveFilterPatterns(patterns);
            clearFieldError(spFilters, spFiltersErr);
            endSave(true);
        } catch (e) {
            const msg = e && e.message ? String(e.message) : 'Could not save log filters';
            showFieldError(spFilters, spFiltersErr, msg);
            endSave(false, msg);
        }
    }, 600);
}

spFilters?.addEventListener('input', () => scheduleFiltersSave());
spFilters?.addEventListener('blur', () => {
    if (filtersSaveTimer) {
        clearTimeout(filtersSaveTimer);
        filtersSaveTimer = null;
    }
    saveFiltersNow();
});

async function saveFiltersNow() {
    const patterns = (spFilters?.value || '').split('\n').map((l) => l.trim()).filter(Boolean);
    beginSave();
    try {
        await api.saveFilterPatterns(patterns);
        clearFieldError(spFilters, spFiltersErr);
        endSave(true);
    } catch (e) {
        const msg = e && e.message ? String(e.message) : 'Could not save log filters';
        showFieldError(spFilters, spFiltersErr, msg);
        endSave(false, msg);
    }
}

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

const spCaDownload = document.getElementById('sp-ca-download');
const spCaCopy = document.getElementById('sp-ca-copy');

function applySettingsHubFilter() {
    const q = (hubSearch?.value || '').trim().toLowerCase();
    document.querySelectorAll('.settings-body .card').forEach((card) => {
        const tags = (card.getAttribute('data-sp-search') || '').toLowerCase();
        const titleEl = card.querySelector('.card-title');
        const title = titleEl ? titleEl.textContent : '';
        const blob = `${tags} ${title} ${card.textContent || ''}`.toLowerCase();
        const match = !q || blob.includes(q);
        card.style.display = match ? '' : 'none';
    });
}

hubSearch?.addEventListener('input', applySettingsHubFilter);

async function fetchMitmCaPem() {
    const pem = await api.getMitmCaCert?.();
    return pem && String(pem).trim() ? String(pem).trim() : '';
}

spCaDownload?.addEventListener('click', async () => {
    try {
        const pem = await fetchMitmCaPem();
        if (!pem) {
            setPersistState('error', 'Certificate unavailable');
            setTimeout(() => setPersistState('saved'), 2000);
            return;
        }
        const blob = new Blob([pem], { type: 'application/x-pem-file' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'cupnet-mitm-ca.pem';
        a.click();
        URL.revokeObjectURL(url);
        setPersistState('saved');
    } catch {
        setPersistState('error', 'Download failed');
        setTimeout(() => setPersistState('saved'), 2000);
    }
});

spCaCopy?.addEventListener('click', async () => {
    try {
        const pem = await fetchMitmCaPem();
        if (!pem) {
            setPersistState('error', 'Certificate unavailable');
            setTimeout(() => setPersistState('saved'), 2000);
            return;
        }
        await navigator.clipboard.writeText(pem);
        setPersistState('saved');
    } catch {
        setPersistState('error', 'Copy failed');
        setTimeout(() => setPersistState('saved'), 2000);
    }
});

function applyOnboardingStatusLine(data) {
    if (!spOnboardingStatus) return;
    const done = data?.onboardingComplete !== false;
    spOnboardingStatus.textContent = done
        ? 'Welcome wizard marked as completed.'
        : 'Welcome wizard not completed yet.';
}

spResetOnboarding?.addEventListener('click', async () => {
    if (!api.resetOnboardingWizard) return;
    if (!window.confirm('Reset the welcome wizard? The welcome window will open and you can complete it again.')) return;
    try {
        await api.resetOnboardingWizard();
        applyOnboardingStatusLine({ onboardingComplete: false });
        setPersistState('saved');
        if (typeof showToast === 'function') showToast('Welcome wizard opened', { type: 'success' });
    } catch (e) {
        const msg = e && e.message ? String(e.message) : 'Could not reset welcome wizard';
        if (typeof showToast === 'function') showToast(msg, { type: 'error' });
        setPersistState('error', msg);
    }
});

spActivityRate?.addEventListener('input', () => {
    if (spActivityRateVal) spActivityRateVal.textContent = String(spActivityRate.value || '');
    scheduleActivityMonitorSave();
});

function scheduleActivityMonitorSave() {
    if (activitySaveTimer) clearTimeout(activitySaveTimer);
    markUnsaved();
    activitySaveTimer = setTimeout(async () => {
        activitySaveTimer = null;
        if (!api.saveActivityMonitorSettings) return;
        beginSave();
        try {
            const rate = Math.max(50, Math.min(500, Number(spActivityRate?.value) || 100));
            await api.saveActivityMonitorSettings({
                activityMonitorEnabled: !!spActivityMonitorEnabled?.checked,
                activityMonitorRateLimit: rate,
                activityMonitorStorageStackTraces: !!spActivityStorageStack?.checked,
            });
            endSave(true);
        } catch (e) {
            const msg = e && e.message ? String(e.message) : 'Could not save Activity Monitor settings';
            if (typeof showToast === 'function') showToast(msg, { type: 'error' });
            endSave(false, msg);
        }
    }, 400);
}

spActivityMonitorEnabled?.addEventListener('change', scheduleActivityMonitorSave);
spActivityStorageStack?.addEventListener('change', scheduleActivityMonitorSave);

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

async function initShortcutsTable() {
    const tbody = document.querySelector('#sp-shortcuts-table tbody');
    if (!tbody || !window.CUPNET_KEYBOARD_SHORTCUTS) return;
    tbody.innerHTML = window.CUPNET_KEYBOARD_SHORTCUTS.map((row) => `<tr>
        <td>${escapeHtml(row.label)}</td>
        <td><code>${escapeHtml(row.keys)}</code></td>
        <td>${escapeHtml(row.scope)}</td>
    </tr>`).join('');
}

async function initSidebarCollapse() {
    let collapsed = false;
    try {
        if (api.getUiPref) collapsed = !!(await api.getUiPref('settingsSidebarCollapsed', false));
    } catch { /* ignore */ }
    if (collapsed && sidebarWrap) {
        sidebarWrap.classList.add('is-collapsed');
        if (sidebarCollapseBtn) {
            sidebarCollapseBtn.textContent = '▶';
            sidebarCollapseBtn.setAttribute('aria-expanded', 'false');
            sidebarCollapseBtn.title = 'Expand sidebar';
        }
    }
    sidebarCollapseBtn?.addEventListener('click', async () => {
        const now = sidebarWrap?.classList.toggle('is-collapsed');
        const isCollapsed = !!now;
        if (sidebarCollapseBtn) {
            sidebarCollapseBtn.textContent = isCollapsed ? '▶' : '◀';
            sidebarCollapseBtn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
            sidebarCollapseBtn.title = isCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
        }
        if (api.setUiPref) {
            try { await api.setUiPref('settingsSidebarCollapsed', isCollapsed); } catch { /* ignore */ }
        }
    });
}

async function initAppearance() {
    let theme = 'dark';
    let scale = '100';
    try {
        if (api.getUiPref) theme = (await api.getUiPref('uiTheme', 'dark')) || 'dark';
        if (api.getUiPref) scale = String((await api.getUiPref('settingsUiScale', '100')) || '100');
    } catch { /* ignore */ }
    if (spUiTheme) spUiTheme.value = ['dark', 'light', 'system'].includes(theme) ? theme : 'dark';
    if (spUiScale) spUiScale.value = ['100', '110', '125'].includes(String(scale)) ? String(scale) : '100';
    applyAppearanceToDocument();
    spUiTheme?.addEventListener('change', async () => {
        if (api.setUiPref) {
            try { await api.setUiPref('uiTheme', spUiTheme.value); } catch { /* ignore */ }
        }
        applyAppearanceToDocument();
        setPersistState('saved');
    });
    spUiScale?.addEventListener('change', async () => {
        if (api.setUiPref) {
            try { await api.setUiPref('settingsUiScale', spUiScale.value); } catch { /* ignore */ }
        }
        applyAppearanceToDocument();
        setPersistState('saved');
    });
    spToolbarToolsPlacement?.addEventListener('change', async () => {
        syncToolbarMiniAlignVisibility();
        if (!api.saveToolbarToolsPlacement) return;
        beginSave();
        try {
            const res = await api.saveToolbarToolsPlacement(spToolbarToolsPlacement.value);
            endSave(!!res?.success, res?.error);
        } catch (e) {
            endSave(false, e?.message || 'Save failed');
        }
    });
    spToolbarToolsMiniAlign?.addEventListener('change', async () => {
        if (!api.saveToolbarToolsMiniAlign) return;
        beginSave();
        try {
            const res = await api.saveToolbarToolsMiniAlign(spToolbarToolsMiniAlign.value);
            endSave(!!res?.success, res?.error);
        } catch (e) {
            endSave(false, e?.message || 'Save failed');
        }
    });
}

function syncToolbarMiniAlignVisibility() {
    const placement = spToolbarToolsPlacement?.value || 'subbar';
    const show = placement === 'subbar' || placement === 'bottom';
    if (spToolbarMiniAlignWrap) spToolbarMiniAlignWrap.hidden = !show;
}

function applyAppearanceToDocument() {
    const theme = spUiTheme?.value || 'dark';
    document.documentElement.setAttribute('data-settings-theme', theme);
    const scale = Number(spUiScale?.value) || 100;
    document.documentElement.style.fontSize = `${(scale / 100) * 16}px`;
}

spExportSettings?.addEventListener('click', async () => {
    if (!api.exportSettingsJson) return;
    try {
        const res = await api.exportSettingsJson();
        if (!res?.success || !res.json) {
            if (typeof showToast === 'function') showToast(res?.error || 'Export failed', { type: 'error' });
            return;
        }
        const blob = new Blob([res.json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `cupnet-settings-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        setPersistState('saved');
    } catch (e) {
        if (typeof showToast === 'function') showToast(String(e?.message || e), { type: 'error' });
    }
});

spImportSettings?.addEventListener('click', () => spImportFile?.click());

spImportFile?.addEventListener('change', async () => {
    const f = spImportFile.files && spImportFile.files[0];
    spImportFile.value = '';
    if (!f || !api.importSettingsJson) return;
    try {
        const text = await f.text();
        if (!window.confirm('Import settings from this file? Values will be merged into your current profile.')) return;
        const res = await api.importSettingsJson(text);
        if (!res?.success) {
            if (typeof showToast === 'function') showToast(res?.error || 'Import failed', { type: 'error' });
            return;
        }
        if (typeof showToast === 'function') showToast('Settings imported', { type: 'success' });
        window.location.reload();
    } catch (e) {
        if (typeof showToast === 'function') showToast(String(e?.message || e), { type: 'error' });
    }
});

spResetAllSettings?.addEventListener('click', async () => {
    if (!api.resetSettingsToDefaults) return;
    if (!window.confirm('Reset all settings to factory defaults? This cannot be undone. Custom lists will be cleared.')) return;
    try {
        await api.resetSettingsToDefaults();
        if (typeof showToast === 'function') showToast('Settings reset', { type: 'success' });
        window.location.reload();
    } catch (e) {
        if (typeof showToast === 'function') showToast(String(e?.message || e), { type: 'error' });
    }
});

document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        saveFiltersNow();
        saveHomepageNow();
    }
});

async function init() {
    await initSidebarCollapse();
    await initAppearance();
    initShortcutsTable();
    try {
        const v = api.getAppVersion && await api.getAppVersion();
        if (v) {
            const label = `v${v}`;
            if (settingsAppVersion) settingsAppVersion.textContent = label;
            if (settingsSidebarVersion) settingsSidebarVersion.textContent = `CupNet ${label}`;
        }
        const data = await api.getSettingsAll();
        if (spFilters) spFilters.value = (data?.filterPatterns || []).join('\n');
        if (spPasteUnlock) spPasteUnlock.checked = data?.pasteUnlock !== false;
        if (spMaxTabsWarning) {
            const m = Number(data?.maxTabsBeforeWarning);
            spMaxTabsWarning.value = String(
                Number.isFinite(m) ? Math.max(1, Math.min(200, Math.floor(m))) : 10,
            );
        }
        applyTrackingSettings(data?.tracking || {});
        applyDevicePermissionsToForm(data?.devicePermissions && typeof data.devicePermissions === 'object' ? data.devicePermissions : {});
        if (data?.effectiveTrafficMode != null && spEffectiveTraffic) {
            spEffectiveTraffic.textContent = String(data.effectiveTrafficMode);
        }
        if (api.getHomepage && spHomepageUrl) {
            try {
                const hp = await api.getHomepage();
                spHomepageUrl.value = hp != null ? String(hp) : '';
            } catch { /* ignore */ }
        }
        if (spActivityMonitorEnabled) spActivityMonitorEnabled.checked = data?.activityMonitorEnabled === true;
        if (spActivityStorageStack) spActivityStorageStack.checked = data?.activityMonitorStorageStackTraces === true;
        if (spActivityRate) {
            const r = Math.max(50, Math.min(500, Number(data?.activityMonitorRateLimit) || 100));
            spActivityRate.value = String(r);
            if (spActivityRateVal) spActivityRateVal.textContent = String(r);
        }
        if (spSearchEngine) spSearchEngine.value = data?.searchEngine || 'duckduckgo';
        if (spSearchEngineCustom) spSearchEngineCustom.value = data?.searchEngineCustomUrl || '';
        syncSearchEngineCustomVisibility();
        if (spToolbarToolsPlacement) {
            spToolbarToolsPlacement.value = data?.toolbarToolsPlacement || 'subbar';
        }
        if (spToolbarToolsMiniAlign) {
            spToolbarToolsMiniAlign.value = data?.toolbarToolsMiniAlign || 'right';
        }
        syncToolbarMiniAlignVisibility();
        applyOnboardingStatusLine(data);
        switchTab('general');
        if (activeTab === 'devices') refreshCameraDevices();
        applySettingsHubFilter();
        setPersistState('saved');
    } catch {
        setPersistState('error', 'Failed to load settings');
    }
}

init();
