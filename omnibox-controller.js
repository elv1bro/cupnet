'use strict';

/**
 * Omnibox controller for the main shell (browser.html).
 *
 * Owns the address-bar input state machine (committed URL vs. user draft), the suggestion rows,
 * inline completion, keyboard handling and the overlay sync. Pure logic lives in omnibox-input.js
 * (classifier) and omnibox-model.js (rows / ranking); the DOM glue lives here.
 *
 * Created by browser-renderer.js: `const omnibox = window.createOmniboxController(deps)`.
 *
 * States: idle (field shows the committed URL) → editing (focused, `draft` may differ)
 *         → open (editing + overlay visible). Tab-list/title updates never write into the
 *         field while a draft exists; only a real tab switch or a link click (will-navigate) does.
 */
(function omniboxControllerFactory(root) {
    const Input = root.CupNetOmniboxInput;
    const Model = root.CupNetOmniboxModel;

    const RENDER_DEBOUNCE_MS = 45;

    function createOmniboxController(deps) {
        const {
            api,
            urlInput,
            addressBarContainer,
            urlInputStack,
            urlClearBtn,
            getTabs,
            getCommands,
            normalizeUrl,
            renderCommitted,
            onLayoutChanged,
            overlayTopPx,
            getSearchEngineLabel,
            isInlineEnabled,
            showToast,
        } = deps;

        const st = {
            committed: '',
            editing: false,
            draft: null,
            open: false,
            mode: 'url',
            rows: [],
            activeIdx: 0,
            completion: null,
            completionShown: false,
            lastInputWasAppend: false,
            typedText: '',
            renderGen: 0,
            renderTimer: null,
            syncRaf: null,
            overlayReady: null,
            lastActiveTabId: undefined,
        };

        // ── helpers ────────────────────────────────────────────────────────
        function toast(msg, type) {
            if (typeof showToast === 'function') showToast(msg, { type: type || 'info' });
        }

        function isFocused() {
            return document.activeElement === urlInput;
        }

        function updateClearBtn() {
            if (!urlClearBtn) return;
            urlClearBtn.hidden = !(String(urlInput.value || '').trim() && isFocused());
        }

        function currentQuery() {
            return String(st.draft != null ? st.draft : urlInput.value || '').trim();
        }

        function setFieldText(text) {
            urlInput.value = text;
            st.completionShown = false;
            updateClearBtn();
        }

        function restoreCommittedText() {
            st.draft = null;
            setFieldText(st.committed);
        }

        // ── overlay ────────────────────────────────────────────────────────
        function hintText() {
            if (st.mode === 'command') return '↑↓ select · Enter run · Esc close · Shift+Enter open as URL';
            if (st.mode === 'zero') return '↑↓ select · Enter open · Shift+Enter isolated tab · Shift+Del remove · > commands';
            return '↑↓ select · Enter open · Tab accept · ⌘/Alt+Enter new tab · Shift+Enter isolated tab · Shift+Del remove';
        }

        function buildOverlayPayload() {
            const anchor = addressBarContainer?.getBoundingClientRect();
            const left = anchor ? Math.round(anchor.left) : 0;
            const width = anchor ? Math.max(120, Math.round(anchor.width)) : undefined;
            const topGap = anchor ? Math.max(2, Math.round(anchor.bottom - overlayTopPx + 2)) : 4;
            return {
                backdrop: false,
                attached: true,
                left,
                width,
                topGap,
                hint: hintText(),
                emptyText: st.mode === 'command' ? 'No commands match' : 'No suggestions yet',
                items: st.rows.map((row, i) => ({
                    active: i === st.activeIdx,
                    icon: row.icon || row.kind || 'url',
                    label: row.label,
                    match: row.match || null,
                    previewMatch: row.previewMatch || null,
                    sub: row.sub || '',
                    shortcut: row.shortcut || '',
                    urlPreview: row.urlPreview || '',
                    badge: row.badge || '',
                    deletable: !!row.deletable,
                })),
            };
        }

        function sync() {
            if (!st.open) return;
            if (st.syncRaf) return;
            st.syncRaf = requestAnimationFrame(() => {
                st.syncRaf = null;
                if (!st.open) return;
                try { void api.updateOmniboxOverlay?.(buildOverlayPayload()); } catch (_) { /* ignore */ }
            });
        }

        async function ensureOverlay() {
            if (!st.open) return false;
            if (!st.overlayReady) st.overlayReady = Promise.resolve(api.showOmniboxOverlay?.()).catch(() => false);
            const ok = !!(await st.overlayReady);
            if (!ok) st.overlayReady = null;
            return ok;
        }

        function open() {
            if (st.open) return;
            st.open = true;
            addressBarContainer?.classList.add('omnibox-open');
            urlInput.setAttribute('aria-expanded', 'true');
            void ensureOverlay().then((ok) => { if (ok && st.open) sync(); });
        }

        function close({ restore = false } = {}) {
            st.renderGen++;
            clearTimeout(st.renderTimer);
            st.renderTimer = null;
            if (st.syncRaf) { cancelAnimationFrame(st.syncRaf); st.syncRaf = null; }
            const wasOpen = st.open;
            st.open = false;
            st.overlayReady = null;
            st.rows = [];
            st.activeIdx = 0;
            st.completion = null;
            st.completionShown = false;
            addressBarContainer?.classList.remove('omnibox-open');
            urlInput.setAttribute('aria-expanded', 'false');
            try { void api.hideOmniboxOverlay?.(); } catch (_) { /* ignore */ }
            if (restore) restoreCommittedText();
            updateClearBtn();
            if (wasOpen && typeof onLayoutChanged === 'function') onLayoutChanged();
        }

        // ── rows ───────────────────────────────────────────────────────────
        function scheduleRender(immediate) {
            clearTimeout(st.renderTimer);
            st.renderTimer = null;
            if (immediate) { void render(); return; }
            st.renderTimer = setTimeout(() => { st.renderTimer = null; void render(); }, RENDER_DEBOUNCE_MS);
        }

        async function render() {
            const gen = ++st.renderGen;
            const q = currentQuery();
            const unchanged = q !== '' && normalizeUrl(q) === st.committed && st.draft == null;
            const classified = (unchanged || !q) ? { kind: 'empty' } : Input.classifyOmniboxInput(q, { base: st.committed });
            const tabs = typeof getTabs === 'function' ? (getTabs() || []) : [];
            const activeTabId = tabs.find((t) => t.isActive)?.id ?? null;
            const input = {
                query: classified.kind === 'empty' ? '' : q,
                classified,
                engineLabel: typeof getSearchEngineLabel === 'function' ? getSearchEngineLabel() : 'the web',
                tabs,
                activeTabId,
                inlineEnabled: typeof isInlineEnabled === 'function' ? isInlineEnabled() !== false : true,
                maxRows: 8,
            };
            try {
                if (classified.kind === 'command') {
                    input.commands = typeof getCommands === 'function' ? getCommands() : [];
                } else if (classified.kind === 'empty') {
                    const z = await api.omniboxZeroSuggest?.();
                    input.recent = z?.recent || [];
                    input.topSites = z?.topSites || [];
                } else {
                    const r = await api.omniboxSuggest?.(q, 8);
                    input.suggestions = r?.rows || [];
                    input.shortcut = r?.shortcut || null;
                }
            } catch (_) { /* fall through with what we have */ }
            if (gen !== st.renderGen) return;
            if (!isFocused() && !st.open) return;

            const built = Model.buildOmniboxRows(input);
            st.rows = built.rows;
            st.mode = built.mode;
            st.completion = built.completion;
            st.activeIdx = built.mode === 'zero' ? -1 : (st.rows.length ? 0 : -1);
            applyInlineCompletion(q);
            open();
            const ok = await ensureOverlay();
            if (gen !== st.renderGen) return;
            if (ok) sync();
        }

        function applyInlineCompletion(q) {
            st.completionShown = false;
            const c = st.completion;
            if (!c || !st.lastInputWasAppend || !isFocused()) return;
            if (st.draft == null || urlInput.value !== st.draft) return;
            if (!c.text.toLowerCase().startsWith(q.toLowerCase()) || c.text.length <= q.length) return;
            urlInput.value = c.text;
            try { urlInput.setSelectionRange(q.length, c.text.length); } catch (_) { /* ignore */ }
            st.completionShown = true;
        }

        function acceptCompletion() {
            if (!st.completionShown) return false;
            const v = urlInput.value;
            try { urlInput.setSelectionRange(v.length, v.length); } catch (_) { /* ignore */ }
            st.completionShown = false;
            st.lastInputWasAppend = false;
            st.draft = v;
            st.typedText = v;
            scheduleRender(true);
            return true;
        }

        function rowFieldText(row) {
            if (!row) return st.typedText;
            if (row.kind === 'search') return row.query || st.typedText;
            if (row.kind === 'cmd') return urlInput.value;
            if (row.kind === 'history' || row.kind === 'tab') return Model.displayUrlText(row.url || '');
            if (row.kind === 'url') return row.url && /^cupnet:/i.test(row.url) ? row.url : Model.displayUrlText(row.url || st.typedText);
            return st.typedText;
        }

        function moveHighlight(delta) {
            if (!st.rows.length) return;
            const min = st.mode === 'zero' ? -1 : 0;
            let next = st.activeIdx + delta;
            if (next < min) next = st.rows.length - 1;
            if (next >= st.rows.length) next = min;
            st.activeIdx = next;
            if (st.mode !== 'command') {
                const row = next >= 0 ? st.rows[next] : null;
                const typedFallback = st.draft != null ? st.typedText : st.committed;
                const text = row && !(next === 0 && st.mode !== 'zero' && row.isDefault && st.completion)
                    ? rowFieldText(row)
                    : (st.completionShown ? urlInput.value : typedFallback);
                if (next === 0 && st.completion && st.completionShown) {
                    // Back on the default row: show the completed text again.
                    urlInput.value = st.completion.text;
                } else {
                    urlInput.value = text;
                    st.completionShown = false;
                }
                try { urlInput.setSelectionRange(urlInput.value.length, urlInput.value.length); } catch (_) { /* ignore */ }
                if (next === 0 && st.completion && !st.completionShown && st.lastInputWasAppend && st.draft != null) {
                    // Re-show the completion selection when returning to the default row.
                    const q = st.draft;
                    if (st.completion.text.toLowerCase().startsWith(q.toLowerCase())) {
                        urlInput.value = st.completion.text;
                        try { urlInput.setSelectionRange(q.length, st.completion.text.length); } catch (_) { /* ignore */ }
                        st.completionShown = true;
                    }
                }
            }
            sync();
        }

        // ── navigation ─────────────────────────────────────────────────────
        function dispositionFor(e) {
            if (e.shiftKey) return 'isolated-tab';
            if (e.metaKey || e.ctrlKey || e.altKey) return 'new-tab';
            return 'current';
        }

        async function navigate(payload) {
            close({ restore: false });
            st.draft = null;
            st.editing = false;
            try { urlInput.blur(); } catch (_) { /* ignore */ }
            try {
                const r = await api.omniboxNavigate?.(payload);
                if (r && r.ok === false) toast('Nothing to open', 'warning');
            } catch (e) {
                toast(String(e?.message || e), 'error');
            }
        }

        function runRow(row, disposition) {
            if (!row) return;
            const text = st.typedText || currentQuery();
            try {
                if (row.kind === 'cmd') {
                    close({ restore: true });
                    try { urlInput.blur(); } catch (_) { /* ignore */ }
                    row.run?.();
                    return;
                }
                if (row.kind === 'tab') {
                    close({ restore: true });
                    try { urlInput.blur(); } catch (_) { /* ignore */ }
                    void api.switchTab?.(row.tabId);
                    return;
                }
                if (row.kind === 'search') {
                    void navigate({ text: row.query || text, action: 'search', disposition });
                    return;
                }
                if (row.kind === 'history') {
                    void navigate({ text, action: 'url', url: row.url, shortcutText: text, disposition });
                    return;
                }
                if (row.kind === 'url') {
                    void navigate({ text, action: 'url', url: row.url, disposition });
                    return;
                }
            } catch (e) {
                console.error('[Omnibox]', e);
                toast(String(e?.message || e), 'error');
            }
        }

        function submit(e) {
            const disposition = dispositionFor(e);
            const raw = String(urlInput.value || '').trim();
            if (st.mode === 'command' && st.open) {
                if (e.shiftKey) {
                    const rest = raw.replace(/^>\s*/, '').trim();
                    if (rest) void navigate({ text: rest, action: 'default', disposition: 'current' });
                    else close({ restore: true });
                    return;
                }
                if (st.activeIdx >= 0 && st.rows[st.activeIdx]) runRow(st.rows[st.activeIdx], disposition);
                return;
            }
            if (st.open && st.activeIdx >= 0 && st.rows[st.activeIdx]) {
                runRow(st.rows[st.activeIdx], disposition);
                return;
            }
            if (!raw) { close({ restore: true }); return; }
            void navigate({ text: raw, action: 'default', disposition });
        }

        async function deleteHighlighted() {
            const row = st.activeIdx >= 0 ? st.rows[st.activeIdx] : null;
            if (!row || !row.deletable || !row.url) return false;
            try { await api.omniboxDeleteUrl?.(row.url); } catch (_) { /* ignore */ }
            const wasDefault = !!row.isDefault;
            st.rows = st.rows.filter((r) => r !== row);
            if (wasDefault) {
                st.completion = null;
                if (st.completionShown) { setFieldText(st.typedText); st.draft = st.typedText; }
            }
            if (st.activeIdx >= st.rows.length) st.activeIdx = st.rows.length - 1;
            sync();
            toast('Removed from history', 'info');
            return true;
        }

        // ── public API ─────────────────────────────────────────────────────
        function setCommitted(url, { force = false, blur = false } = {}) {
            const norm = normalizeUrl(url);
            st.committed = norm;
            if (typeof renderCommitted === 'function') renderCommitted(norm);
            if (force) {
                st.draft = null;
                if (st.open) close({ restore: false });
                setFieldText(norm);
                if (blur) { try { urlInput.blur(); } catch (_) { /* ignore */ } }
                st.editing = isFocused();
                return;
            }
            if (st.draft == null && !st.completionShown) setFieldText(norm);
        }

        function onTabListUpdate(activeTab) {
            if (!activeTab) return;
            const changed = activeTab.id !== st.lastActiveTabId;
            st.lastActiveTabId = activeTab.id;
            setCommitted(activeTab.url || '', { force: changed });
        }

        function focusFromHotkey() {
            urlInput.focus();
            urlInput.select();
        }

        function openCommandMode() {
            if (st.open && st.mode === 'command' && String(urlInput.value || '').trim() === '>') {
                close({ restore: true });
                return;
            }
            urlInput.focus();
            setFieldText('>');
            st.draft = '>';
            st.typedText = '>';
            st.lastInputWasAppend = false;
            try { urlInput.setSelectionRange(1, 1); } catch (_) { /* ignore */ }
            scheduleRender(true);
        }

        // ── DOM events ─────────────────────────────────────────────────────
        urlInput.addEventListener('input', (e) => {
            st.editing = true;
            const insert = typeof e.inputType === 'string' && e.inputType.startsWith('insert');
            st.lastInputWasAppend = insert && urlInput.selectionStart === urlInput.value.length;
            st.draft = urlInput.value;
            st.typedText = st.draft;
            st.completionShown = false;
            updateClearBtn();
            scheduleRender(false);
        });

        urlInput.addEventListener('focus', () => {
            st.editing = true;
            updateClearBtn();
            scheduleRender(true);
        });

        urlInput.addEventListener('blur', () => {
            setTimeout(() => {
                if (isFocused()) return;
                if (addressBarContainer && addressBarContainer.contains(document.activeElement)) return;
                if (!document.hasFocus()) {
                    // The window lost focus (Cmd+Tab): keep the draft, just hide the list (A-211).
                    if (st.open) close({ restore: false });
                    return;
                }
                if (st.open) close({ restore: true });
                else if (st.draft != null) restoreCommittedText();
                st.editing = false;
                updateClearBtn();
            }, 0);
        });

        const selectAllOnMouseDown = (e) => {
            if (urlClearBtn && (e.target === urlClearBtn || urlClearBtn.contains(e.target))) return;
            if (!isFocused()) {
                e.preventDefault();
                urlInput.focus();
                urlInput.select();
            }
        };
        urlInputStack?.addEventListener('mousedown', selectAllOnMouseDown);
        urlInput.addEventListener('mousedown', (e) => {
            if (e.button === 2) return;
            selectAllOnMouseDown(e);
        });

        urlInput.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            try {
                api.urlBarContextMenu?.({
                    hasSelection: urlInput.selectionStart !== urlInput.selectionEnd,
                    hasText: !!String(urlInput.value || '').trim(),
                    committedUrl: st.committed,
                });
            } catch (_) { /* ignore */ }
        });

        urlClearBtn?.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            setFieldText('');
            st.draft = '';
            st.typedText = '';
            st.lastInputWasAppend = false;
            urlInput.focus();
            scheduleRender(true);
        });

        function onKeydown(e) {
            const focused = isFocused();
            if (!st.open && !focused) return;
            switch (e.key) {
                case 'ArrowDown':
                    if (!st.open) {
                        // Reopen the list after Esc without retyping (Chrome behaviour).
                        if (focused) { e.preventDefault(); scheduleRender(true); }
                        return;
                    }
                    e.preventDefault(); e.stopPropagation();
                    moveHighlight(1);
                    return;
                case 'ArrowUp':
                    if (!st.open) return;
                    e.preventDefault(); e.stopPropagation();
                    moveHighlight(-1);
                    return;
                case 'Tab':
                    if (!st.open) return;
                    e.preventDefault(); e.stopPropagation();
                    if (!e.shiftKey && acceptCompletion()) return;
                    moveHighlight(e.shiftKey ? -1 : 1);
                    return;
                case 'ArrowRight':
                case 'End':
                    if (st.completionShown && urlInput.selectionStart !== urlInput.selectionEnd) {
                        e.preventDefault(); e.stopPropagation();
                        acceptCompletion();
                    }
                    return;
                case 'Enter':
                    if (!focused && !st.open) return;
                    e.preventDefault(); e.stopPropagation();
                    submit(e);
                    return;
                case 'Escape':
                    if (st.open) {
                        e.preventDefault(); e.stopPropagation();
                        close({ restore: true });
                        return;
                    }
                    if (focused) {
                        e.preventDefault(); e.stopPropagation();
                        restoreCommittedText();
                        st.editing = false;
                        try { urlInput.blur(); } catch (_) { /* ignore */ }
                    }
                    return;
                case 'Delete':
                case 'Backspace':
                    if (st.open && e.shiftKey && st.activeIdx >= 0) {
                        e.preventDefault(); e.stopPropagation();
                        void deleteHighlighted();
                    }
                    return;
                default:
            }
        }
        document.addEventListener('keydown', onKeydown, true);

        document.addEventListener('mousedown', (e) => {
            if (!st.open) return;
            if (addressBarContainer?.contains(e.target)) return;
            close({ restore: true });
        }, true);

        let resizeTimer = null;
        window.addEventListener('resize', () => {
            if (!st.open) return;
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => sync(), 80);
        });

        window.addEventListener('focus', () => {
            // Draft kept while the window was in the background: refresh suggestions for it.
            if (isFocused() && st.draft != null) scheduleRender(true);
        });

        api.onOmniboxOverlaySelect?.((idx) => {
            const i = Number(idx);
            if (Number.isFinite(i) && st.rows[i]) runRow(st.rows[i], 'current');
        });
        api.onOmniboxOverlayDismiss?.(() => close({ restore: true }));
        api.onOmniboxOverlayDelete?.((idx) => {
            const i = Number(idx);
            if (!Number.isFinite(i) || !st.rows[i]) return;
            st.activeIdx = i;
            void deleteHighlighted();
            try { urlInput.focus(); } catch (_) { /* ignore */ }
        });
        api.onForceCloseOmnibox?.(() => { if (st.open) close({ restore: false }); });
        api.onOmniboxClose?.(() => { close({ restore: false }); st.draft = null; try { urlInput.blur(); } catch (_) { /* ignore */ } });
        api.onToggleCommandPalette?.(() => openCommandMode());

        const controller = {
            setCommitted,
            onTabListUpdate,
            focusFromHotkey,
            openCommandMode,
            close: (opts) => close(opts || { restore: true }),
            isOpen: () => st.open,
            isEditing: () => st.editing || isFocused(),
            hasDraft: () => st.draft != null,
            sync,
            rerender: () => { if (st.open) scheduleRender(true); },
            getState: () => ({
                committed: st.committed,
                draft: st.draft,
                open: st.open,
                mode: st.mode,
                activeIdx: st.activeIdx,
                completion: st.completion,
                completionShown: st.completionShown,
                rows: st.rows.map((r) => ({ kind: r.kind, label: r.label, url: r.url || null, sub: r.sub || '', isDefault: !!r.isDefault, badge: r.badge || '' })),
            }),
        };
        return controller;
    }

    root.createOmniboxController = createOmniboxController;
})(typeof window !== 'undefined' ? window : globalThis);
