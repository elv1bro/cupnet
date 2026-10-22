'use strict';

/**
 * CupNet mini site map, built from the HTML documents of a session log.
 *
 * Every page the browser loaded (a `Document` request) is "opened"; every link found in those documents
 * (<a>, <area>, <iframe>/<frame>, form actions, <link rel=canonical|alternate|next|prev>, redirects) that
 * was never loaded is "not opened". Forms and their fields come from the same documents, with hidden
 * fields and links flagged: type=hidden, the `hidden` attribute, inline styles (display:none,
 * visibility:hidden, opacity:0, off-screen, zero size, clipped), a hidden ancestor, and — as "likely" —
 * hiding classes (d-none, sr-only, honeypot…) and aria-hidden. Stylesheets and scripts are not run, so
 * fields hidden only by CSS rules or JS are seen as visible; the Analyzer checks the live page.
 *
 * Sessions are scanned once and cached; the current session is scanned incrementally.
 */

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'keygen']);
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'noscript', 'iframe', 'noembed', 'noframes', 'plaintext']);
const FIELD_TAGS = new Set(['input', 'select', 'textarea', 'button']);
const LINK_RELS = new Set(['canonical', 'alternate', 'next', 'prev', 'amphtml']);
const HIDE_CLASS_RE = /^(d-none|hidden|hide|is-hidden|u-hidden|visually-hidden|visuallyhidden|sr-only|screen-reader-text|invisible|display-none|hp|honeypot|ohnohoney)$|honeypot/i;
const FILE_EXT_RE = /\.(pdf|zip|rar|7z|gz|tgz|tar|dmg|exe|msi|apk|jpe?g|png|gif|webp|avif|svg|ico|mp[34]|webm|mov|avi|wav|ogg|woff2?|ttf|eot|css|js|mjs|json|xml|txt|csv|docx?|xlsx?|pptx?)$/i;
const MAX_HTML = 8 * 1024 * 1024;
const MAX_LINKS = 5000;
const MAX_FORMS = 200;
const MAX_FIELDS = 500;
const TEXT_MAX = 160;
const VALUE_MAX = 300;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
    if (!s || s.indexOf('&') < 0) return s;
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e) => {
        if (e[0] === '#') {
            const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
        }
        return ENTITY[e.toLowerCase()] ?? m;
    });
}

function _attrs(src) {
    const a = {};
    ATTR_RE.lastIndex = 0;
    let m;
    while ((m = ATTR_RE.exec(src))) {
        const k = m[1].toLowerCase();
        if (k in a) continue;
        a[k] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    }
    return a;
}

/** Why an element hides itself: { vis: 'hidden'|'likely', why } or null. */
function ownHidden(tag, a) {
    if (tag === 'input' && String(a.type || '').toLowerCase() === 'hidden') return { vis: 'hidden', why: 'type=hidden' };
    if ('hidden' in a && String(a.hidden).toLowerCase() !== 'until-found') return { vis: 'hidden', why: 'hidden attribute' };
    const st = String(a.style || '').toLowerCase().replace(/\s+/g, '');
    if (st) {
        if (/(^|;)display:none/.test(st)) return { vis: 'hidden', why: 'display:none' };
        if (/(^|;)visibility:(hidden|collapse)/.test(st)) return { vis: 'hidden', why: 'visibility:hidden' };
        if (/(^|;)opacity:0?\.?0*(;|!|$)/.test(st)) return { vis: 'hidden', why: 'opacity:0' };
        if (/(^|;)(left|top|right|bottom|text-indent|margin-left|margin-top):-\d{3,}/.test(st)) return { vis: 'hidden', why: 'off-screen' };
        if (/(^|;)(width|height|max-width|max-height):0(px|%|em|rem)?(;|!|$)/.test(st) && /overflow:hidden/.test(st)) return { vis: 'hidden', why: 'zero size' };
        if (/clip:rect\(0/.test(st) || /clip-path:inset\(50%/.test(st)) return { vis: 'hidden', why: 'clipped' };
    }
    const cls = String(a.class || '').split(/\s+/).find((c) => c && HIDE_CLASS_RE.test(c));
    if (cls) return { vis: 'likely', why: `class .${cls}` };
    if (String(a['aria-hidden'] || '').toLowerCase() === 'true') return { vis: 'likely', why: 'aria-hidden' };
    return null;
}

/** `https://Ex.com:443/a#x` → `https://ex.com/a`; '' for non-http(s) or unparsable. */
function normUrl(raw, base) {
    try {
        const u = base ? new URL(raw, base) : new URL(raw);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
        u.hash = '';
        return u.href;
    } catch { return ''; }
}

const _clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const _squash = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Links, forms and title of one HTML document.
 * @returns {{ title: string, base: string, links: object[], forms: object[] }}
 */
function extractPage(html, docUrl) {
    const src = String(html || '').slice(0, MAX_HTML);
    let base = docUrl;
    let title = '';
    const links = [];
    const forms = [];
    const formById = new Map();
    const orphan = { idx: -1, id: '', name: '', action: '', method: '', enctype: '', vis: 'visible', why: '', fields: [] };
    const late = []; // fields with form="id" outside it
    const labelsFor = new Map();
    const stack = []; // { tag, hid }
    let form = null;
    let anchor = null; // open <a>: link object collecting text
    let label = null; // { for, text, fields }
    let option = null; // { value, text, selected }
    let select = null;
    let button = null;

    const inheritedHidden = () => {
        for (let i = stack.length - 1; i >= 0; i--) if (stack[i].hid) return stack[i].hid;
        return null;
    };
    const visOf = (tag, a) => {
        const own = ownHidden(tag, a);
        if (own && own.vis === 'hidden') return own;
        const up = inheritedHidden();
        if (up && up.vis === 'hidden') return { vis: 'hidden', why: `inside hidden <${up.tag}> (${up.why})` };
        if (own) return own;
        if (up) return { vis: 'likely', why: `inside <${up.tag}> (${up.why})` };
        return { vis: 'visible', why: '' };
    };
    const addLink = (raw, tag, a, extra = {}) => {
        if (links.length >= MAX_LINKS) return null;
        const r = String(raw || '').trim();
        if (!r || /^(javascript|mailto|tel|data|blob|about|sms|callto):/i.test(r) || r.startsWith('#')) return null;
        const url = normUrl(r, base);
        if (!url) return null;
        const v = visOf(tag, a);
        const l = { url, raw: _clip(r, 500), tag, text: '', rel: a.rel ? String(a.rel).toLowerCase() : undefined, vis: v.vis, why: v.why || undefined, ...extra };
        if (a.title) l.text = _clip(_squash(a.title), TEXT_MAX);
        links.push(l);
        return l;
    };
    const addText = (t) => {
        if (!t) return;
        const s = decodeEntities(t);
        if (anchor && anchor.text.length < TEXT_MAX) anchor.text = _clip(_squash(`${anchor.text} ${s}`), TEXT_MAX);
        if (label && label.text.length < TEXT_MAX) label.text = _clip(_squash(`${label.text} ${s}`), TEXT_MAX);
        if (option) option.text = _clip(_squash(`${option.text} ${s}`), 80);
        if (button && button.text.length < TEXT_MAX) button.text = _clip(_squash(`${button.text} ${s}`), TEXT_MAX);
    };
    const addField = (tag, a) => {
        const v = visOf(tag, a);
        const type = tag === 'input' ? String(a.type || 'text').toLowerCase() : tag === 'button' ? String(a.type || 'submit').toLowerCase() : tag;
        const f = {
            tag, type, name: a.name || '', id: a.id || '',
            value: a.value != null ? _clip(a.value, VALUE_MAX) : undefined,
            placeholder: a.placeholder ? _clip(a.placeholder, 120) : undefined,
            label: a['aria-label'] ? _clip(_squash(a['aria-label']), TEXT_MAX) : '',
            required: 'required' in a || undefined, disabled: 'disabled' in a || undefined, readonly: 'readonly' in a || undefined,
            autocomplete: a.autocomplete || undefined,
            checked: (type === 'checkbox' || type === 'radio') && 'checked' in a ? true : undefined,
            vis: v.vis, why: v.why || undefined,
        };
        if (label) label.fields.push(f);
        const owner = a.form ? null : form || orphan;
        if (a.form) late.push([a.form, f]);
        else if (owner.fields.length < MAX_FIELDS) owner.fields.push(f);
        return f;
    };

    let i = 0;
    let textFrom = 0;
    const n = src.length;
    while (i < n) {
        const lt = src.indexOf('<', i);
        if (lt < 0) break;
        const c = src.charCodeAt(lt + 1);
        if (src.startsWith('<!--', lt)) {
            addText(src.slice(textFrom, lt));
            const e = src.indexOf('-->', lt + 4);
            i = textFrom = e < 0 ? n : e + 3;
            continue;
        }
        if (c === 33 || c === 63) { // <! <?
            addText(src.slice(textFrom, lt));
            const e = src.indexOf('>', lt + 2);
            i = textFrom = e < 0 ? n : e + 1;
            continue;
        }
        const closing = c === 47;
        const nameStart = closing ? lt + 2 : lt + 1;
        const nc = src.charCodeAt(nameStart) | 32;
        if (!(nc >= 97 && nc <= 122)) { i = lt + 1; continue; }
        // Tag end, skipping quoted attribute values.
        let j = nameStart;
        let q = 0;
        for (; j < n; j++) {
            const ch = src.charCodeAt(j);
            if (q) { if (ch === q) q = 0; } else if ((ch === 34 || ch === 39) && /[=\s]/.test(src[j - 1])) q = ch;
            else if (ch === 62) break;
        }
        if (j >= n) break;
        addText(src.slice(textFrom, lt));
        const inner = src.slice(nameStart, j);
        const nm = /^[a-zA-Z][\w:-]*/.exec(inner);
        const tag = nm[0].toLowerCase();
        i = textFrom = j + 1;

        if (closing) {
            if (tag === 'a' && anchor) anchor = null;
            else if (tag === 'label' && label) {
                for (const f of label.fields) if (!f.label && label.text) f.label = label.text;
                if (label.for && label.text) labelsFor.set(label.for, label.text);
                label = null;
            } else if (tag === 'option' && option) option = null;
            else if (tag === 'button' && button) { if (!button.f.label) button.f.label = button.text; button = null; }
            else if (tag === 'select') { option = null; select = null; }
            else if (tag === 'form') form = null;
            let k = stack.length - 1;
            while (k >= 0 && stack[k].tag !== tag) k--;
            if (k >= 0) stack.length = k;
            continue;
        }

        const a = _attrs(inner.slice(nm[0].length));
        const selfClose = inner.endsWith('/');
        switch (tag) {
        case 'base':
            if (a.href && base === docUrl) base = normUrl(a.href, docUrl) || docUrl;
            break;
        case 'a': case 'area': {
            const l = a.href != null ? addLink(a.href, tag, a, 'nofollow' in a || /nofollow/i.test(a.rel || '') ? { nofollow: true } : {}) : null;
            if (tag === 'a') anchor = l;
            break;
        }
        case 'link': {
            const rels = String(a.rel || '').toLowerCase().split(/\s+/);
            const rel = rels.find((r) => LINK_RELS.has(r));
            if (rel && a.href) addLink(a.href, `link:${rel}`, a);
            break;
        }
        case 'iframe': case 'frame':
            if (a.src) addLink(a.src, tag, a);
            break;
        case 'img':
            if (anchor && a.alt) addText(` ${a.alt} `);
            break;
        case 'form': {
            if (form || forms.length >= MAX_FORMS) break;
            const v = visOf(tag, a);
            const action = a.action != null && String(a.action).trim() ? normUrl(String(a.action).trim(), base) : normUrl(docUrl);
            form = {
                idx: forms.length, id: a.id || '', name: a.name || '', action,
                method: String(a.method || 'get').toUpperCase(), enctype: a.enctype || undefined,
                target: a.target || undefined, autocomplete: a.autocomplete || undefined, novalidate: 'novalidate' in a || undefined,
                vis: v.vis, why: v.why || undefined, fields: [],
            };
            forms.push(form);
            if (a.id) formById.set(a.id, form);
            if (action) addLink(a.action || docUrl, 'form', a, { method: form.method });
            break;
        }
        case 'label':
            label = { for: a.for || '', text: '', fields: [] };
            break;
        default:
            break;
        }
        if (FIELD_TAGS.has(tag)) {
            const f = addField(tag, a);
            if (tag === 'select') { f.options = []; option = null; select = f; }
            if (tag === 'button') button = { f, text: '' };
            if (a.formaction) addLink(a.formaction, 'form', a, { method: String(a.formmethod || form?.method || 'GET').toUpperCase() });
        }
        if (tag === 'option') {
            if (select && select.options.length < 50) {
                option = { value: a.value, text: '', selected: 'selected' in a || undefined };
                select.options.push(option);
            }
        }
        if (RAW.has(tag) && !selfClose) {
            const re = new RegExp(`</${tag}\\s*>`, 'ig');
            re.lastIndex = i;
            const m = re.exec(src);
            const end = m ? m.index : n;
            const text = src.slice(i, end);
            if (tag === 'title' && !title) title = _clip(_squash(decodeEntities(text)), 300);
            if (tag === 'textarea') {
                const f = (form || orphan).fields.at(-1);
                if (f && f.tag === 'textarea') f.value = _clip(decodeEntities(text), VALUE_MAX) || undefined;
            }
            i = textFrom = m ? m.index + m[0].length : n;
            continue;
        }
        if (!VOID.has(tag) && !selfClose && stack.length < 512) {
            const hid = ownHidden(tag, a);
            stack.push({ tag, hid: hid ? { ...hid, tag } : null });
        }
    }

    for (const [fid, f] of late) {
        const owner = formById.get(fid) || orphan;
        if (owner.fields.length < MAX_FIELDS) owner.fields.push(f);
    }
    if (orphan.fields.length) forms.push(orphan);
    for (const fm of forms) {
        for (const f of fm.fields) {
            if (!f.label && f.id && labelsFor.has(f.id)) f.label = labelsFor.get(f.id);
            if (f.options) for (const o of f.options) if (o.value === undefined) o.value = o.text;
            if (!f.label) delete f.label;
        }
    }
    for (const l of links) if (!l.text) delete l.text;
    return { title, base: base !== docUrl ? base : undefined, links, forms };
}

function _body(e) {
    const b = e?.responseBody;
    if (b == null) return '';
    const s = String(b);
    if (s.startsWith('__b64__:')) {
        try { return Buffer.from(s.slice(8), 'base64').toString('utf8'); } catch { return ''; }
    }
    return s;
}

function _location(h) {
    if (!h) return '';
    const k = Object.keys(h).find((x) => x.toLowerCase() === 'location');
    const v = k ? h[k] : '';
    return String(Array.isArray(v) ? v[0] : v || '');
}

function _hostOf(u) { try { return new URL(u).hostname; } catch { return ''; } }

/** Session-level scan state: opened documents and the parsed pages. */
function newState() {
    return { after: 0, visited: new Map(), pages: new Map(), requests: new Map(), scanned: 0 };
}

/** Read new entries of `src` (SessionLog / SessionIndex) into `st`. */
function updateState(st, src) {
    for (;;) {
        const batch = src.list(st.after, 2000);
        if (!batch.length) break;
        for (const s of batch) {
            st.after = s.seq;
            if (s.kind !== 'request' || !s.url) continue;
            const url = normUrl(s.url);
            if (!url) continue;
            const host = _hostOf(url);
            st.requests.set(host, (st.requests.get(host) || 0) + 1);
            if (s.type !== 'Document') continue;
            const v = st.visited.get(url) || { url, count: 0, methods: [] };
            v.count++;
            v.seq = s.seq; v.ts = s.ts; v.status = s.status;
            if (s.method && !v.methods.includes(s.method)) v.methods.push(s.method);
            if (s.dns) v.dns = s.dns.ip;
            st.visited.set(url, v);
            const isRedirect = s.status >= 300 && s.status < 400;
            const isHtml = /html|xhtml/i.test(String(s.mime || ''));
            if (!isRedirect && !isHtml) continue;
            const full = src.get(s.seq);
            if (!full) continue;
            if (isRedirect) {
                const loc = _location(full.responseHeaders);
                const to = loc ? normUrl(loc, url) : '';
                v.redirect = to || undefined;
                const prev = st.pages.get(url);
                if (to && !prev) st.pages.set(url, { seq: s.seq, title: '', links: [{ url: to, raw: loc, tag: 'redirect', vis: 'visible' }], forms: [] });
                continue;
            }
            const html = _body(full);
            if (!html) continue;
            st.scanned++;
            st.pages.set(url, { seq: s.seq, ...extractPage(html, url) });
        }
    }
    return st;
}

/** Host belongs to the site: exact, or with `subs` the site's base domain and all its subdomains. */
function _inSite(site, subs) {
    const baseDom = site.replace(/^www\./, '');
    return (h) => h === site || (subs && (h === baseDom || h.endsWith(`.${baseDom}`)));
}

/** Hosts seen in the session: requests, opened pages and links pointing to them. */
function listSites(st) {
    const m = new Map();
    const row = (h) => { let r = m.get(h); if (!r) { r = { host: h, opened: 0, linked: 0, requests: 0 }; m.set(h, r); } return r; };
    for (const [h, n] of st.requests) row(h).requests = n;
    for (const v of st.visited.values()) { const h = _hostOf(v.url); if (h) row(h).opened++; }
    const seen = new Set();
    for (const p of st.pages.values()) {
        for (const l of p.links) {
            if (seen.has(l.url) || st.visited.has(l.url)) continue;
            seen.add(l.url);
            const h = _hostOf(l.url);
            if (h) row(h).linked++;
        }
    }
    return [...m.values()].filter((r) => r.opened || r.linked).sort((a, b) => (b.opened - a.opened) || (b.linked - a.linked) || a.host.localeCompare(b.host));
}

/**
 * The map of one site: pages (opened or only linked), grouped forms, external hosts.
 * @param {ReturnType<typeof newState>} st
 * @param {string} site - host
 * @param {{ subs?: boolean }} [o]
 */
function siteView(st, site, o = {}) {
    const inSite = _inSite(String(site || '').toLowerCase(), !!o.subs);
    const pages = new Map();
    const page = (url) => {
        let p = pages.get(url);
        if (!p) {
            let u; try { u = new URL(url); } catch { return null; }
            p = { url, host: u.hostname, path: u.pathname, query: u.search || undefined, opened: false, refs: 0, hiddenRefs: 0, from: [], kinds: [] };
            if (FILE_EXT_RE.test(u.pathname)) p.file = true;
            pages.set(url, p);
        }
        return p;
    };
    for (const v of st.visited.values()) {
        if (!inSite(_hostOf(v.url))) continue;
        const p = page(v.url);
        if (!p) continue;
        Object.assign(p, { opened: true, status: v.status, seq: v.seq, ts: v.ts, count: v.count, methods: v.methods, redirect: v.redirect, dns: v.dns });
    }
    const external = new Map();
    const formGroups = new Map();
    for (const [from, pg] of st.pages) {
        const fromIn = inSite(_hostOf(from));
        if (fromIn) {
            const p = page(from);
            if (p) { p.title = pg.title || undefined; p.out = pg.links.length; p.forms = pg.forms.length; }
        }
        for (const l of pg.links) {
            const h = _hostOf(l.url);
            if (!inSite(h)) {
                if (fromIn) external.set(h, (external.get(h) || 0) + 1);
                continue;
            }
            const p = page(l.url);
            if (!p) continue;
            p.refs++;
            if (l.vis !== 'visible') p.hiddenRefs++;
            if (p.from.length < 20 && !p.from.includes(from)) p.from.push(from);
            if (!p.kinds.includes(l.tag)) p.kinds.push(l.tag);
            if (!p.text && l.text) p.text = l.text;
            if (l.nofollow) p.nofollow = true;
            if (l.method && l.method !== 'GET') p.post = true;
        }
        if (!fromIn) continue;
        for (const f of pg.forms) {
            const key = `${f.idx < 0 ? 'orphan' : 'form'}|${f.method}|${f.action}|${f.fields.map((x) => `${x.tag}:${x.type}:${x.name}`).join(',')}`;
            const g = formGroups.get(key);
            if (g) { if (g.pages.length < 50) g.pages.push({ url: from, seq: pg.seq }); g.pageCount++; continue; }
            const hidden = f.fields.filter((x) => x.vis === 'hidden').length;
            const likely = f.fields.filter((x) => x.vis === 'likely').length;
            formGroups.set(key, {
                key, ...f, page: from, seq: pg.seq, pages: [{ url: from, seq: pg.seq }], pageCount: 1,
                counts: { fields: f.fields.length, hidden, likely, visible: f.fields.length - hidden - likely },
            });
        }
    }
    const list = [...pages.values()].sort((a, b) => a.host.localeCompare(b.host) || a.path.localeCompare(b.path) || String(a.query || '').localeCompare(String(b.query || '')));
    const forms = [...formGroups.values()].sort((a, b) => (b.counts.hidden + b.counts.likely) - (a.counts.hidden + a.counts.likely) || a.action.localeCompare(b.action));
    for (const f of forms) delete f.key;
    return {
        site, subs: !!o.subs,
        stats: {
            pages: list.length, opened: list.filter((p) => p.opened).length, notOpened: list.filter((p) => !p.opened).length,
            forms: forms.length, hiddenFields: forms.reduce((s, f) => s + f.counts.hidden, 0), likelyHidden: forms.reduce((s, f) => s + f.counts.likely, 0),
            documents: st.scanned,
        },
        pages: list.slice(0, 20000),
        truncated: list.length > 20000 || undefined,
        forms,
        external: [...external].sort((a, b) => b[1] - a[1]).slice(0, 300).map(([host, links]) => ({ host, links })),
    };
}

/** Per-session scan states (small LRU); the current session is updated on every call. */
class SiteMapCache {
    constructor(max = 4) { this.max = max; this.states = new Map(); }

    state(sessionId, src) {
        let st = this.states.get(sessionId);
        if (st && st.src !== src) st = null;
        if (!st) {
            st = Object.assign(newState(), { src });
            this.states.set(sessionId, st);
            while (this.states.size > this.max) this.states.delete(this.states.keys().next().value);
        } else {
            this.states.delete(sessionId);
            this.states.set(sessionId, st);
        }
        return updateState(st, src);
    }
}

module.exports = { extractPage, ownHidden, normUrl, newState, updateState, listSites, siteView, SiteMapCache, decodeEntities };
