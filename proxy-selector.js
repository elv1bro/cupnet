'use strict';

const api = window.electronAPI;

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const newProxyInput       = document.getElementById('new-proxy');
const savedProxiesSelect  = document.getElementById('saved-proxies');
const startBtn            = document.getElementById('start-btn');
const noProxyBtn          = document.getElementById('no-proxy-btn');
const selectLogDirBtn     = document.getElementById('select-log-dir-btn');
const logDirDisplay       = document.getElementById('log-dir-display');
const logDirFullPath      = document.getElementById('log-dir-full-path');
const openLogDirBtn       = document.getElementById('open-log-dir-btn');
const openLogViewerBtn    = document.getElementById('open-log-viewer-btn');
const urlFilterPatterns   = document.getElementById('url-filter-patterns');
const autoScreenshotCheck = document.getElementById('auto-screenshot');
const appTitle            = document.getElementById('app-title');

// Profile UI
const btnShowAddProfile   = document.getElementById('btn-show-add-profile');
const addProfileForm      = document.getElementById('add-profile-form');
const profileNameInput    = document.getElementById('profile-name-input');
const profileCountryInput = document.getElementById('profile-country-input');
const btnSaveProfile      = document.getElementById('btn-save-profile');
const btnCancelProfile    = document.getElementById('btn-cancel-profile');
const profileListEl       = document.getElementById('profile-list');

let selectedLogPath      = null;
let autoScreenshotEnabled = false;
let profiles             = [];

// ─── Log path ─────────────────────────────────────────────────────────────────
function updateLogPath(p) {
    selectedLogPath = p;
    if (p) {
        const short = p.length > 40 ? '…' + p.slice(-38) : p;
        logDirDisplay.textContent = short;
        logDirDisplay.title = p;
        if (logDirFullPath) logDirFullPath.textContent = p;
    } else {
        logDirDisplay.textContent = 'Default (application logs)';
        if (logDirFullPath) logDirFullPath.textContent = 'Default path';
    }
}

api.onSetInitialLogPath(updateLogPath);
api.onLogDirectorySelected(updateLogPath);

// ─── Recent proxies ───────────────────────────────────────────────────────────
api.onLoadProxies((proxies) => {
    for (const p of (proxies || [])) {
        const opt = document.createElement('option');
        opt.value = p; opt.textContent = p;
        savedProxiesSelect.appendChild(opt);
    }
});

savedProxiesSelect.addEventListener('change', () => {
    if (savedProxiesSelect.value) newProxyInput.value = savedProxiesSelect.value;
});

// ─── Settings ─────────────────────────────────────────────────────────────────
api.onSetFilterPatterns((patterns) => {
    urlFilterPatterns.value = (patterns || []).join('\n');
});

api.onSetAutoScreenshotState((en) => {
    autoScreenshotEnabled = en;
    autoScreenshotCheck.checked = en;
});

api.onSetAppInfo((info) => {
    appTitle.textContent = `v${info.version}`;
    document.title = info.name;
});

autoScreenshotCheck.addEventListener('change', () => {
    autoScreenshotEnabled = autoScreenshotCheck.checked;
});

// ─── Proxy profiles ───────────────────────────────────────────────────────────
api.onLoadProxyProfiles((dbProfiles) => {
    profiles = dbProfiles || [];
    renderProfiles();
});

// Also load immediately on page load
api.getProxyProfiles().then((dbProfiles) => {
    profiles = dbProfiles || [];
    renderProfiles();
}).catch(() => {});

function renderProfiles() {
    profileListEl.innerHTML = '';
    if (!profiles.length) {
        profileListEl.innerHTML = '<p style="color:#aaa;font-size:12px;text-align:center;margin:10px 0">No saved profiles</p>';
        return;
    }
    for (const p of profiles) {
        const item = document.createElement('div');
        item.className = 'profile-item';
        item.dataset.id = p.id;

        const latency = p.last_latency_ms;
        const latencyClass = !latency ? '' : latency < 500 ? 'fast' : latency < 2000 ? 'slow' : 'dead';
        const latencyText  = latency ? `${latency}ms` : '—';

        item.innerHTML = `
            <div class="profile-name">${escHtml(p.name)}</div>
            <div class="profile-meta">${escHtml(p.country || '')} ${escHtml(p.url_display || '')}</div>
            <span class="profile-latency ${latencyClass}">${latencyText}</span>
            <div class="profile-actions">
                <button class="profile-btn test" data-id="${p.id}">Test</button>
                <button class="profile-btn use"  data-id="${p.id}">Use</button>
                <button class="profile-btn del"  data-id="${p.id}">✕</button>
            </div>`;

        item.querySelector('.profile-btn.test').addEventListener('click', (e) => {
            e.stopPropagation();
            testProfile(p.id, item);
        });
        item.querySelector('.profile-btn.use').addEventListener('click', (e) => {
            e.stopPropagation();
            loadProfileUrl(p.id);
        });
        item.querySelector('.profile-btn.del').addEventListener('click', (e) => {
            e.stopPropagation();
            deleteProfile(p.id);
        });

        item.addEventListener('click', () => loadProfileUrl(p.id));
        profileListEl.appendChild(item);
    }
}

async function testProfile(id, itemEl) {
    const btn = itemEl.querySelector('.profile-btn.test');
    btn.disabled = true;
    btn.textContent = '⟳';
    const result = await api.testProxyProfile(id).catch(() => ({ success: false, error: 'IPC error' }));
    btn.disabled = false;
    btn.textContent = 'Test';
    if (result.success) {
        const latBadge = itemEl.querySelector('.profile-latency');
        const lat = result.latency;
        latBadge.textContent = `${lat}ms`;
        latBadge.className = 'profile-latency ' + (lat < 500 ? 'fast' : lat < 2000 ? 'slow' : 'dead');
        alert(`✅ Proxy works!\nIP: ${result.data.ip}\nCountry: ${result.data.country}\nLatency: ${lat}ms`);
    } else {
        alert(`❌ Proxy failed:\n${result.error}`);
    }
    // Refresh profiles list
    profiles = await api.getProxyProfiles().catch(() => profiles);
    renderProfiles();
}

async function loadProfileUrl(id) {
    const url = await api.getProxyProfileUrl(id).catch(() => null);
    if (url) {
        newProxyInput.value = url;
        newProxyInput.focus();
    } else {
        alert('Could not decrypt proxy URL. Please enter it manually.');
    }
}

async function deleteProfile(id) {
    if (!confirm('Delete this profile?')) return;
    await api.deleteProxyProfile(id).catch(() => {});
    profiles = await api.getProxyProfiles().catch(() => []);
    renderProfiles();
}

btnShowAddProfile.addEventListener('click', () => {
    addProfileForm.classList.toggle('visible');
    if (addProfileForm.classList.contains('visible')) profileNameInput.focus();
});

btnCancelProfile.addEventListener('click', () => {
    addProfileForm.classList.remove('visible');
});

btnSaveProfile.addEventListener('click', async () => {
    const name    = profileNameInput.value.trim();
    const country = profileCountryInput.value.trim();
    const url     = newProxyInput.value.trim();
    if (!name)  { alert('Profile name is required'); return; }
    if (!url)   { alert('Enter a proxy URL in the Proxy field above first'); return; }

    btnSaveProfile.disabled = true;
    btnSaveProfile.textContent = 'Saving…';
    try {
        await api.saveProxyProfile(name, url, country);
        profiles = await api.getProxyProfiles();
        renderProfiles();
        addProfileForm.classList.remove('visible');
        profileNameInput.value  = '';
        profileCountryInput.value = '';
    } catch (e) {
        alert('Failed to save profile: ' + e.message);
    } finally {
        btnSaveProfile.disabled = false;
        btnSaveProfile.textContent = 'Save';
    }
});

// ─── Misc buttons ─────────────────────────────────────────────────────────────
selectLogDirBtn.addEventListener('click', () => api.selectLogDirectory());
openLogDirBtn.addEventListener('click', () => api.openLogDirectory(selectedLogPath));
openLogViewerBtn.addEventListener('click', () => api.openLogViewer());

// ─── Apply / Launch ───────────────────────────────────────────────────────────
function getFilterPatterns() {
    return urlFilterPatterns.value.trim()
        .split('\n').map(l => l.trim()).filter(Boolean);
}

function setButtonsState(disabled, label = 'Apply With Proxy') {
    startBtn.disabled  = disabled;
    noProxyBtn.disabled = disabled;
    startBtn.textContent = disabled ? 'Testing…' : label;
}

startBtn.addEventListener('click', () => {
    const proxy = newProxyInput.value.trim() || savedProxiesSelect.value;
    if (!proxy) { alert('Please enter or select a proxy.'); return; }
    setButtonsState(true);
    api.selectProxy({
        proxy, logPath: selectedLogPath,
        filterPatterns: getFilterPatterns(),
        autoScreenshot: autoScreenshotEnabled
    }).catch(console.error).finally(() => setButtonsState(false, 'Apply With Proxy'));
});

noProxyBtn.addEventListener('click', () => {
    api.selectProxy({
        proxy: 'NONE', logPath: selectedLogPath,
        filterPatterns: getFilterPatterns(),
        autoScreenshot: autoScreenshotEnabled
    });
});

// ─── Homepage setting ─────────────────────────────────────────────────────────
const homepageInput  = document.getElementById('homepage-input');
const useNewtabBtn   = document.getElementById('use-newtab-btn');

// Load current homepage on init
api.getHomepage().then((url) => {
    if (homepageInput) homepageInput.value = url || '';
}).catch(() => {});

// Save homepage whenever the field changes (debounced)
let hpSaveTimer = null;
if (homepageInput) {
    homepageInput.addEventListener('input', () => {
        clearTimeout(hpSaveTimer);
        hpSaveTimer = setTimeout(() => {
            api.setHomepage(homepageInput.value.trim());
        }, 600);
    });
    homepageInput.addEventListener('blur', () => {
        clearTimeout(hpSaveTimer);
        api.setHomepage(homepageInput.value.trim());
    });
}

if (useNewtabBtn) {
    useNewtabBtn.addEventListener('click', () => {
        if (homepageInput) homepageInput.value = '';
        api.setHomepage('');
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
