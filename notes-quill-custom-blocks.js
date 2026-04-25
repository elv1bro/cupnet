'use strict';

/**
 * CupNet Notes — custom Quill BlockEmbed system.
 *
 * Each block type defines 4 contracts:
 *   1. render(node, payload)  — how the block looks in the editor
 *   2. normalize(raw)         — canonical payload stored in data-cn-payload (JSON)
 *   3. exportText(payload)    — plain-text / markdown representation for export
 *   4. actions[]              — buttons shown at the bottom of the card
 *
 * DOM contract:
 *   <div class="ql-cn-block ql-cn-block--{kind}" data-cn-payload='{"v":1,"kind":"demo",...}'>
 *     <!-- rendered face (contenteditable=false) -->
 *   </div>
 *
 * Export contract (Turndown rule in notes-ipc.js reads data-cn-payload):
 *   For md/txt the block emits `exportText(payload)`.
 *   For html export the block keeps its card HTML as-is (minus action buttons).
 */
(function () {
    const Quill = typeof window !== 'undefined' && window.Quill;
    if (!Quill) return;

    const BlockEmbed = Quill.import('blots/block/embed');

    /* ── helpers ────────────────────────────────────────────────────────────── */

    function esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function truncate(s, n) {
        if (!s) return '';
        return s.length > n ? s.slice(0, n) + '\u2026' : s;
    }

    function fmtBytes(n) {
        if (n == null) return '';
        if (n < 1024) return n + ' B';
        if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
        return (n / 1048576).toFixed(2) + ' MB';
    }

    function methodColor(m) {
        const map = { GET: '#61affe', POST: '#49cc90', PUT: '#fca130', PATCH: '#50e3c2', DELETE: '#f93e3e', HEAD: '#9012fe', OPTIONS: '#0d5aa7' };
        return map[(m || '').toUpperCase()] || 'var(--text-dim)';
    }

    /* ── block registry ────────────────────────────────────────────────────── */

    const _registry = {};

    function registerBlockKind(kind, def) {
        _registry[kind] = def;
    }

    /**
     * Lookup a registered kind definition.
     * Also exported to window for notes-ipc.js Turndown rules.
     */
    function getBlockKind(kind) {
        return _registry[kind] || null;
    }
    window._cnBlockRegistry = { get: getBlockKind, list: () => Object.keys(_registry) };

    /**
     * Clicks on action buttons must be delegated: quill.root.innerHTML wipes addEventListener.
     * Keys: "{kind}:{actionId}" e.g. "request:open-request-editor"
     */
    const _cnBlockActionHandlers = {};

    function registerCnBlockActions(kind, map) {
        for (const [actionId, fn] of Object.entries(map)) {
            _cnBlockActionHandlers[kind + ':' + actionId] = fn;
        }
    }

    const _delegatedRoots = new WeakSet();

    /**
     * Call once after Quill is created (notes-renderer). Uses capture so clicks work inside the editor.
     */
    window.setupCnBlockDelegatedActions = function setupCnBlockDelegatedActions(root) {
        if (!root || _delegatedRoots.has(root)) return;
        _delegatedRoots.add(root);
        root.addEventListener(
            'click',
            (e) => {
                const btn = e.target && e.target.closest && e.target.closest('.cn-block-act-btn');
                if (!btn || !root.contains(btn)) return;
                const block = btn.closest('.ql-cn-block');
                if (!block || !root.contains(block)) return;
                const key = btn.getAttribute('data-cn-action');
                if (!key) return;
                const handler = _cnBlockActionHandlers[key];
                if (typeof handler !== 'function') return;
                e.preventDefault();
                e.stopPropagation();
                let payload;
                try {
                    payload = JSON.parse(block.getAttribute('data-cn-payload') || '{}');
                } catch {
                    return;
                }
                handler(payload, window.electronAPI);
            },
            true,
        );
    };

    /* ── generic Quill blot ────────────────────────────────────────────────── */

    class CnBlockBlot extends BlockEmbed {
        static blotName = 'cnBlock';
        static className = 'ql-cn-block';
        static tagName = 'DIV';

        static create(value) {
            const node = super.create();
            const kind = (value && value.kind) || 'demo';
            const def = getBlockKind(kind);
            const payload = def ? def.normalize(value) : { v: 1, kind, _raw: value };
            node.setAttribute('data-cn-payload', JSON.stringify(payload));
            node.setAttribute('spellcheck', 'false');
            node.classList.add('ql-cn-block--' + kind);
            if (def) def.render(node, payload);
            return node;
        }

        static value(domNode) {
            try {
                return JSON.parse(domNode.getAttribute('data-cn-payload') || '{}');
            } catch {
                return { v: 1, kind: 'unknown' };
            }
        }
    }

    Quill.register(CnBlockBlot);

    /* ── action button helper ──────────────────────────────────────────────── */

    function renderActions(container, actions, payload, kind) {
        if (!actions || !actions.length) return;
        const bar = document.createElement('div');
        bar.className = 'cn-block-actions';
        bar.setAttribute('contenteditable', 'false');
        for (const act of actions) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'cn-block-act-btn cn-block-act-btn--' + (act.color || 'blue');
            btn.title = act.title || '';
            btn.innerHTML = (act.icon || '') + '<span>' + esc(act.label) + '</span>';
            if (act.actionId && kind) {
                btn.setAttribute('data-cn-action', kind + ':' + act.actionId);
            }
            bar.appendChild(btn);
        }
        container.appendChild(bar);
    }

    /* ── collapsible section helper ────────────────────────────────────────── */

    function renderCollapsible(parent, title, contentHtml, opts) {
        const det = document.createElement('details');
        det.className = 'cn-block-collapse' + (opts?.open ? ' open' : '');
        if (opts?.open) det.open = true;
        const sum = document.createElement('summary');
        sum.className = 'cn-block-collapse-title';
        sum.textContent = title;
        det.appendChild(sum);
        const body = document.createElement('div');
        body.className = 'cn-block-collapse-body';
        body.innerHTML = contentHtml;
        det.appendChild(body);
        parent.appendChild(det);
    }

    /* ══════════════════════════════════════════════════════════════════════════
       Block kind: "demo"  (simple chip — kept as a reference)
       ══════════════════════════════════════════════════════════════════════ */

    registerBlockKind('demo', {
        normalize(v) {
            if (v && typeof v === 'object') {
                return {
                    v: 1, kind: 'demo',
                    secret: String(v.secret ?? ''),
                    caption: String(v.caption ?? 'Demo chip'),
                };
            }
            return { v: 1, kind: 'demo', secret: String(v ?? ''), caption: 'Demo chip' };
        },

        render(node, payload) {
            const face = document.createElement('div');
            face.className = 'cn-block-face';
            face.setAttribute('contenteditable', 'false');
            face.innerHTML =
                '<span class="cn-block-icon" aria-hidden="true">\u25C6</span>'
                + '<span class="cn-block-title">' + esc(payload.caption) + '</span>'
                + '<span class="cn-block-hint">Hidden payload stored</span>';
            node.appendChild(face);
        },

        exportText(p) {
            return '=CHIP=====\n'
                + 'caption: ' + (p.caption || '') + '\n'
                + 'secret: ' + (p.secret || '') + '\n'
                + '=CHIP=====';
        },

        actions: [],
    });

    /* ══════════════════════════════════════════════════════════════════════════
       Block kind: "request"  (HTTP request/response card)
       ══════════════════════════════════════════════════════════════════════ */

    registerBlockKind('request', {
        normalize(v) {
            if (!v || typeof v !== 'object') return { v: 1, kind: 'request', url: '', method: 'GET' };
            return {
                v: 1,
                kind: 'request',
                requestId: v.requestId ?? null,
                sessionId: v.sessionId ?? null,
                url: String(v.url ?? ''),
                method: String(v.method ?? 'GET').toUpperCase(),
                status: v.status != null ? Number(v.status) : null,
                statusText: v.statusText ?? '',
                mimeType: v.mimeType ?? '',
                requestHeaders: v.requestHeaders ?? null,
                responseHeaders: v.responseHeaders ?? null,
                requestBody: v.requestBody ?? null,
                responseBody: v.responseBody != null ? truncate(String(v.responseBody), 50000) : null,
                responseSize: v.responseSize ?? null,
                timing: v.timing ?? null,
                timestamp: v.timestamp ?? null,
                tlsVersion: v.tlsVersion ?? null,
                protocol: v.protocol ?? null,
            };
        },

        render(node, p) {
            const face = document.createElement('div');
            face.className = 'cn-block-face cn-block-face--req';
            face.setAttribute('contenteditable', 'false');

            const statusCls = !p.status ? '' : p.status < 300 ? 'ok' : p.status < 400 ? 'redir' : 'err';

            /* header row */
            face.innerHTML =
                '<div class="cn-req-head">'
                + '<span class="cn-req-method" style="color:' + methodColor(p.method) + '">' + esc(p.method) + '</span>'
                + (p.status != null ? '<span class="cn-req-status cn-req-status--' + statusCls + '">' + p.status + '</span>' : '')
                + '<span class="cn-req-url">' + esc(truncate(p.url, 200)) + '</span>'
                + '</div>';

            /* meta row */
            const metaParts = [];
            if (p.mimeType) metaParts.push(esc(p.mimeType));
            if (p.responseSize != null) metaParts.push(fmtBytes(p.responseSize));
            if (p.timing) metaParts.push(p.timing + ' ms');
            if (p.protocol) metaParts.push(esc(p.protocol));
            if (p.tlsVersion) metaParts.push(esc(p.tlsVersion));
            if (p.requestId != null) metaParts.push('ID ' + p.requestId);
            if (metaParts.length) {
                const meta = document.createElement('div');
                meta.className = 'cn-req-meta';
                meta.innerHTML = metaParts.join('<span class="cn-req-sep">\u00B7</span>');
                face.appendChild(meta);
            }

            node.appendChild(face);

            /* collapsible sections */
            const sections = node;
            if (p.requestHeaders) {
                renderCollapsible(sections, 'Request Headers', '<pre>' + esc(formatHeaders(p.requestHeaders)) + '</pre>');
            }
            if (p.responseHeaders) {
                renderCollapsible(sections, 'Response Headers', '<pre>' + esc(formatHeaders(p.responseHeaders)) + '</pre>');
            }
            if (p.requestBody) {
                renderCollapsible(sections, 'Request Body', '<pre>' + esc(truncate(p.requestBody, 5000)) + '</pre>');
            }
            if (p.responseBody) {
                renderCollapsible(sections, 'Response Body', '<pre>' + esc(truncate(p.responseBody, 5000)) + '</pre>');
            }

            /* action buttons (handlers wired via setupCnBlockDelegatedActions — survives innerHTML) */
            renderActions(node, [
                {
                    actionId: 'open-request-editor',
                    label: 'Open in Request Editor',
                    icon: '\u270E ',
                    color: 'blue',
                    title: 'Load this request into the Request Editor for replay / edit',
                },
                {
                    actionId: 'find-in-network',
                    label: 'Find in Network Activity',
                    icon: '\uD83D\uDD0D ',
                    color: 'green',
                    title: 'Select this request in the Network Activity log',
                },
            ], p, 'request');
        },

        exportText(p) {
            const lines = [
                '=REQ=====',
                p.method + ' ' + p.url,
            ];
            if (p.status != null) lines.push('Status: ' + p.status + (p.statusText ? ' ' + p.statusText : ''));
            if (p.mimeType) lines.push('Content-Type: ' + p.mimeType);
            if (p.responseSize != null) lines.push('Size: ' + fmtBytes(p.responseSize));
            if (p.timing) lines.push('Timing: ' + p.timing + ' ms');
            if (p.protocol) lines.push('Protocol: ' + p.protocol);
            if (p.tlsVersion) lines.push('TLS: ' + p.tlsVersion);
            if (p.requestId != null) lines.push('Request-ID: ' + p.requestId);
            if (p.sessionId != null) lines.push('Session-ID: ' + p.sessionId);
            if (p.requestHeaders) {
                lines.push('');
                lines.push('[Request Headers]');
                lines.push(formatHeaders(p.requestHeaders));
            }
            if (p.responseHeaders) {
                lines.push('');
                lines.push('[Response Headers]');
                lines.push(formatHeaders(p.responseHeaders));
            }
            if (p.requestBody) {
                lines.push('');
                lines.push('[Request Body]');
                lines.push(p.requestBody);
            }
            if (p.responseBody) {
                lines.push('');
                lines.push('[Response Body]');
                lines.push(p.responseBody);
            }
            lines.push('=REQ=====');
            return lines.join('\n');
        },
    });

    registerCnBlockActions('request', {
        'open-request-editor': function (payload, electronApi) {
            if (!electronApi) return;
            const rid = Number(payload.requestId);
            if (Number.isFinite(rid) && rid > 0) {
                electronApi.openRequestEditor(rid);
            } else {
                electronApi.openRequestEditor({
                    method: payload.method,
                    url: payload.url,
                    requestHeaders: payload.requestHeaders,
                    requestBody: payload.requestBody,
                });
            }
        },
        'find-in-network': function (payload, electronApi) {
            if (!electronApi) return;
            const rid = Number(payload.requestId);
            if (Number.isFinite(rid) && rid > 0) {
                electronApi.openLogViewerFocusRequest?.(rid);
            } else {
                electronApi.openLogViewerWithUrl?.(payload.url || '');
            }
        },
    });

    function formatHeaders(h) {
        if (!h) return '';
        if (typeof h === 'string') return h;
        if (Array.isArray(h)) {
            return h.map((x) => {
                if (typeof x === 'string') return x;
                if (x && x.name != null) return x.name + ': ' + (x.value ?? '');
                return String(x);
            }).join('\n');
        }
        if (typeof h === 'object') {
            return Object.entries(h).map(([k, v]) => k + ': ' + v).join('\n');
        }
        return String(h);
    }

    /* ── public API ────────────────────────────────────────────────────────── */

    /**
     * Insert a CnBlock of the given kind into the editor.
     * @param {object} quill
     * @param {string} kind
     * @param {object} data
     */
    window.insertCnBlock = function insertCnBlock(quill, kind, data) {
        if (!quill) return;
        const range = quill.getSelection(true);
        const idx = range ? range.index : quill.getLength();
        quill.insertEmbed(idx, 'cnBlock', { ...data, kind }, Quill.sources.USER);
        quill.setSelection(idx + 1, 0, Quill.sources.SILENT);
        quill.focus();
    };

    /**
     * After mdToHtml, marked emits <pre><code class="language-cupnet">…JSON…</code></pre>.
     * Replace with real ql-cn-block DOM so Quill shows cards again after reopen.
     */
    window.hydrateCupnetBlocksHtml = function hydrateCupnetBlocksHtml(html) {
        if (!html || typeof html !== 'string') return html;
        const parser = new DOMParser();
        const doc = parser.parseFromString('<div class="cn-hydrate-root">' + html + '</div>', 'text/html');
        const root = doc.querySelector('.cn-hydrate-root');
        if (!root) return html;
        const get = typeof window._cnBlockRegistry?.get === 'function'
            ? window._cnBlockRegistry.get.bind(window._cnBlockRegistry)
            : null;
        root.querySelectorAll('pre > code').forEach((code) => {
            const cls = code.getAttribute('class') || '';
            if (!/\blanguage-cupnet\b/.test(cls)) return;
            const pre = code.parentElement;
            if (!pre || pre.tagName !== 'PRE') return;
            let payload;
            try {
                payload = JSON.parse((code.textContent || '').trim());
            } catch {
                return;
            }
            if (!payload || !payload.kind) return;
            const def = get ? get(payload.kind) : null;
            if (!def) return;
            const norm = def.normalize(payload);
            const div = doc.createElement('div');
            div.className = 'ql-cn-block ql-cn-block--' + String(payload.kind || '');
            div.setAttribute('data-cn-payload', JSON.stringify(norm));
            div.setAttribute('spellcheck', 'false');
            try {
                def.render(div, norm);
            } catch {
                return;
            }
            pre.replaceWith(div);
        });
        return root.innerHTML;
    };
})();
