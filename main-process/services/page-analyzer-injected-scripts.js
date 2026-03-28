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
    var r = { recaptcha: [], hcaptcha: [], turnstile: [], geetest: [], other: [], pageUrl: location.href };
    function addTurnstile(item){
        if(!item) return;
        var sk = String(item.sitekey || '');
        var frame = String(item.iframeSrc || '');
        var ex = r.turnstile.some(function(x){
            return String(x.sitekey||'')===sk && String(x.iframeSrc||'')===frame && String(x.selector||'')===String(item.selector||'');
        });
        if(!ex) r.turnstile.push(item);
    }
    function addGeetest(item){
        if(!item) return;
        var g = String(item.gt || '');
        var sel = String(item.selector || '');
        var fr = String(item.iframeSrc || '');
        var ex = r.geetest.some(function(x){
            return String(x.gt||'')===g && String(x.selector||'')===sel && String(x.iframeSrc||'')===fr;
        });
        if(!ex) r.geetest.push(item);
    }
    function geetestFromUrl(u){
        var gt = '', challenge = '', apiServer = '';
        if(!u) return { gt:gt, challenge:challenge, apiServer:apiServer };
        var mgt = u.match(/[?&]gt=([a-f0-9]{32})/i);
        if(mgt) gt = mgt[1];
        var mch = u.match(/[?&]challenge=([^&]+)/);
        if(mch) { try { challenge = decodeURIComponent(mch[1]); } catch(e) { challenge = mch[1]; } }
        if(/api\\.geetest\\.com/i.test(u)) apiServer = 'api.geetest.com';
        else if(/api-na\\.geetest\\.com/i.test(u)) apiServer = 'api-na.geetest.com';
        else if(/static\\.geetest\\.com/i.test(u)) apiServer = 'static.geetest.com';
        return { gt:gt, challenge:challenge, apiServer:apiServer };
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
        if(s.indexOf('geetest') !== -1 && (s.indexOf('geetest.com') !== -1 || s.indexOf('geetest.') !== -1)){
            var gex = geetestFromUrl(s);
            addGeetest({
                gt:gex.gt, challenge:gex.challenge, apiServer:gex.apiServer, version:'v3',
                selector:'iframe', iframeSrc:s.substring(0,300), iframe:true
            });
        }
    });

    /* ── GeeTest: внешние скрипты gt.js / api.geetest.com / static.geetest.com ── */
    document.querySelectorAll('script[src]').forEach(function(s){
        var src = s.src || '';
        if(!/geetest|gt\\.js/i.test(src)) return;
        var gex = geetestFromUrl(src);
        addGeetest({
            gt:gex.gt, challenge:gex.challenge, apiServer:gex.apiServer, version:'v3',
            selector:'script', scriptSrc: src.substring(0,300), iframe:false
        });
    });
    document.querySelectorAll('.geetest_holder, .gee-test, div[id="embed-captcha"]').forEach(function(el){
        var hasGee = el.querySelector && el.querySelector('.geetest_holder');
        var target = hasGee || el;
        if(!target || (!target.className && !el.id)) return;
        var cls = (target.className && target.className.toString) ? target.className.toString() : '';
        if(cls.indexOf('geetest') === -1 && el.id !== 'embed-captcha') return;
        addGeetest({
            gt:'', challenge:'', apiServer:'', version:'v3',
            selector: el.id ? '#'+el.id : '.geetest_holder', iframe:false
        });
    });
    document.querySelectorAll('input[name="geetest_challenge"], input[name="geetest_validate"], input[name="geetest_seccode"]').forEach(function(){
        addGeetest({
            gt:'', challenge:'', apiServer:'', version:'v3',
            selector:'input[name^=geetest_]', iframe:false
        });
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
        if(txt.indexOf('turnstile') === -1 && txt.indexOf('sitekey') === -1 && txt.indexOf('geetest') === -1) return;
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
        if(txt.indexOf('geetest') !== -1) {
            var mg = txt.match(/['"]gt['"]\\s*:\\s*['"]([a-f0-9]{32})['"]/i) || txt.match(/\\bgt\\s*:\\s*['"]([a-f0-9]{32})['"]/i);
            if(mg && mg[1]) addGeetest({ gt:mg[1], challenge:'', apiServer:'', version:'v3', selector:'script:inline', iframe:false });
        }
    });

    r.found = r.recaptcha.length>0 || r.hcaptcha.length>0 || r.turnstile.length>0 || r.geetest.length>0;
    r.totalCount = r.recaptcha.length + r.hcaptcha.length + r.turnstile.length + r.geetest.length;
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

/** Синхронный сбор: inline-скрипты, URL внешних скриптов, performance — разбор тела в main через session.fetch. */
module.exports._analyzeEndpointsCollectScript = `function(){
    function abs(url) { try { return new URL(url, location.href).toString(); } catch { return null; } }
    var r = {
        pageUrl: location.href,
        statusHint: (document.body && /just a moment/i.test(document.body.innerText || '')) ? 'challenge' : 'ok',
        inlineScripts: [],
        scriptUrls: [],
        perfNames: []
    };
    var inline = Array.from(document.querySelectorAll('script:not([src])'));
    for (var i = 0; i < inline.length; i++) {
        r.inlineScripts.push(inline[i].textContent || '');
    }
    var srcEls = Array.from(document.querySelectorAll('script[src]'));
    var urls = srcEls.map(function(s){ return abs(s.getAttribute('src') || s.src); }).filter(Boolean);
    r.scriptUrls = Array.from(new Set(urls));
    var perfRes = (performance.getEntriesByType('resource') || []);
    for (var p = 0; p < perfRes.length; p++) {
        var en = perfRes[p];
        if (en && en.name) r.perfNames.push(String(en.name));
    }
    return r;
}`;
