'use strict';

/**
 * Omnibox input classifier — the ONE place that decides what typed text means.
 * Dependency-free so the main process (utils.js, tabs-ipc.js) and the shell renderer
 * (browser.html <script>) share exactly the same rules.
 *
 * Exposed as `module.exports` (CommonJS) and `window.CupNetOmniboxInput` (browser).
 */
(function omniboxInputFactory(root) {
    /** Internal page aliases → page name (see cupnet-runtime.getInternalPageUrl). */
    const INTERNAL_ALIASES = {
        'cupnet://settings': 'settings',
        'cupnet:settings': 'settings',
        'cupnet://guide': 'guide',
        'cupnet:guide': 'guide',
        'cupnet://identity-check': 'identity-check',
        'cupnet:identity-check': 'identity-check',
        'cupnet://identity': 'identity-check',
        'cupnet://home': 'new-tab',
        'cupnet:home': 'new-tab',
        'cupnet://new-tab': 'new-tab',
        'cupnet:new-tab': 'new-tab',
        'cupnet://newtab': 'new-tab',
        'cupnet:newtab': 'new-tab',
        'cupnet://history': 'history',
        'cupnet:history': 'history',
    };

    /** Hosts / suffixes that are almost always plain-HTTP dev or LAN targets. */
    const HTTP_HOST_SUFFIXES = ['.local', '.localhost', '.lan', '.internal', '.home', '.test', '.intranet'];

    const RE_SCHEME_URL = /^[a-z][a-z\d+\-.]*:\/\//i;
    const RE_HOST_LABELS = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*$/i;
    const RE_IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
    const RE_IPV6_LITERAL = /^\[[0-9a-f:.]+\]$/i;
    const RE_PORT = /^\d{1,5}$/;

    /** Normalise an alias like `cupnet://Settings/` → `cupnet://settings`. */
    function resolveInternalAlias(text) {
        const s = String(text || '').trim().toLowerCase().replace(/\/+$/, '');
        return INTERNAL_ALIASES[s] || null;
    }

    function isPrivateIpv4(ip) {
        const p = ip.split('.').map(Number);
        if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
        if (p[0] === 192 && p[1] === 168) return true;
        if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
        if (p[0] === 169 && p[1] === 254) return true;
        return false;
    }

    /**
     * Split `host[:port]` off a text like `example.com:8080/path?x`.
     * @returns {{ hostPort: string, host: string, port: string, rest: string }|null}
     */
    function splitHostPort(text) {
        const m = /^([^/?#]+)(.*)$/.exec(text);
        if (!m) return null;
        const hostPort = m[1];
        const rest = m[2] || '';
        let host = hostPort;
        let port = '';
        if (hostPort.startsWith('[')) {
            const close = hostPort.indexOf(']');
            if (close < 0) return null;
            host = hostPort.slice(0, close + 1);
            const tail = hostPort.slice(close + 1);
            if (tail) {
                if (!tail.startsWith(':') || !RE_PORT.test(tail.slice(1))) return null;
                port = tail.slice(1);
            }
        } else {
            const colon = hostPort.lastIndexOf(':');
            if (colon >= 0) {
                const maybePort = hostPort.slice(colon + 1);
                if (!RE_PORT.test(maybePort)) return null;
                host = hostPort.slice(0, colon);
                port = maybePort;
            }
        }
        if (!host) return null;
        return { hostPort, host, port, rest };
    }

    function hostLooksLikeDomain(host) {
        if (!RE_HOST_LABELS.test(host)) return false;
        const labels = host.split('.');
        if (labels.length < 2) return false;
        const tld = labels[labels.length - 1];
        // TLD must be alphabetic and ≥ 2 chars (so `3.14` or `v1.2` stay searches).
        return /^[a-z]{2,63}$/i.test(tld);
    }

    function hostPrefersHttp(host) {
        const h = host.toLowerCase();
        if (h === 'localhost' || h.startsWith('localhost.')) return true;
        if (RE_IPV6_LITERAL.test(h)) return true;
        if (RE_IPV4.test(h)) return isPrivateIpv4(h);
        return HTTP_HOST_SUFFIXES.some((suf) => h.endsWith(suf));
    }

    function tryUrl(str) {
        try {
            const u = new URL(str);
            return u.href;
        } catch {
            return null;
        }
    }

    /**
     * Classify omnibox text.
     * @param {string} input
     * @param {{ base?: string }} [opts] base = current tab URL (for site-relative `/path`)
     * @returns {{ kind: 'empty'|'command'|'internal'|'url'|'search', url?: string, query?: string, internal?: string, scheme?: 'typed'|'added' }}
     */
    function classifyOmniboxInput(input, opts) {
        const base = opts && typeof opts.base === 'string' ? opts.base : '';
        const s = String(input == null ? '' : input).trim();
        if (!s) return { kind: 'empty' };
        if (s.startsWith('>')) return { kind: 'command', query: s.slice(1).trim() };

        const internal = resolveInternalAlias(s);
        if (internal) return { kind: 'internal', internal, url: s.toLowerCase() };

        if (s === 'about:blank') return { kind: 'url', url: 'about:blank', scheme: 'typed' };

        if (RE_SCHEME_URL.test(s)) {
            const href = tryUrl(s);
            if (href) return { kind: 'url', url: s, scheme: 'typed' };
            return { kind: 'search', query: s };
        }

        if (/\s/.test(s)) return { kind: 'search', query: s };

        // Site-relative path against the current page.
        if (s.startsWith('/')) {
            if (base && /^https?:\/\//i.test(base)) {
                try {
                    const abs = new URL(s, base).href;
                    return { kind: 'url', url: abs, scheme: 'added' };
                } catch { /* fall through */ }
            }
            return { kind: 'search', query: s };
        }

        const parts = splitHostPort(s);
        if (parts) {
            const { host, port, rest } = parts;
            const lower = host.toLowerCase();
            const isIpv6 = RE_IPV6_LITERAL.test(host);
            const isIpv4 = RE_IPV4.test(host);
            const isLocalhost = lower === 'localhost' || lower.startsWith('localhost.');
            const isLabels = RE_HOST_LABELS.test(host);
            const hasDot = host.includes('.');
            const hasPath = rest.length > 0 && rest.startsWith('/');

            let treatAsUrl = false;
            if (isIpv6 || isIpv4 || isLocalhost) treatAsUrl = true;
            else if (isLabels && port) treatAsUrl = true;           // host:port (intranet / dev)
            else if (isLabels && !hasDot && hasPath) treatAsUrl = true; // intranet/path
            else if (hostLooksLikeDomain(host)) treatAsUrl = true;  // word.tld[/…]

            if (treatAsUrl) {
                // Single-label hosts (intranet names, docker services) are plain HTTP in practice.
                const scheme = (hostPrefersHttp(host) || (isLabels && !hasDot)) ? 'http' : 'https';
                const withScheme = `${scheme}://${s}`;
                if (tryUrl(withScheme)) return { kind: 'url', url: withScheme, scheme: 'added' };
            }
        }

        return { kind: 'search', query: s };
    }

    function applySearchEngineTemplate(template, query) {
        const t = String(template || '');
        const enc = encodeURIComponent(String(query == null ? '' : query));
        if (t.includes('{q}')) return t.split('{q}').join(enc);
        return t + enc;
    }

    /** True when the text would navigate rather than search. */
    function looksLikeUrl(text, opts) {
        const c = classifyOmniboxInput(text, opts);
        return c.kind === 'url' || c.kind === 'internal';
    }

    const mod = {
        INTERNAL_ALIASES,
        classifyOmniboxInput,
        resolveInternalAlias,
        looksLikeUrl,
        applySearchEngineTemplate,
        splitHostPort,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = mod;
    if (root && typeof root === 'object') root.CupNetOmniboxInput = mod;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
