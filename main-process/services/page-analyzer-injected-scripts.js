'use strict';

module.exports._analyzeFormsScript = `function(){
    var forms = document.querySelectorAll('form');
    var result = [];
    forms.forEach(function(form, fi) {
        var f = { index: fi, id: form.id||'', name: form.name||'', action: form.action||'', method: (form.method||'GET').toUpperCase(), className: form.className||'', fields: [] };
        var els = form.elements;
        for (var i=0; i<els.length; i++) {
            var el = els[i];
            var tag = el.tagName.toLowerCase();
            if (tag==='fieldset') continue;
            var cs = window.getComputedStyle(el);
            var visible = cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0' && el.offsetWidth > 0;
            f.fields.push({
                index: i, tag: tag, type: el.type||'', name: el.name||'', id: el.id||'',
                value: (el.type==='file') ? '' : (el.value||'').substring(0,500),
                placeholder: el.placeholder||'',
                hidden: el.type==='hidden', readonly: el.readOnly||false, disabled: el.disabled||false,
                required: el.required||false, visible: visible,
                className: (el.className||'').substring(0,100),
                options: tag==='select' ? Array.from(el.options).map(function(o){return{value:o.value,text:o.text,selected:o.selected}}).slice(0,50) : undefined
            });
        }
        result.push(f);
    });
    return result;
}`;

module.exports._analyzeCaptchaScript = `function(){
    var r = { recaptcha: [], hcaptcha: [], turnstile: [], other: [], pageUrl: location.href };
    function addTurnstile(item){
        if(!item) return;
        var sk = String(item.sitekey || '');
        var frame = String(item.iframeSrc || '');
        var ex = r.turnstile.some(function(x){
            return String(x.sitekey||'')===sk && String(x.iframeSrc||'')===frame && String(x.selector||'')===String(item.selector||'');
        });
        if(!ex) r.turnstile.push(item);
    }

    /* ── reCAPTCHA v2 (widget divs) ── */
    document.querySelectorAll('.g-recaptcha, [data-sitekey]').forEach(function(el){
        var sk = el.getAttribute('data-sitekey')||'';
        if (!sk) { var s=document.querySelector('script[src*="recaptcha"]'); if(s){var m=(s.src||'').match(/[?&]render=([^&]+)/);if(m)sk=m[1];} }
        r.recaptcha.push({ version:'v2', sitekey:sk, action:'', dataS:el.getAttribute('data-s')||'',
            callback:el.getAttribute('data-callback')||'', theme:el.getAttribute('data-theme')||'light',
            size:el.getAttribute('data-size')||'normal', selector:'.g-recaptcha', iframe:false });
    });

    /* ── reCAPTCHA v3 (script-based) ── */
    document.querySelectorAll('script[src*="recaptcha/api.js"]').forEach(function(s){
        var m=(s.src||'').match(/[?&]render=([^&]+)/);
        if(m && m[1]!=='explicit'){
            var exists=r.recaptcha.some(function(x){return x.sitekey===m[1]&&x.version==='v3'});
            if(!exists) r.recaptcha.push({version:'v3',sitekey:m[1],action:'',dataS:'',callback:'',theme:'',size:'invisible',selector:'script[src*=recaptcha]',iframe:false});
        }
    });

    /* ── reCAPTCHA v2 enterprise ── */
    document.querySelectorAll('script[src*="recaptcha/enterprise.js"]').forEach(function(s){
        var m=(s.src||'').match(/[?&]render=([^&]+)/);
        if(m){
            var exists=r.recaptcha.some(function(x){return x.sitekey===m[1]});
            if(!exists) r.recaptcha.push({version:'enterprise',sitekey:m[1],action:'',dataS:'',callback:'',theme:'',size:'',selector:'script[src*=enterprise]',iframe:false});
        }
    });

    /* ── hCaptcha ── */
    document.querySelectorAll('.h-captcha, [data-hcaptcha-widget-id]').forEach(function(el){
        r.hcaptcha.push({ sitekey:el.getAttribute('data-sitekey')||'', theme:el.getAttribute('data-theme')||'',
            size:el.getAttribute('data-size')||'normal', selector:'.h-captcha', iframe:false });
    });

    /* ── Cloudflare Turnstile (div-based) ── */
    document.querySelectorAll('.cf-turnstile, [data-turnstile-widget-id]').forEach(function(el){
        r.turnstile.push({ sitekey:el.getAttribute('data-sitekey')||'', action:el.getAttribute('data-action')||'',
            cData:el.getAttribute('data-cdata')||'', theme:el.getAttribute('data-theme')||'auto',
            size:el.getAttribute('data-size')||'normal', selector:'.cf-turnstile', iframe:false });
    });

    /* ── iframe-based detection (reCAPTCHA, hCaptcha, Turnstile / challenge-platform) ── */
    document.querySelectorAll('iframe').forEach(function(f){
        var s=f.src||'';
        if(s.includes('google.com/recaptcha') || s.includes('recaptcha/api2') || s.includes('recaptcha/enterprise')){
            var m=s.match(/[?&]k=([^&]+)/);
            var sk=m?m[1]:'';
            var isV3=s.includes('size=invisible');
            var exists=r.recaptcha.some(function(x){return x.sitekey===sk});
            if(!exists) r.recaptcha.push({version:isV3?'v3':'v2',sitekey:sk,action:'',dataS:'',callback:'',theme:'',size:isV3?'invisible':'normal',selector:'iframe',iframeSrc:s.substring(0,300),iframe:true});
        }
        if(s.includes('hcaptcha.com')){
            var m2=s.match(/[?&]sitekey=([^&]+)/);
            var exists2=r.hcaptcha.some(function(x){return x.sitekey===(m2?m2[1]:'')});
            if(!exists2) r.hcaptcha.push({sitekey:m2?m2[1]:'',theme:'',size:'normal',selector:'iframe',iframeSrc:s.substring(0,300),iframe:true});
        }
        if(s.includes('challenges.cloudflare.com') || s.includes('turnstile')){
            var m3=s.match(/\\/([0-9a-zA-Z_-]{20,})/);
            var sk3=m3?m3[1]:'';
            if(!sk3){var p=s.split('/');for(var i=0;i<p.length;i++){if(p[i]&&p[i].startsWith('0x')){sk3=p[i];break;}}}
            var exists3=r.turnstile.some(function(x){return x.sitekey===sk3&&x.iframeSrc===s.substring(0,300)});
            if(!exists3) r.turnstile.push({sitekey:sk3,action:'managed',cData:'',theme:'auto',size:'normal',selector:'iframe',iframeSrc:s.substring(0,300),iframe:true});
        }
    });

    /* ── Check scripts for dynamically loaded captchas ── */
    document.querySelectorAll('script').forEach(function(s){
        var src=s.src||'';
        if(src.includes('hcaptcha.com/1/api.js')){
            var m=src.match(/[?&]sitekey=([^&]+)/);
            if(m&&!r.hcaptcha.some(function(x){return x.sitekey===m[1]})){
                r.hcaptcha.push({sitekey:m[1],theme:'',size:'normal',selector:'script',iframe:false});
            }
        }
        if(src.includes('challenges.cloudflare.com/turnstile')){
            if(!r.turnstile.length) addTurnstile({sitekey:'',action:'',cData:'',theme:'auto',size:'normal',selector:'script[src*=turnstile]',iframe:false});
        }

        var txt = '';
        try { txt = (s.textContent || '').slice(0, 40000); } catch {}
        if(!txt) return;
        if(txt.indexOf('turnstile') === -1 && txt.indexOf('sitekey') === -1) return;
        var mSitekey = txt.match(/sitekey\\s*[:=]\\s*['"]([0-9a-zA-Z_-]{10,})['"]/i);
        if(!mSitekey){
            mSitekey = txt.match(/['"]sitekey['"]\\s*[:,]\\s*['"]([0-9a-zA-Z_-]{10,})['"]/i);
        }
        var mAction = txt.match(/action\\s*[:=]\\s*['"]([^'"]{1,80})['"]/i);
        var mCdata = txt.match(/cData\\s*[:=]\\s*['"]([^'"]{1,200})['"]/i);
        if(mSitekey && mSitekey[1]){
            addTurnstile({
                sitekey: mSitekey[1] || '',
                action: mAction ? mAction[1] : '',
                cData: mCdata ? mCdata[1] : '',
                theme: 'auto',
                size: 'normal',
                selector: 'script:inline:turnstile',
                iframe: false
            });
        }
    });

    r.found = r.recaptcha.length>0 || r.hcaptcha.length>0 || r.turnstile.length>0;
    r.totalCount = r.recaptcha.length + r.hcaptcha.length + r.turnstile.length;
    return r;
}`;

module.exports._analyzeMetaScript = `function(){
    var r = { title: document.title||'', url: location.href, charset: document.characterSet||'', doctype: document.doctype?document.doctype.name:'',
        meta: [], links: [], scripts: { inline:0, external:0, srcs:[] }, iframes: [] };
    document.querySelectorAll('meta').forEach(function(m){
        r.meta.push({ name: m.name||m.getAttribute('property')||m.httpEquiv||'', content: (m.content||'').substring(0,200) });
    });
    document.querySelectorAll('link[rel]').forEach(function(l){
        r.links.push({ rel: l.rel, href: (l.href||'').substring(0,200), type: l.type||'' });
    });
    document.querySelectorAll('script').forEach(function(s){ if(s.src){r.scripts.external++;r.scripts.srcs.push(s.src.substring(0,200))}else{r.scripts.inline++} });
    document.querySelectorAll('iframe').forEach(function(f){ r.iframes.push({ src: (f.src||'').substring(0,200), id: f.id||'', name: f.name||'' }); });
    return r;
}`;

module.exports._analyzeEndpointsScript = `async function(){
    function abs(url) { try { return new URL(url, location.href).toString(); } catch { return null; } }
    function extractApiEndpoints(jsCode) {
        var patterns = [
            /["'\`](\\/api\\/[^"'\\\`\\s]+)["'\\\`]/g,
            /["'\`](\\/auth[^"'\\\`\\s]*)["'\\\`]/g,
            /["'\`](\\/login[^"'\\\`\\s]*)["'\\\`]/g,
            /["'\`](\\/otp[^"'\\\`\\s]*)["'\\\`]/g,
            /["'\`](\\/verify[^"'\\\`\\s]*)["'\\\`]/g,
            /["'\`](\\/user[^"'\\\`\\s]*)["'\\\`]/g,
            /["'\`](\\/appointment[^"'\\\`\\s]*)["'\\\`]/g,
            /["'\`](\\/slot[^"'\\\`\\s]*)["'\\\`]/g,
            /["'\`](\\/queue[^"'\\\`\\s]*)["'\\\`]/g,
            /["'\`](\\/applicant[^"'\\\`\\s]*)["'\\\`]/g,
            /fetch\\(["'\\\`]([^"'\\\`]+)["'\\\`]/g,
            /axios\\.[a-z]+\\(["'\\\`]([^"'\\\`]+)["'\\\`]/g,
            /\\.post\\(["'\\\`]([^"'\\\`]+)["'\\\`]/g,
            /\\.get\\(["'\\\`]([^"'\\\`]+)["'\\\`]/g,
            /["'\`]((?:https?:\\/\\/[^"'\\\`\\s]+)?\\/[^"'\\\`\\s]*(?:api|auth|otp|appointment|slot|queue|user|profile|invoice|payment|verify|login)[^"'\\\`\\s]*)["'\\\`]/gi
        ];
        var found = new Set();
        var src = String(jsCode || '');
        // Minified bundles often store URLs as escaped strings (e.g. "\\/api\\/v1").
        var normalized = src.replace(/\\\\\\//g, '/').replace(/\\\\u002f/gi, '/');
        var variants = [src, normalized];
        for (var v = 0; v < variants.length; v++) {
            var code = variants[v];
            for (var i = 0; i < patterns.length; i++) {
                var p = patterns[i], m;
                p.lastIndex = 0;
                while ((m = p.exec(code)) !== null) found.add(m[1]);
            }
        }
        return Array.from(found);
    }
    function classifyEndpoint(ep) {
        var s = String(ep || '').toLowerCase();
        if (s.includes('/auth') || s.includes('/signin') || s.includes('/signup') || s.includes('/login')) return 'auth';
        if (s.includes('/otp') || s.includes('verifyotp') || s.includes('phone-otp')) return 'otp';
        if (s.includes('/slot') || s.includes('/appointment') || s.includes('/reserve')) return 'booking';
        if (s.includes('/payment') || s.includes('/invoice') || s.includes('/tran_')) return 'payment';
        if (s.includes('/profile') || s.includes('/user')) return 'profile';
        if (s.startsWith('/')) return 'api-path';
        return 'other';
    }
    function isLikelyApiEndpoint(ep) {
        if (!ep) return false;
        var s = String(ep).trim();
        if (!s) return false;
        var l = s.toLowerCase();
        if (l.startsWith('/assets/')) return false;
        if (l.startsWith('/cdn-cgi/')) return false;
        if (/\\.(png|jpg|jpeg|gif|svg|webp|css|js|map|woff2?|ttf|eot)(\\?|$)/i.test(l)) return false;
        if (l.startsWith('http://') || l.startsWith('https://')) {
            try { l = new URL(l).pathname.toLowerCase(); } catch {}
        }
        if (/^\\/(api|auth|otp|appointment|slot|queue|user|profile|invoice|payment|file|forgot-password|verify|login)\\b/.test(l)) return true;
        if (/\\/(api|auth|otp|appointment|slot|queue|invoice|payment|verify|login)\\b/.test(l)) return true;
        if (/\\$\\{[^}]+\\}/.test(s)) return true;
        return false;
    }

    var started = Date.now();
    var r = {
        pageUrl: location.href,
        statusHint: (document.body && /just a moment/i.test(document.body.innerText || '')) ? 'challenge' : 'ok',
        scriptUrls: [],
        scannedScripts: [],
        endpoints: [],
        endpointsDetailed: [],
        categoryCounts: {},
        durationMs: 0
    };
    var endpointSet = new Set();
    var endpointSources = {};
    var endpointHits = {};
    var endpointMeta = {};
    function addEndpoint(ep, source, line, preview) {
        if (!ep) return;
        endpointSet.add(ep);
        if (!endpointSources[ep]) endpointSources[ep] = new Set();
        if (source) endpointSources[ep].add(source);
        if (!endpointMeta[ep]) endpointMeta[ep] = { methods: new Set(), payloadKeys: new Set() };
        if (!endpointHits[ep]) endpointHits[ep] = [];
        if (source || line || preview) {
            var key = (source || '') + '|' + (line || 0) + '|' + (preview || '');
            var exists = endpointHits[ep].some(function(h){
                return ((h.source || '') + '|' + (h.line || 0) + '|' + (h.preview || '')) === key;
            });
            if (!exists) {
                endpointHits[ep].push({
                    source: source || '',
                    line: line || 0,
                    preview: (preview || '').slice(0, 220),
                });
            }
        }
    }

    function addMethod(ep, method) {
        if (!ep || !method) return;
        if (!endpointMeta[ep]) endpointMeta[ep] = { methods: new Set(), payloadKeys: new Set() };
        endpointMeta[ep].methods.add(String(method).toUpperCase());
    }
    function addPayloadKeys(ep, keys) {
        if (!ep || !keys || !keys.length) return;
        if (!endpointMeta[ep]) endpointMeta[ep] = { methods: new Set(), payloadKeys: new Set() };
        for (var i = 0; i < keys.length; i++) endpointMeta[ep].payloadKeys.add(keys[i]);
    }
    function extractObjectKeysFromText(txt) {
        var s = String(txt || '');
        if (!s) return [];
        var m = s.match(/\{([^{}]{1,900})\}/);
        if (!m) return [];
        var body = m[1];
        var keys = [];
        var parts = body.split(',');
        for (var i = 0; i < parts.length; i++) {
            var p = parts[i].trim();
            var km = p.match(/["'\`]?(?:[A-Za-z_$][A-Za-z0-9_$-]*)["'\`]?\s*:/);
            if (!km) continue;
            var key = km[0].replace(/[:\s"'\`]/g, '');
            if (key && key.length < 60 && keys.indexOf(key) === -1) keys.push(key);
        }
        return keys.slice(0, 20);
    }
    function scanCodeByLines(code, sourceLabel) {
        var lines = String(code || '').split(/\\r?\\n/);
        for (var li = 0; li < lines.length; li++) {
            var lineText = lines[li];
            var patterns = [
                /["'\`](\\/api\\/[^"'\\\`\\s]+)["'\\\`]/g,
                /["'\`](\\/auth[^"'\\\`\\s]*)["'\\\`]/g,
                /["'\`](\\/login[^"'\\\`\\s]*)["'\\\`]/g,
                /["'\`](\\/otp[^"'\\\`\\s]*)["'\\\`]/g,
                /["'\`](\\/verify[^"'\\\`\\s]*)["'\\\`]/g,
                /["'\`](\\/user[^"'\\\`\\s]*)["'\\\`]/g,
                /["'\`](\\/appointment[^"'\\\`\\s]*)["'\\\`]/g,
                /["'\`](\\/slot[^"'\\\`\\s]*)["'\\\`]/g,
                /["'\`](\\/queue[^"'\\\`\\s]*)["'\\\`]/g,
                /["'\`](\\/applicant[^"'\\\`\\s]*)["'\\\`]/g,
                /fetch\\(["'\\\`]([^"'\\\`]+)["'\\\`]/g,
                /axios\\.[a-z]+\\(["'\\\`]([^"'\\\`]+)["'\\\`]/g,
                /\\.post\\(["'\\\`]([^"'\\\`]+)["'\\\`]/g,
                /\\.get\\(["'\\\`]([^"'\\\`]+)["'\\\`]/g
            ];
            for (var pi = 0; pi < patterns.length; pi++) {
                var re = patterns[pi];
                var m;
                while ((m = re.exec(lineText)) !== null) {
                    addEndpoint(m[1], sourceLabel, li + 1, lineText.trim());
                    if (pi <= 9) {
                        // direct path literal in code; method unknown
                    } else if (pi === 10) {
                        var mm = lineText.match(/method\s*:\s*["'\`]([A-Za-z]+)["'\`]/i);
                        addMethod(m[1], mm ? mm[1] : 'GET');
                        var km1 = lineText.match(/body\s*:\s*JSON\.stringify\((\{[^)]*\})\)/i);
                        if (km1) addPayloadKeys(m[1], extractObjectKeysFromText(km1[1]));
                    } else if (pi === 11 || pi === 12) {
                        addMethod(m[1], 'POST');
                        var km2 = lineText.match(/post\([^,]+,\s*(\{[^)]*\})/i);
                        if (km2) addPayloadKeys(m[1], extractObjectKeysFromText(km2[1]));
                    } else if (pi === 13) {
                        addMethod(m[1], 'GET');
                    }
                }
            }
        }
    }
    function addEndpointHitFromText(ep, sourceLabel, text) {
        var src = String(sourceLabel || '');
        var t = String(text || '');
        var idx = t.indexOf(ep);
        if (idx < 0) idx = t.toLowerCase().indexOf(String(ep || '').toLowerCase());
        if (idx < 0) {
            addEndpoint(ep, src, 1, '');
            return;
        }
        var before = t.slice(0, idx);
        var line = before.split(/\\r?\\n/).length;
        var from = Math.max(0, idx - 90);
        var to = Math.min(t.length, idx + Math.max(40, String(ep || '').length + 90));
        var preview = t.slice(from, to).replace(/\\s+/g, ' ').trim();
        addEndpoint(ep, src, line, preview);
    }

    var inline = Array.from(document.querySelectorAll('script:not([src])'));
    for (var i = 0; i < inline.length; i++) {
        var code = inline[i].textContent || '';
        var eps = extractApiEndpoints(code);
        for (var j = 0; j < eps.length; j++) {
            addEndpoint(eps[j], '(inline)');
            addEndpointHitFromText(eps[j], '(inline)', code);
        }
        scanCodeByLines(code, '(inline)');
        r.scannedScripts.push({ url: '(inline)', statusCode: 200, bodyLength: code.length, endpointHits: eps.length });
    }

    var srcEls = Array.from(document.querySelectorAll('script[src]'));
    var urls = srcEls.map(function(s){ return abs(s.getAttribute('src') || s.src); }).filter(Boolean);
    r.scriptUrls = Array.from(new Set(urls));

    for (var k = 0; k < r.scriptUrls.length; k++) {
        var u = r.scriptUrls[k];
        try {
            var resp = await fetch(u, { credentials: 'include', cache: 'no-store' });
            var txt = await resp.text();
            var fe = extractApiEndpoints(txt);
            for (var z = 0; z < fe.length; z++) {
                addEndpoint(fe[z], u);
                addEndpointHitFromText(fe[z], u, txt);
            }
            scanCodeByLines(txt, u);
            r.scannedScripts.push({ url: u, statusCode: resp.status, bodyLength: txt.length, endpointHits: fe.length });
        } catch (e) {
            r.scannedScripts.push({ url: u, statusCode: 0, bodyLength: 0, endpointHits: 0, error: e.message || String(e) });
        }
    }

    var perfRes = (performance.getEntriesByType('resource') || []);
    for (var p = 0; p < perfRes.length; p++) {
        var en = perfRes[p];
        var nm = en && en.name ? String(en.name) : '';
        if (!nm) continue;
        var low = nm.toLowerCase();
        if (low.includes('/api/') || low.includes('/auth') || low.includes('/otp') || low.includes('/appointment') || low.includes('/slot')) {
            try {
                var path = new URL(nm).pathname;
                if (path) addEndpoint(path, 'performance', 1, nm);
            } catch {}
        }
    }

    var rawEndpoints = Array.from(endpointSet);
    r.endpoints = rawEndpoints.filter(isLikelyApiEndpoint).sort();
    if (!r.endpoints.length && rawEndpoints.length) {
        // Fallback: keep potentially useful paths when strict classifier is too aggressive.
        r.endpoints = rawEndpoints.filter(function(ep){
            var s = String(ep || '').toLowerCase();
            if (!s) return false;
            if (s.startsWith('/assets/') || s.startsWith('/cdn-cgi/')) return false;
            if (/\\.(png|jpg|jpeg|gif|svg|webp|css|js|map|woff2?|ttf|eot)(\\?|$)/i.test(s)) return false;
            return s.includes('/') || s.includes('http://') || s.includes('https://');
        }).sort();
    }
    r.endpointsDetailed = r.endpoints.map(function(ep){
        var srcs = endpointSources[ep] ? Array.from(endpointSources[ep]) : [];
        var hits = endpointHits[ep] ? endpointHits[ep].slice(0, 5) : [];
        var methods = endpointMeta[ep] ? Array.from(endpointMeta[ep].methods) : [];
        var payloadKeys = endpointMeta[ep] ? Array.from(endpointMeta[ep].payloadKeys) : [];
        return { path: ep, sources: srcs, hits: hits, methods: methods, payloadKeys: payloadKeys };
    });
    for (var q = 0; q < r.endpoints.length; q++) {
        var cat = classifyEndpoint(r.endpoints[q]);
        r.categoryCounts[cat] = (r.categoryCounts[cat] || 0) + 1;
    }
    r.durationMs = Date.now() - started;
    return r;
}`;
