'use strict';

/**
 * Shared HTML response preview helpers (renderer-safe; uses DOMParser when available).
 * Used by Log Viewer, Compare Viewer, Request Editor.
 */

function isLikelyHtmlContent(text) {
    const t = String(text || '').trimStart().slice(0, 800).toLowerCase();
    return t.startsWith('<!doctype html') || t.startsWith('<html')
        || (t.includes('<html') && t.includes('<body'));
}

function normalizePlainText(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/[ \t]*\n[ \t]*/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function isSandboxSafeResourceUrl(url) {
    const u = String(url || '').trim();
    if (!u) return false;
    return /^data:/i.test(u) || /^blob:/i.test(u);
}

function splitSrcsetEntries(value) {
    const entries = [];
    let acc = '';
    for (const chunk of String(value || '').split(',')) {
        const next = acc ? `${acc},${chunk}` : chunk;
        const trimmed = next.trim();
        if (/\s+\d+(?:\.\d+)?[wx]$/.test(trimmed) || /\s+\d+(?:\.\d+)?x$/.test(trimmed)) {
            entries.push(trimmed);
            acc = '';
        } else {
            acc = next;
        }
    }
    if (acc.trim()) entries.push(acc.trim());
    return entries;
}

function sanitizeSrcsetValue(value) {
    const safe = splitSrcsetEntries(value).filter((part) => {
        const url = part.split(/\s+/)[0] || '';
        return isSandboxSafeResourceUrl(url);
    });
    return safe.length ? safe.join(', ') : '';
}

function stripInlineEventHandlers(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('*').forEach((el) => {
        for (const attr of Array.from(el.attributes || [])) {
            if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        }
    });
}

function buildSandboxPreviewDoc(rawHtml) {
    const raw = String(rawHtml || '');
    if (!raw.trim()) {
        return '<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;background:#fff;color:#111;padding:12px">Empty preview</body></html>';
    }
    if (typeof DOMParser === 'undefined') {
        return '<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;background:#fff;color:#111;padding:12px">Preview unavailable</body></html>';
    }
    try {
        const doc = new DOMParser().parseFromString(raw, 'text/html');
        doc.querySelectorAll('script, noscript').forEach((el) => el.remove());
        doc.querySelectorAll('meta[http-equiv]').forEach((m) => {
            if (/refresh/i.test(String(m.getAttribute('http-equiv') || ''))) m.remove();
        });
        doc.querySelectorAll('base').forEach((el) => el.remove());
        doc.querySelectorAll('iframe, frame, object, embed').forEach((el) => {
            const p = doc.createElement('div');
            p.textContent = '[embedded content blocked in sandbox preview]';
            p.setAttribute('data-blocked', '1');
            p.style.cssText = 'padding:6px 8px;border:1px dashed #aaa;margin:6px 0;font:12px/1.4 monospace;color:#555;background:#fafafa;';
            el.replaceWith(p);
        });
        doc.querySelectorAll('[src],[href],[srcset],[ping],[poster]').forEach((el) => {
            if (el.hasAttribute('src')) {
                const src = el.getAttribute('src') || '';
                if (!isSandboxSafeResourceUrl(src)) {
                    el.setAttribute('data-original-src', src);
                    el.removeAttribute('src');
                }
            }
            if (el.hasAttribute('href')) {
                const href = el.getAttribute('href') || '';
                if (!isSandboxSafeResourceUrl(href) && !href.startsWith('#')) {
                    el.setAttribute('data-original-href', href);
                    el.removeAttribute('href');
                }
            }
            if (el.hasAttribute('srcset')) {
                const safe = sanitizeSrcsetValue(el.getAttribute('srcset') || '');
                if (safe) el.setAttribute('srcset', safe);
                else el.removeAttribute('srcset');
            }
            if (el.hasAttribute('ping')) el.removeAttribute('ping');
            if (el.hasAttribute('poster')) {
                const poster = el.getAttribute('poster') || '';
                if (!isSandboxSafeResourceUrl(poster)) el.removeAttribute('poster');
            }
        });
        stripInlineEventHandlers(doc.documentElement);
        const bodyHtml = doc.body?.innerHTML || '';
        const headStyles = Array.from(doc.querySelectorAll('head style, body style'))
            .map((el) => el.outerHTML)
            .join('');
        const titleText = (doc.querySelector('title')?.textContent || '').trim();
        const titleTag = titleText
            ? `<title>${titleText.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>`
            : '';
        const csp = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data: blob:; script-src 'none'; frame-src 'none'; object-src 'none'; media-src 'none'; connect-src 'none'; form-action 'none';";
        return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">${titleTag}<style>html,body{margin:0;padding:0;background:#fff;color:#111}body{font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}</style>${headStyles}</head><body>${bodyHtml || '<p style="color:#666;padding:12px">(empty body)</p>'}</body></html>`;
    } catch {
        return '<!doctype html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;background:#fff;color:#111;padding:12px">Preview parse error</body></html>';
    }
}

function extractHtmlPlainText(rawHtml) {
    const raw = String(rawHtml || '');
    if (!raw.trim()) return '';
    if (typeof DOMParser === 'undefined') {
        return normalizePlainText(
            raw
                .replace(/<script[\s\S]*?<\/script>/gi, '\n')
                .replace(/<style[\s\S]*?<\/style>/gi, '\n')
                .replace(/<noscript[\s\S]*?<\/noscript>/gi, '\n')
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/(p|div|h[1-6]|li|tr|td|th|table|section|article|header|footer|blockquote|pre)>/gi, '\n')
                .replace(/<[^>]+>/g, ' '),
        );
    }
    try {
        const doc = new DOMParser().parseFromString(raw, 'text/html');
        doc.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
        const text = doc.body?.innerText || doc.body?.textContent || '';
        return normalizePlainText(text);
    } catch {
        return normalizePlainText(
            raw
                .replace(/<script[\s\S]*?<\/script>/gi, '\n')
                .replace(/<style[\s\S]*?<\/style>/gi, '\n')
                .replace(/<noscript[\s\S]*?<\/noscript>/gi, '\n')
                .replace(/<br\s*\/?>/gi, '\n')
                .replace(/<\/(p|div|h[1-6]|li|tr|td|th|table|section|article|header|footer|blockquote|pre)>/gi, '\n')
                .replace(/<[^>]+>/g, ' '),
        );
    }
}

function previewDocHash(text) {
    const s = String(text || '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
}

const exportsObj = {
    isLikelyHtmlContent,
    isSandboxSafeResourceUrl,
    sanitizeSrcsetValue,
    splitSrcsetEntries,
    buildSandboxPreviewDoc,
    extractHtmlPlainText,
    normalizePlainText,
    previewDocHash,
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportsObj;
}
if (typeof window !== 'undefined') {
    window.HtmlResponsePreview = exportsObj;
}
