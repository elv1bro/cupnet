'use strict';

/**
 * Optional Monaco editors for Rules window. Falls back to plain textareas on failure.
 */
(function () {
    const editors = {};

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('load failed: ' + src));
            document.head.appendChild(s);
        });
    }

    async function initMonacoEditors(api) {
        const apiRoot = window.electronAPI;
        if (!apiRoot || !apiRoot.getMonacoVsPath) return false;
        let vsDir;
        try {
            vsDir = await apiRoot.getMonacoVsPath();
        } catch {
            return false;
        }
        if (!vsDir) return false;
        const vsUrl = 'file://' + String(vsDir).replace(/\\/g, '/') + '/';
        window.require = { paths: { vs: vsUrl } };
        try {
            await loadScript(vsUrl + 'loader.js');
        } catch {
            return false;
        }
        const req = window.require;
        if (typeof req !== 'function') return false;
        await new Promise((resolve, reject) => {
            req(['vs/editor/editor.main'], () => resolve(), reject);
        });
        let monaco = window.monaco;
        if (!monaco || !monaco.editor) {
            try {
                monaco = req('monaco-editor');
            } catch (_) {
                return false;
            }
        }
        if (!monaco || !monaco.editor) return false;

        function createFor(wrapId, taId, lang) {
            const wrap = document.getElementById(wrapId);
            const ta = document.getElementById(taId);
            if (!wrap || !ta) return;
            const h = Math.max(120, ta.offsetHeight || 120);
            const ed = monaco.editor.create(wrap, {
                value: ta.value || '',
                language: lang,
                theme: 'vs-dark',
                automaticLayout: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                wordWrap: 'on',
            });
            ed.layout({ height: h, width: wrap.clientWidth || 400 });
            ta.style.display = 'none';
            editors[taId] = { editor: ed, textarea: ta };
            ed.onDidChangeModelContent(() => {
                ta.value = ed.getValue();
            });
        }

        createFor('monaco-req-h', 'edit-req-headers', 'json');
        createFor('monaco-resp-h', 'edit-resp-headers', 'json');
        createFor('monaco-mock-body', 'edit-mock-body', 'json');
        createFor('monaco-script-before', 'edit-script-before', 'javascript');
        createFor('monaco-script-after', 'edit-script-after', 'javascript');

        window.__cupnetMonacoEditors = editors;
        window.__monacoLoaded = true;
        return true;
    }

    window.CupNetRulesMonaco = {
        init: initMonacoEditors,
        syncFromTextareas() {
            const E = window.__cupnetMonacoEditors || {};
            for (const k of Object.keys(E)) {
                const { editor, textarea } = E[k];
                if (editor && textarea) editor.setValue(textarea.value || '');
            }
        },
        getValue(taId) {
            const e = (window.__cupnetMonacoEditors || {})[taId];
            if (e && e.editor) return e.editor.getValue();
            const ta = document.getElementById(taId);
            return ta ? ta.value : '';
        },
        setValue(taId, val) {
            const e = (window.__cupnetMonacoEditors || {})[taId];
            if (e && e.editor) e.editor.setValue(val || '');
            const ta = document.getElementById(taId);
            if (ta) ta.value = val || '';
        },
    };
})();
