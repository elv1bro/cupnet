function cupnetPageHttpLab(options) {
    'use strict';

    options = options || {};
    const VERSION = '1.0';
    const LS_KEY = 'cupnet_http_lab_v1';
    const LS_HISTORY_KEY = 'cupnet_http_lab_history_v1';
    const HISTORY_MAX = 12;
    const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
    const BODY_MODES = [
        { id: 'none', label: 'none (no body)' },
        { id: 'urlencoded', label: 'form (application/x-www-form-urlencoded)' },
        { id: 'multipart', label: 'multipart/form-data' },
        { id: 'json', label: 'JSON (application/json)' },
        { id: 'raw', label: 'raw text' },
    ];

    document.getElementById('cupnet-http-lab')?.remove();
    document.getElementById('cupnet-http-log')?.remove();
    document.getElementById('cupnet-http-toast')?.remove();
    document.getElementById('cupnet-http-bubble')?.remove();

    const LS_UI_KEY = 'cupnet_http_lab_ui_v1';
    const BUBBLE_SIZE = 44;
    const BUBBLE_MARGIN = 12;

    let bubbleRoot = null;
    let uiMinimized = false;

    const CONFIG = {
        url: location.pathname + location.search,
        method: 'GET',
        referer: location.href,
        bodyMode: 'none',
        query: [],
        headers: [
            { name: 'Accept', value: '*/*', enabled: true },
            { name: 'X-Requested-With', value: 'XMLHttpRequest', enabled: true },
        ],
        fields: [],
        files: [],
        rawBody: '',
        jpegConvert: true,
    };

    let lastResponse = null;
    let panelRoot = null;
    let logPanelRoot = null;
    let logEntries = [];
    let logAutoScroll = true;
    let logWidth = 420;
    const LOG_BODY_MAX = 80000;

    function loadUiState() {
        try {
            const raw = localStorage.getItem(LS_UI_KEY);
            if (!raw) return { active: false, minimized: false };
            const j = JSON.parse(raw);
            return {
                active: j.active === true,
                minimized: j.minimized === true,
                bubbleX: typeof j.bubbleX === 'number' ? j.bubbleX : null,
                bubbleY: typeof j.bubbleY === 'number' ? j.bubbleY : null,
            };
        } catch (_) {
            return { active: false, minimized: false };
        }
    }

    function defaultBubblePos() {
        return {
            x: Math.max(BUBBLE_MARGIN, window.innerWidth - BUBBLE_SIZE - BUBBLE_MARGIN),
            y: Math.max(BUBBLE_MARGIN, window.innerHeight - BUBBLE_SIZE - BUBBLE_MARGIN),
        };
    }

    function clampBubblePos(x, y) {
        const maxX = Math.max(BUBBLE_MARGIN, window.innerWidth - BUBBLE_SIZE - BUBBLE_MARGIN);
        const maxY = Math.max(BUBBLE_MARGIN, window.innerHeight - BUBBLE_SIZE - BUBBLE_MARGIN);
        return {
            x: Math.max(BUBBLE_MARGIN, Math.min(maxX, x)),
            y: Math.max(BUBBLE_MARGIN, Math.min(maxY, y)),
        };
    }

    function getBubblePos() {
        if (!bubbleRoot) return defaultBubblePos();
        const rect = bubbleRoot.getBoundingClientRect();
        return clampBubblePos(rect.left, rect.top);
    }

    function reportUiState(patch) {
        const prev = loadUiState();
        const pos = bubbleRoot && !bubbleRoot.hidden ? getBubblePos() : {
            x: prev.bubbleX ?? defaultBubblePos().x,
            y: prev.bubbleY ?? defaultBubblePos().y,
        };
        const state = {
            active: patch.active != null ? patch.active : prev.active,
            minimized: patch.minimized != null ? patch.minimized : prev.minimized,
            bubbleX: pos.x,
            bubbleY: pos.y,
        };
        try { localStorage.setItem(LS_UI_KEY, JSON.stringify(state)); } catch (_) { /* ignore */ }
        try { window.electronAPI?.reportHttpLabUiState?.(state); } catch (_) { /* ignore */ }
        return state;
    }

    function dismissLab() {
        if (panelRoot?._keyHandler) document.removeEventListener('keydown', panelRoot._keyHandler);
        panelRoot?.remove();
        bubbleRoot?.remove();
        panelRoot = null;
        bubbleRoot = null;
        uiMinimized = false;
        reportUiState({ active: false, minimized: false });
    }

    function ensureBubble(x, y) {
        if (bubbleRoot && document.getElementById('cupnet-http-bubble')) return bubbleRoot;
        const pos = clampBubblePos(
            typeof x === 'number' ? x : (loadUiState().bubbleX ?? defaultBubblePos().x),
            typeof y === 'number' ? y : (loadUiState().bubbleY ?? defaultBubblePos().y),
        );
        const el = document.createElement('div');
        el.id = 'cupnet-http-bubble';
        el.title = 'CupNet HTTP Lab · drag to move · click to open · × to close';
        el.innerHTML = '<style>#cupnet-http-bubble{position:fixed;z-index:2147483647;width:' + BUBBLE_SIZE + 'px;height:' + BUBBLE_SIZE + 'px;border-radius:50%;background:linear-gradient(145deg,#388bfd,#1f6feb);border:2px solid #58a6ff;color:#fff;display:flex;align-items:center;justify-content:center;font:700 11px/1 ui-monospace,system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.45);cursor:grab;user-select:none;touch-action:none}#cupnet-http-bubble:active{cursor:grabbing}#cupnet-http-bubble .cn-bubble-label{pointer-events:none;letter-spacing:-0.03em}#cupnet-http-bubble .cn-bubble-close{position:absolute;top:-4px;right:-4px;width:16px;height:16px;border-radius:50%;border:none;background:#da3633;color:#fff;font-size:10px;line-height:16px;padding:0;cursor:pointer;display:none;box-shadow:0 2px 6px rgba(0,0,0,.35)}#cupnet-http-bubble:hover .cn-bubble-close{display:block}#cupnet-http-bubble[hidden]{display:none!important}</style><span class="cn-bubble-label">HTTP</span><button type="button" class="cn-bubble-close" title="Close">×</button>';
        el.style.left = pos.x + 'px';
        el.style.top = pos.y + 'px';
        document.body.appendChild(el);
        bubbleRoot = el;

        let drag = null;
        let moved = false;
        el.querySelector('.cn-bubble-close').addEventListener('click', function (e) {
            e.stopPropagation();
            dismissLab();
        });
        el.addEventListener('mousedown', function (e) {
            if (e.button !== 0 || e.target.closest('.cn-bubble-close')) return;
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            drag = { x: e.clientX, y: e.clientY, l: rect.left, t: rect.top };
            moved = false;
        });
        document.addEventListener('mousemove', function (e) {
            if (!drag) return;
            const dx = e.clientX - drag.x;
            const dy = e.clientY - drag.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
            const p = clampBubblePos(drag.l + dx, drag.t + dy);
            el.style.left = p.x + 'px';
            el.style.top = p.y + 'px';
        });
        document.addEventListener('mouseup', function () {
            if (!drag) return;
            drag = null;
            reportUiState({ active: true, minimized: true });
            if (!moved) expandPanel();
        });
        window.addEventListener('resize', function () {
            if (!bubbleRoot || bubbleRoot.hidden) return;
            const p = getBubblePos();
            bubbleRoot.style.left = p.x + 'px';
            bubbleRoot.style.top = p.y + 'px';
        });
        return el;
    }

    function minimizeToBubble() {
        if (panelRoot) {
            try { readUiState(panelRoot); } catch (_) { /* ignore */ }
            panelRoot.hidden = true;
        }
        ensureBubble();
        bubbleRoot.hidden = false;
        uiMinimized = true;
        reportUiState({ active: true, minimized: true });
    }

    function expandPanel() {
        if (!panelRoot || !document.getElementById('cupnet-http-lab')) {
            mountPanel();
        } else {
            panelRoot.hidden = false;
        }
        if (bubbleRoot) bubbleRoot.hidden = true;
        uiMinimized = false;
        reportUiState({ active: true, minimized: false });
    }

    function toast(msg, ms) {
        ms = ms || 2200;
        let el = document.getElementById('cupnet-http-toast');
        if (!el) {
            el = document.createElement('div');
            el.id = 'cupnet-http-toast';
            el.style.cssText = 'position:fixed;z-index:2147483647;bottom:16px;left:50%;transform:translateX(-50%);background:#238636;color:#fff;padding:8px 14px;border-radius:8px;font:12px system-ui;box-shadow:0 8px 24px rgba(0,0,0,.4);max-width:90vw';
            document.body.appendChild(el);
        }
        el.textContent = msg;
        el.hidden = false;
        clearTimeout(el._t);
        el._t = setTimeout(function () { el.hidden = true; }, ms);
    }

    function esc(s) {
        return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    function methodHasBody(method) {
        return !['GET', 'HEAD'].includes(String(method || 'GET').toUpperCase());
    }

    function readFormElement(form) {
        const out = { action: form.action || '', method: (form.method || 'GET').toUpperCase(), fields: {} };
        form.querySelectorAll('input, textarea, select').forEach(function (n) {
            if (!n.name || n.type === 'submit' || n.type === 'button' || n.type === 'file') return;
            if (n.type === 'checkbox' || n.type === 'radio') {
                if (n.checked) out.fields[n.name] = n.value;
                return;
            }
            if (n.tagName === 'SELECT') {
                out.fields[n.name] = n.value;
                return;
            }
            out.fields[n.name] = n.value;
        });
        return out;
    }

    function readPageForms() {
        const forms = Array.from(document.querySelectorAll('form'));
        const parsed = forms.map(readFormElement);
        let primary = parsed[0] || { action: '', method: 'GET', fields: {} };
        if (options.clickX != null && options.clickY != null) {
            const hit = document.elementFromPoint(options.clickX, options.clickY);
            const f = hit && hit.closest ? hit.closest('form') : null;
            if (f) {
                primary = readFormElement(f);
                primary._selector = f.id ? '#' + f.id : 'form';
            }
        }
        const fields = Object.assign({}, primary.fields);
        document.querySelectorAll('input[name="__RequestVerificationToken"], input[name="_token"], input[name="csrf_token"], input[name="authenticity_token"]').forEach(function (inp) {
            if (inp.name && inp.value && fields[inp.name] == null) fields[inp.name] = inp.value;
        });
        return {
            forms: parsed,
            primary: primary,
            fields: fields,
            formSelector: primary._selector || '',
        };
    }

    function objToRows(obj) {
        return Object.entries(obj || {}).map(function (pair) {
            return { name: pair[0], value: String(pair[1] ?? ''), enabled: true };
        });
    }

    function mergePageIntoConfig(scope) {
        const page = readPageForms();
        const src = scope === 'primary' ? page.primary : page;
        if (src && src.action) {
            try {
                const u = new URL(src.action, location.origin);
                CONFIG.url = u.pathname + u.search;
                CONFIG.method = src.method || CONFIG.method;
                if (src.method && methodHasBody(src.method)) {
                    CONFIG.bodyMode = CONFIG.bodyMode === 'none' ? 'urlencoded' : CONFIG.bodyMode;
                }
            } catch (_) { /* keep url */ }
        }
        const map = new Map(CONFIG.fields.map(function (r) { return [r.name, r]; }));
        Object.entries(page.fields).forEach(function (pair) {
            const name = pair[0];
            const value = pair[1];
            if (value == null || value === '') return;
            if (map.has(name)) {
                map.get(name).value = value;
                map.get(name).enabled = true;
            } else {
                map.set(name, { name: name, value: value, enabled: true });
            }
        });
        CONFIG.fields = Array.from(map.values());
        if (!CONFIG.referer) CONFIG.referer = location.href;
        return page;
    }

    function getFieldValue(name) {
        const row = CONFIG.fields.find(function (r) { return r.name === name; });
        return row ? row.value : '';
    }

    function setHeaderValue(name, value) {
        let row = CONFIG.headers.find(function (r) { return r.name === name; });
        if (!row) {
            row = { name: name, value: '', enabled: true };
            CONFIG.headers.push(row);
        }
        row.value = value;
        row.enabled = true;
    }

    function exportConfig() {
        return {
            url: CONFIG.url,
            method: CONFIG.method,
            referer: CONFIG.referer,
            bodyMode: CONFIG.bodyMode,
            query: CONFIG.query,
            headers: CONFIG.headers,
            fields: CONFIG.fields,
            files: CONFIG.files,
            rawBody: CONFIG.rawBody,
            jpegConvert: CONFIG.jpegConvert,
        };
    }

    function saveLs() {
        try { localStorage.setItem(LS_KEY, JSON.stringify(exportConfig())); } catch (_) { /* ignore */ }
    }

    function loadLs() {
        try {
            const raw = localStorage.getItem(LS_KEY);
            if (!raw) return;
            const j = JSON.parse(raw);
            if (j.url) CONFIG.url = j.url;
            if (j.method) CONFIG.method = j.method;
            if (j.referer != null) CONFIG.referer = j.referer;
            if (j.bodyMode) CONFIG.bodyMode = j.bodyMode;
            if (Array.isArray(j.query)) CONFIG.query = j.query;
            if (Array.isArray(j.headers)) CONFIG.headers = j.headers;
            if (Array.isArray(j.fields)) CONFIG.fields = j.fields;
            if (Array.isArray(j.files)) CONFIG.files = j.files;
            if (j.rawBody != null) CONFIG.rawBody = j.rawBody;
            if (j.jpegConvert != null) CONFIG.jpegConvert = j.jpegConvert;
        } catch (_) { /* ignore */ }
    }

    function logAppend(type, title, body) {
        ensureLogPanel();
        logEntries.push({ ts: Date.now(), type: type, title: String(title || ''), body: String(body || '') });
        if (logEntries.length > 120) logEntries.splice(0, logEntries.length - 120);
        renderLogStream();
    }

    function tsFmt(ts) {
        return new Date(ts || Date.now()).toLocaleTimeString(undefined, { hour12: false });
    }

    function formatLogEntry(e) {
        const head = '[' + tsFmt(e.ts) + '] ' + String(e.type || '').toUpperCase() + ' · ' + e.title;
        const body = e.body.length > LOG_BODY_MAX
            ? e.body.slice(0, LOG_BODY_MAX) + '\n… truncated'
            : e.body;
        return head + '\n' + '─'.repeat(Math.min(50, head.length)) + '\n' + body;
    }

    function renderLogStream() {
        if (!logPanelRoot) return;
        const stream = logPanelRoot.querySelector('#cupnet-log-stream');
        if (!stream) return;
        stream.textContent = logEntries.length
            ? logEntries.map(formatLogEntry).join('\n\n')
            : '(empty — send a request to see traffic here)';
        if (logAutoScroll) stream.scrollTop = stream.scrollHeight;
    }

    function ensureLogPanel() {
        if (logPanelRoot && document.getElementById('cupnet-http-log')) return logPanelRoot;
        try {
            const w = parseInt(localStorage.getItem('cupnet_log_width') || '', 10);
            if (w >= 280 && w <= 900) logWidth = w;
            logAutoScroll = localStorage.getItem('cupnet_log_autoscroll') !== '0';
        } catch (_) { /* ignore */ }

        const el = document.createElement('div');
        el.id = 'cupnet-http-log';
        el.innerHTML = '<style>#cupnet-http-log{position:fixed;z-index:2147483645;left:0;top:0;bottom:0;width:var(--cupnet-log-w,420px);max-width:55vw;display:flex;flex-direction:column;background:#0a0e13;color:#e6edf3;border-right:2px solid #388bfd;font:11px/1.4 ui-monospace,Menlo,system-ui,sans-serif;box-shadow:4px 0 24px rgba(0,0,0,.35)}#cupnet-http-log[hidden]{display:none!important}#cupnet-http-log .log-hd{padding:8px 10px;background:#161b22;border-bottom:1px solid #30363d;display:flex;align-items:center;justify-content:space-between}#cupnet-http-log .log-tools{display:flex;flex-wrap:wrap;gap:4px;padding:6px 8px;background:#0d1117;border-bottom:1px solid #21262d}#cupnet-http-log .log-tools button,#cupnet-http-log .log-tools select{font:inherit;font-size:10px;padding:3px 6px;background:#21262d;color:#c9d1d9;border:none;border-radius:4px;cursor:pointer}#cupnet-http-log #cupnet-log-stream{flex:1;margin:0;padding:8px;overflow:auto;font-size:10px;line-height:1.45;background:#010409;white-space:pre-wrap;word-break:break-word;border:none}#cupnet-http-log .log-resize{position:absolute;right:0;top:0;bottom:0;width:6px;cursor:ew-resize}</style><div class="log-hd"><b>CupNet Log</b><button type="button" id="cupnet-log-hide">◀</button></div><div class="log-tools"><button type="button" id="cupnet-log-copy">Copy</button><button type="button" id="cupnet-log-clear">Clear</button><label style="display:flex;align-items:center;gap:3px;color:#8b949e;font-size:10px"><input type="checkbox" id="cupnet-log-autoscroll"' + (logAutoScroll ? ' checked' : '') + '> auto-scroll</label></div><div id="cupnet-log-stream"></div><div class="log-resize" id="cupnet-log-resize"></div>';
        document.body.appendChild(el);
        el.style.setProperty('--cupnet-log-w', logWidth + 'px');
        logPanelRoot = el;
        el.querySelector('#cupnet-log-clear').onclick = function () { logEntries = []; renderLogStream(); };
        el.querySelector('#cupnet-log-copy').onclick = function () {
            navigator.clipboard.writeText(logEntries.map(formatLogEntry).join('\n\n')).then(function () { toast('Log copied'); }).catch(function () { toast('Copy failed'); });
        };
        el.querySelector('#cupnet-log-autoscroll').onchange = function (e) {
            logAutoScroll = e.target.checked;
            try { localStorage.setItem('cupnet_log_autoscroll', logAutoScroll ? '1' : '0'); } catch (_) { /* ignore */ }
        };
        el.querySelector('#cupnet-log-hide').onclick = function () { el.hidden = true; };
        let resizing = null;
        el.querySelector('#cupnet-log-resize').addEventListener('mousedown', function (e) {
            e.preventDefault();
            resizing = { x: e.clientX, w: el.offsetWidth };
        });
        document.addEventListener('mousemove', function (e) {
            if (!resizing) return;
            logWidth = Math.max(280, Math.min(900, resizing.w + e.clientX - resizing.x));
            el.style.setProperty('--cupnet-log-w', logWidth + 'px');
        });
        document.addEventListener('mouseup', function () {
            if (!resizing) return;
            resizing = null;
            try { localStorage.setItem('cupnet_log_width', String(logWidth)); } catch (_) { /* ignore */ }
        });
        renderLogStream();
        return el;
    }

    function showLogPanel() {
        ensureLogPanel();
        logPanelRoot.hidden = false;
        renderLogStream();
    }

    function kvRowHtml(row, multiline) {
        const val = row?.value ?? '';
        const valInput = multiline
            ? '<textarea class="cn-kv-val" rows="2">' + esc(val) + '</textarea>'
            : '<input type="text" class="cn-kv-val" value="' + esc(val) + '">';
        return '<div class="cn-kv-row"><input type="checkbox" class="cn-kv-en"' + (row?.enabled !== false ? ' checked' : '') + '><input type="text" class="cn-kv-name" placeholder="name" value="' + esc(row?.name ?? '') + '">' + valInput + '<button type="button" class="cn-kv-rm">×</button></div>';
    }

    function renderKvList(rows) {
        return (rows?.length ? rows : [{ name: '', value: '', enabled: true }]).map(function (r) { return kvRowHtml(r, false); }).join('');
    }

    function readKvRows(root, listId) {
        const rows = [];
        root.querySelectorAll('#' + listId + ' .cn-kv-row').forEach(function (row) {
            rows.push({
                enabled: row.querySelector('.cn-kv-en')?.checked !== false,
                name: row.querySelector('.cn-kv-name')?.value ?? '',
                value: row.querySelector('.cn-kv-val')?.value ?? '',
            });
        });
        return rows;
    }

    function readFileRows(root) {
        const rows = [];
        root.querySelectorAll('#cn-file-list .cn-file-row').forEach(function (row, i) {
            rows.push({
                enabled: row.querySelector('.cn-file-en')?.checked !== false,
                name: row.querySelector('.cn-file-name')?.value ?? '',
                filename: row.querySelector('.cn-file-fn')?.value ?? 'blob',
                _input: row.querySelector('.cn-file-input'),
                _idx: i,
            });
        });
        return rows;
    }

    function readUiState(root) {
        CONFIG.url = root.querySelector('#cn-url')?.value.trim() || '';
        CONFIG.referer = root.querySelector('#cn-referer')?.value.trim() || '';
        CONFIG.method = (root.querySelector('#cn-method')?.value || 'GET').toUpperCase();
        CONFIG.bodyMode = root.querySelector('#cn-body-mode')?.value || 'none';
        CONFIG.query = readKvRows(root, 'cn-query-list');
        CONFIG.headers = readKvRows(root, 'cn-header-list');
        CONFIG.fields = readKvRows(root, 'cn-field-list');
        CONFIG.files = readFileRows(root).map(function (r) { const c = Object.assign({}, r); delete c._input; delete c._idx; return c; });
        CONFIG.rawBody = root.querySelector('#cn-raw-body')?.value ?? '';
        saveLs();
    }

    function buildUrl(base, queryRows) {
        const abs = base.startsWith('http') ? base : new URL(base, location.origin).href;
        const u = new URL(abs);
        (queryRows || []).forEach(function (r) {
            if (r.enabled === false) return;
            const n = String(r.name ?? '').trim();
            if (!n) return;
            u.searchParams.set(n, r.value ?? '');
        });
        return u.href;
    }

    function buildHeaders(headerRows, bodyMode) {
        const h = {};
        (headerRows || []).forEach(function (r) {
            if (r.enabled === false) return;
            const n = String(r.name ?? '').trim();
            if (!n) return;
            h[n] = r.value ?? '';
        });
        if (!h.Accept) h.Accept = '*/*';
        if (bodyMode === 'json' && !Object.keys(h).some(function (k) { return k.toLowerCase() === 'content-type'; })) {
            h['Content-Type'] = 'application/json;charset=UTF-8';
        }
        if (bodyMode === 'urlencoded' && !Object.keys(h).some(function (k) { return k.toLowerCase() === 'content-type'; })) {
            h['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
        }
        return h;
    }

    async function buildBody(root, bodyMode, fieldRows, fileRows) {
        if (bodyMode === 'none') return { body: undefined, preview: '(no body)' };
        const textFields = (fieldRows || []).filter(function (r) { return r.enabled !== false && String(r.name ?? '').trim(); });
        if (bodyMode === 'urlencoded') {
            const params = new URLSearchParams();
            textFields.forEach(function (r) { params.append(r.name.trim(), r.value ?? ''); });
            const body = params.toString();
            return { body: body, preview: body.slice(0, 800) };
        }
        if (bodyMode === 'json') {
            const raw = root.querySelector('#cn-raw-body')?.value ?? CONFIG.rawBody;
            if (raw.trim()) return { body: raw, preview: raw.slice(0, 800) };
            const obj = {};
            textFields.forEach(function (r) { obj[r.name.trim()] = r.value ?? ''; });
            const body = JSON.stringify(obj);
            return { body: body, preview: body.slice(0, 800) };
        }
        if (bodyMode === 'raw') {
            const body = root.querySelector('#cn-raw-body')?.value ?? CONFIG.rawBody ?? '';
            return { body: body, preview: body.slice(0, 800) };
        }
        if (bodyMode === 'multipart') {
            const fd = new FormData();
            textFields.forEach(function (r) {
                const v = r.value ?? '';
                if (v !== '') fd.append(r.name.trim(), v);
            });
            const fileRowEls = root.querySelectorAll('#cn-file-list .cn-file-row');
            for (let i = 0; i < fileRowEls.length; i++) {
                const rowEl = fileRowEls[i];
                const meta = fileRows[i];
                if (!meta || meta.enabled === false) continue;
                const name = String(meta.name ?? '').trim();
                if (!name) continue;
                const input = rowEl.querySelector('.cn-file-input');
                const file = input?.files?.[0];
                if (!file) throw new Error('File not selected for field "' + name + '"');
                fd.append(name, file, meta.filename || file.name || 'blob');
            }
            const lines = [];
            fd.forEach(function (v, k) {
                if (v instanceof Blob) lines.push(k + ': Blob ' + (v.type || '?') + ' ' + v.size + ' bytes');
                else lines.push(k + ': ' + String(v).slice(0, 80));
            });
            return { body: fd, preview: lines.join('\n') || '(empty FormData)' };
        }
        throw new Error('Unknown body mode: ' + bodyMode);
    }

    async function submit(root) {
        readUiState(root);
        ensureLogPanel();
        showLogPanel();
        const statusEl = root.querySelector('#cn-last-status');
        const method = CONFIG.method;
        const bodyMode = methodHasBody(method) ? CONFIG.bodyMode : 'none';
        const url = buildUrl(CONFIG.url, CONFIG.query);
        const headers = buildHeaders(CONFIG.headers, bodyMode);
        let bodyResult = { body: undefined, preview: '(no body)' };
        if (bodyMode !== 'none') {
            bodyResult = await buildBody(root, bodyMode, CONFIG.fields, readFileRows(root));
        }
        const fetchOpts = {
            method: method,
            credentials: 'include',
            headers: headers,
            referrer: CONFIG.referer || location.href,
        };
        if (bodyResult.body !== undefined) fetchOpts.body = bodyResult.body;
        const reqPreview = [method + ' ' + url, 'referer: ' + (CONFIG.referer || location.href), 'body: ' + bodyMode, '', bodyResult.preview].join('\n');
        logAppend('req', method + ' ' + url, reqPreview);
        if (statusEl) statusEl.textContent = 'Sending…';
        const t0 = performance.now();
        let resp;
        let text = '';
        try {
            resp = await fetch(url, fetchOpts);
            text = await resp.text();
        } catch (e) {
            logAppend('err', method + ' ' + url, e.message || String(e));
            if (statusEl) statusEl.textContent = 'Error: ' + (e.message || e);
            throw e;
        }
        const ms = Math.round(performance.now() - t0);
        const respHeaders = [];
        resp.headers.forEach(function (v, k) { respHeaders.push(k + ': ' + v); });
        const summary = ['HTTP ' + resp.status + ' ' + resp.statusText + ' (' + ms + ' ms)', 'URL: ' + url, '', '── headers ──', respHeaders.join('\n'), '', '── body ──', text.slice(0, LOG_BODY_MAX)].join('\n');
        logAppend('resp', 'HTTP ' + resp.status + ' (' + ms + 'ms)', summary);
        if (statusEl) {
            statusEl.textContent = 'HTTP ' + resp.status + ' · ' + ms + 'ms';
            statusEl.setAttribute('data-code', String(resp.status));
        }
        lastResponse = { status: resp.status, text: text, ms: ms, url: url, method: method };
        return lastResponse;
    }

    function syncBodyUi(root) {
        const method = (root.querySelector('#cn-method')?.value || 'GET').toUpperCase();
        const modeSel = root.querySelector('#cn-body-mode');
        const canBody = methodHasBody(method);
        if (modeSel) modeSel.disabled = !canBody;
        if (!canBody && modeSel && modeSel.value !== 'none') modeSel.value = 'none';
        const mode = modeSel?.value || 'none';
        root.querySelector('#cn-section-fields').hidden = mode === 'none' || mode === 'raw';
        root.querySelector('#cn-section-files').hidden = mode !== 'multipart';
        root.querySelector('#cn-section-raw').hidden = !(mode === 'json' || mode === 'raw');
        root.querySelector('#cn-send').textContent = '▶ SEND ' + method;
    }

    function syncLists(root) {
        root.querySelector('#cn-field-list').innerHTML = renderKvList(CONFIG.fields);
        root.querySelector('#cn-header-list').innerHTML = renderKvList(CONFIG.headers);
        root.querySelector('#cn-query-list').innerHTML = renderKvList(CONFIG.query);
    }

    function bindKvList(root, listId, addBtnId) {
        const list = root.querySelector('#' + listId);
        list?.addEventListener('click', function (e) {
            if (e.target.classList.contains('cn-kv-rm')) e.target.closest('.cn-kv-row')?.remove();
        });
        root.querySelector('#' + addBtnId)?.addEventListener('click', function () {
            list.insertAdjacentHTML('beforeend', kvRowHtml({ name: '', value: '', enabled: true }, false));
        });
    }

    function mountPanel() {
        if (panelRoot?._keyHandler) document.removeEventListener('keydown', panelRoot._keyHandler);
        document.getElementById('cupnet-http-lab')?.remove();

        const root = document.createElement('div');
        root.id = 'cupnet-http-lab';
        panelRoot = root;
        root.innerHTML = '<style>#cupnet-http-lab{position:fixed;z-index:2147483646;top:8px;right:8px;width:min(520px,calc(100vw - 16px));max-height:96vh;overflow:auto;background:#0f1419;color:#e6edf3;border:2px solid #388bfd;border-radius:10px;font:11px/1.35 ui-monospace,Menlo,system-ui,sans-serif;box-shadow:0 16px 48px rgba(0,0,0,.6)}#cupnet-http-lab .hd{padding:8px 10px;font-weight:700;background:#161b22;border-bottom:1px solid #30363d;display:flex;align-items:center;justify-content:space-between;cursor:move;user-select:none}#cupnet-http-lab .bd{padding:8px 10px}#cupnet-http-lab label{display:block;margin:6px 0 2px;color:#8b949e;font-size:10px}#cupnet-http-lab input[type=text],#cupnet-http-lab textarea,#cupnet-http-lab select{width:100%;box-sizing:border-box;background:#010409;border:1px solid #30363d;color:#e6edf3;border-radius:4px;padding:4px 6px;font:inherit}#cupnet-http-lab button{margin:2px 0;padding:6px 8px;border:none;border-radius:6px;cursor:pointer;font-weight:600;background:#21262d;color:#c9d1d9;font-size:10px}#cupnet-http-lab .b-send{background:#238636;color:#fff;width:100%;padding:9px;font-size:12px}#cupnet-http-lab .b-row{display:flex;flex-wrap:wrap;gap:4px}#cupnet-http-lab .cn-kv-row{display:grid;grid-template-columns:18px 1fr 1.5fr auto;gap:4px;margin:3px 0;align-items:start}#cupnet-http-lab .cn-kv-rm{width:22px;padding:2px;background:#da3633;color:#fff;border-radius:4px}#cupnet-http-lab #cn-last-status{font-size:10px;padding:8px;background:#010409;border:1px solid #30363d;border-radius:6px;margin:8px 0;word-break:break-word;min-height:2em}#cupnet-http-lab [hidden]{display:none!important}</style><div class="hd"><span>CupNet HTTP Lab v' + VERSION + '</span><span><button type="button" id="cn-show-log">Log</button><button type="button" id="cn-minimize" title="Minimize to bubble">◉</button><button type="button" id="cn-close" title="Close">✕</button></span></div><div class="bd"><label>URL · Ctrl+Enter send · Esc minimize</label><input type="text" id="cn-url" value="' + esc(CONFIG.url) + '"><div class="b-row"><button type="button" id="cn-url-page">URL ← page</button><button type="button" id="cn-ref-page">Referer ← page</button><button type="button" id="cn-import">↻ Import forms</button></div><div class="b-row"><select id="cn-method" style="flex:1">' + HTTP_METHODS.map(function (m) { return '<option value="' + m + '"' + (CONFIG.method === m ? ' selected' : '') + '>' + m + '</option>'; }).join('') + '</select><select id="cn-body-mode" style="flex:1.2">' + BODY_MODES.map(function (m) { return '<option value="' + m.id + '"' + (CONFIG.bodyMode === m.id ? ' selected' : '') + '>' + esc(m.label) + '</option>'; }).join('') + '</select></div><label>Referer</label><input type="text" id="cn-referer" value="' + esc(CONFIG.referer || location.href) + '"><details open><summary>Query</summary><div id="cn-query-list">' + renderKvList(CONFIG.query) + '</div><button type="button" id="cn-query-add">+ row</button></details><details open><summary>Headers</summary><div id="cn-header-list">' + renderKvList(CONFIG.headers) + '</div><button type="button" id="cn-header-add">+ row</button></details><details open id="cn-section-fields"><summary>Form fields (body)</summary><div id="cn-field-list">' + renderKvList(CONFIG.fields) + '</div><button type="button" id="cn-field-add">+ row</button></details><details open id="cn-section-files"><summary>Files (multipart)</summary><div id="cn-file-list"></div><button type="button" id="cn-file-add">+ file</button></details><details id="cn-section-raw"><summary>Raw / JSON body</summary><textarea id="cn-raw-body" rows="4">' + esc(CONFIG.rawBody) + '</textarea></details><button class="b-send" id="cn-send">▶ SEND</button><div id="cn-last-status">Ready · uses page cookies (credentials: include)</div></div>';

        document.body.appendChild(root);
        ensureLogPanel();
        bindKvList(root, 'cn-query-list', 'cn-query-add');
        bindKvList(root, 'cn-header-list', 'cn-header-add');
        bindKvList(root, 'cn-field-list', 'cn-field-add');
        root.querySelector('#cn-file-add')?.addEventListener('click', function () {
            root.querySelector('#cn-file-list').insertAdjacentHTML('beforeend', '<div class="cn-file-row"><input type="checkbox" class="cn-file-en" checked><input type="text" class="cn-file-name" placeholder="field" value="file"><input type="text" class="cn-file-fn" placeholder="filename" value="blob"><input type="file" class="cn-file-input"></div>');
        });
        root.querySelector('#cn-send').onclick = function () { submit(root).catch(function () { /* logged */ }); };
        root.querySelector('#cn-show-log').onclick = showLogPanel;
        root.querySelector('#cn-minimize').onclick = minimizeToBubble;
        root.querySelector('#cn-close').onclick = dismissLab;
        root.querySelector('#cn-url-page').onclick = function () {
            root.querySelector('#cn-url').value = location.pathname + location.search;
            toast('URL from page');
        };
        root.querySelector('#cn-ref-page').onclick = function () {
            root.querySelector('#cn-referer').value = location.href;
            toast('Referer updated');
        };
        root.querySelector('#cn-import').onclick = function () {
            mergePageIntoConfig('all');
            syncLists(root);
            root.querySelector('#cn-url').value = CONFIG.url;
            root.querySelector('#cn-method').value = CONFIG.method;
            root.querySelector('#cn-body-mode').value = CONFIG.bodyMode;
            syncBodyUi(root);
            toast('Imported from page forms');
        };
        root.querySelector('#cn-method').onchange = function () { syncBodyUi(root); };
        root.querySelector('#cn-body-mode').onchange = function () { syncBodyUi(root); };
        root._keyHandler = function (e) {
            if (!document.getElementById('cupnet-http-lab')) return;
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                root.querySelector('#cn-send')?.click();
            }
            if (e.key === 'Escape') minimizeToBubble();
        };
        document.addEventListener('keydown', root._keyHandler);
        syncBodyUi(root);
        reportUiState({ active: true, minimized: false });
        return root;
    }

    function applyRestorePageDefaults() {
        CONFIG.referer = location.href;
        if (!options.keepUrl) {
            CONFIG.url = location.pathname + location.search;
        }
    }

    function finishBoot(panel) {
        if (options.importForms) {
            syncLists(panel);
            panel.querySelector('#cn-url').value = CONFIG.url;
            panel.querySelector('#cn-referer').value = CONFIG.referer || location.href;
            panel.querySelector('#cn-method').value = CONFIG.method;
            panel.querySelector('#cn-body-mode').value = CONFIG.bodyMode;
            syncBodyUi(panel);
        }
    }

    loadLs();
    const savedUi = loadUiState();
    const shouldRestore = options.restore === true;
    const startMinimized = options.minimized === true
        || options.startMinimized === true
        || (shouldRestore && savedUi.minimized);

    if (shouldRestore) applyRestorePageDefaults();
    if (options.importForms && !shouldRestore) mergePageIntoConfig(options.focusForm ? 'primary' : 'all');
    if (options.url) CONFIG.url = options.url;
    if (options.method) CONFIG.method = String(options.method).toUpperCase();

    let panel;
    if (startMinimized) {
        panel = mountPanel();
        finishBoot(panel);
        panel.hidden = true;
        ensureBubble(savedUi.bubbleX, savedUi.bubbleY);
        bubbleRoot.hidden = false;
        uiMinimized = true;
        reportUiState({ active: true, minimized: true });
    } else {
        panel = mountPanel();
        finishBoot(panel);
        if (!options.restore && !options.skipLog) {
            showLogPanel();
            logAppend('info', 'HTTP Lab ready', 'Import forms from the page, edit fields, send with session cookies.\nCtrl+Enter = send · Esc = minimize to bubble');
        } else if (options.restore) {
            ensureLogPanel();
            logAppend('info', 'HTTP Lab restored', 'Restored after navigation.\nClick the bubble or panel to continue.');
        }
        reportUiState({ active: true, minimized: false });
    }

    const api = {
        VERSION: VERSION,
        CONFIG: CONFIG,
        submit: function () { return submit(panelRoot || panel); },
        importFromPage: function () { mergePageIntoConfig('all'); mountPanel(); },
        importFocusedForm: function () { mergePageIntoConfig('primary'); mountPanel(); },
        readPageForms: readPageForms,
        mountPanel: mountPanel,
        expandPanel: expandPanel,
        minimizeToBubble: minimizeToBubble,
        dismissLab: dismissLab,
        lastResponse: function () { return lastResponse; },
        exportConfig: exportConfig,
    };
    window.CupNetHttpLab = api;
    return api;
}
