'use strict';
/**
 * @deprecated IPC живёт в main-process/ipc/handlers/*.js — этот скрипт не обновляет их.
 * Раньше: генерация монолитного register-main-ipc.js из слайса index.js.
 * Замена идентификаторов только вне строк/комментариев; в шаблонных — внутри ${ }.
 * Запуск (только если восстанавливаете старый пайплайн): node scripts/gen-register-main-ipc.cjs
 */
const fs = require('fs');
const path = require('path');

const INDEX = path.join(__dirname, '../main-process/index.js');
const OUT = path.join(__dirname, '../main-process/ipc/register-main-ipc.js');

const idxLines = fs.readFileSync(INDEX, 'utf8').split(/\n/);
const ipc = idxLines.slice(2352, 4645).join('\n');
const pre = idxLines.slice(0, 2352).join('\n');

const bound = new Set();
for (const line of pre.split(/\n/)) {
    let m = line.match(/^const\s*\{([^}]+)\}/);
    if (m) {
        m[1].split(',').forEach((p) => {
            const n = p.trim().split(/\s+/).pop().split(':').pop().trim();
            if (/^[A-Za-z_$]/.test(n)) bound.add(n);
        });
    }
    m = line.match(/^const\s+([A-Za-z_$][\w$]*)/);
    if (m) bound.add(m[1]);
    m = line.match(/^let\s+([A-Za-z_$][\w$]*)/);
    if (m) bound.add(m[1]);
    m = line.match(/^function\s+([A-Za-z_$][\w$]*)/);
    if (m) bound.add(m[1]);
    m = line.match(/^async function\s+([A-Za-z_$][\w$]*)/);
    if (m) bound.add(m[1]);
}

const tok = /\b([A-Za-z_$][\w$]*)\b/g;
const ipcNames = new Set();
let mm;
while ((mm = tok.exec(ipc))) ipcNames.add(mm[1]);

const KW = new Set(`async,await,break,case,catch,class,const,continue,debugger,default,delete,do,else,export,extends,false,finally,for,function,if,import,in,instanceof,let,new,null,return,super,switch,this,throw,true,try,typeof,var,void,while,with,yield,of,static,get,set,from,as,undefined,NaN,Infinity`.split(','));
const bi = new Set(`Object,Array,String,Number,Boolean,Date,Math,JSON,Promise,Map,Set,WeakMap,WeakSet,RegExp,Error,Buffer,parseInt,parseFloat,isNaN,isFinite,encodeURIComponent,decodeURIComponent,console,process,require,module,exports,Intl,BigInt,Symbol,Reflect,Proxy,Uint8Array,AbortController,URL,Headers,Request,Response,WebSocket,Event,TypeError,ArrayBuffer,Blob,File,TextEncoder,TextDecoder`.split(','));

let names = [...ipcNames].filter((n) => !KW.has(n) && !bi.has(n) && bound.has(n));

const extra = `ipcMain,app,BrowserWindow,dialog,Menu,session,shell,clipboard,net,Notification,safeStorage,nativeImage,resolveNavigationUrl,parseProxyTemplate,extractTemplateVars,formatBytes,shouldFilterUrl,SEARCH_ENGINE,getAssetPath,emitStabilityEvent,emitSloWarnOnce,maybeLogMockToNetworkActivity,rulesEngine,withTimeout,sanitizeProxyUrl,generatePassword,getLocalIp,notifyMitmReady,cookieManagerWindow,dnsManagerWindow,proxyManagerWindow,compareViewerWindow,pageAnalyzerWindow,ivacScoutWindow,loggingModalWindow,spawn,MitmProxy`.split(',');
// multi-line `const { app, ... } = require('electron')` не попадает в bound — добавляем явно
extra.forEach((x) => names.push(x));

names = [...new Set(names)].sort((a, b) => b.length - a.length);

function transformSource(source, sortedNames) {
    const map = new Map(sortedNames.map((n) => [n, `ctx.${n}`]));

    function afterNameIsColon(idx, len) {
        let j = idx + len;
        while (j < source.length && /\s/.test(source[j])) j++;
        return source[j] === ':';
    }

    /** Ключ объекта `{ key:` или `, key:` — не подменяем на ctx.key */
    function isLikelyObjectKey(idx) {
        let j = idx - 1;
        while (j >= 0 && /\s/.test(source[j])) j--;
        return j >= 0 && (source[j] === '{' || source[j] === ',');
    }

    function tryReplaceIdent(i) {
        if (i >= source.length || !/[A-Za-z_$]/.test(source[i])) return null;
        if (i > 0 && /[A-Za-z0-9_$]/.test(source[i - 1])) return null;
        for (const name of sortedNames) {
            if (!source.startsWith(name, i)) continue;
            const after = source[i + name.length];
            if (after !== undefined && /[A-Za-z0-9_$]/.test(after)) continue;
            if (afterNameIsColon(i, name.length) && isLikelyObjectKey(i)) continue;
            return { text: map.get(name), len: name.length };
        }
        return null;
    }

    function skipLineComment(i) {
        let j = i;
        while (j < source.length && source[j] !== '\n') j++;
        return { text: source.slice(i, j), next: j };
    }

    function skipBlockComment(i) {
        let j = i + 2;
        while (j < source.length - 1) {
            if (source[j] === '*' && source[j + 1] === '/') return { text: source.slice(i, j + 2), next: j + 2 };
            j++;
        }
        return { text: source.slice(i), next: source.length };
    }

    function skipSingleQuoted(i) {
        let j = i + 1;
        let out = source[i];
        while (j < source.length) {
            const c = source[j];
            out += c;
            if (c === '\\') {
                j++;
                if (j < source.length) { out += source[j]; j++; }
                continue;
            }
            if (c === "'") { j++; break; }
            j++;
        }
        return { text: out, next: j };
    }

    function skipDoubleQuoted(i) {
        let j = i + 1;
        let out = source[i];
        while (j < source.length) {
            const c = source[j];
            out += c;
            if (c === '\\') {
                j++;
                if (j < source.length) { out += source[j]; j++; }
                continue;
            }
            if (c === '"') { j++; break; }
            j++;
        }
        return { text: out, next: j };
    }

    /** Выражение внутри ${ ... } — баланс { }, строки/комменты/вложенные шаблоны */
    function scanTemplateExpression(i) {
        let out = '';
        let depth = 0;
        while (i < source.length) {
            const c = source[i];
            if (c === '/' && source[i + 1] === '/') {
                const s = skipLineComment(i);
                out += s.text;
                i = s.next;
                continue;
            }
            if (c === '/' && source[i + 1] === '*') {
                const s = skipBlockComment(i);
                out += s.text;
                i = s.next;
                continue;
            }
            if (c === "'") {
                const s = skipSingleQuoted(i);
                out += s.text;
                i = s.next;
                continue;
            }
            if (c === '"') {
                const s = skipDoubleQuoted(i);
                out += s.text;
                i = s.next;
                continue;
            }
            if (c === '`') {
                const s = scanTemplateLiteral(i);
                out += s.text;
                i = s.next;
                continue;
            }
            if (c === '{') {
                depth++;
                out += c;
                i++;
                continue;
            }
            if (c === '}') {
                if (depth > 0) {
                    depth--;
                    out += c;
                    i++;
                    continue;
                }
                return { text: out, next: i + 1 };
            }
            const rep = tryReplaceIdent(i);
            if (rep) {
                out += rep.text;
                i += rep.len;
                continue;
            }
            out += c;
            i++;
        }
        return { text: out, next: i };
    }

    function scanTemplateLiteral(startBacktick) {
        let out = '`';
        let i = startBacktick + 1;
        while (i < source.length) {
            const c = source[i];
            if (c === '`') {
                out += '`';
                return { text: out, next: i + 1 };
            }
            if (c === '\\') {
                out += source.slice(i, Math.min(i + 2, source.length));
                i += 2;
                continue;
            }
            if (c === '$' && source[i + 1] === '{') {
                out += '${';
                i += 2;
                const inner = scanTemplateExpression(i);
                out += inner.text + '}';
                i = inner.next;
                continue;
            }
            out += c;
            i++;
        }
        return { text: out, next: i };
    }

    let out = '';
    let i = 0;
    while (i < source.length) {
        const c = source[i];
        if (c === '/' && source[i + 1] === '/') {
            const s = skipLineComment(i);
            out += s.text;
            i = s.next;
            continue;
        }
        if (c === '/' && source[i + 1] === '*') {
            const s = skipBlockComment(i);
            out += s.text;
            i = s.next;
            continue;
        }
        if (c === "'") {
            const s = skipSingleQuoted(i);
            out += s.text;
            i = s.next;
            continue;
        }
        if (c === '"') {
            const s = skipDoubleQuoted(i);
            out += s.text;
            i = s.next;
            continue;
        }
        if (c === '`') {
            const s = scanTemplateLiteral(i);
            out += s.text;
            i = s.next;
            continue;
        }
        const rep = tryReplaceIdent(i);
        if (rep) {
            out += rep.text;
            i += rep.len;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

let body = transformSource(ipc, names);
// { path: x } и , path: x — ключи объектов; идентификатор не должен стать ctx.path:
body = body.replace(/([\{,]\s*)ctx\.([A-Za-z_$][\w$]*)(\s*:)/g, '$1$2$3');
// Краткая запись { db, ... } после замены стала { ctx.db, — чиним в явные поля.
// (?<!\$) — не трогаем `${ctx.foo}` в шаблонных литералах.
// Только первая строка объекта `{ ctx.x,` — не трогаем `f(a, ctx.x, b)` (аргументы).
body = body.replace(/(?<!\$)\{\s*ctx\.([A-Za-z_$][\w$]*)\s*,/g, '{ $1: ctx.$1,');
body = body.replace(/(?<!\$)\{\s*ctx\.([A-Za-z_$][\w$]*)\s*\}/g, '{ $1: ctx.$1 }');

const header = `'use strict';

/**
 * Регистрация ipcMain (вызывается из main-process/index.js внутри app.whenReady).
 * Все обращения к состоянию главного процесса — через ctx (геттеры/замыкания).
 */
function registerMainProcessIpc(ctx) {
`;

const footer = `
}

module.exports = { registerMainProcessIpc };
`;

fs.writeFileSync(OUT, header + body + footer);
console.log('Wrote', OUT, 'replacements for', names.length, 'identifiers');
