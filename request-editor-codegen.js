'use strict';

function escPy(s) {
    return String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
// Python single-quoted string literal (values were emitted unquoted -> SyntaxError). (A-173)
function pyStr(s) {
    return "'" + escPy(s).replace(/\n/g, '\\n').replace(/\r/g, '\\r') + "'";
}
function escJs(s) {
    return JSON.stringify(String(s ?? ''));
}
// POSIX shell single-quoted literal: $ ` \ are literal, so a body like {"p":"$5"} is
// not mangled by shell variable expansion. (A-173)
function shQuote(s) {
    return "'" + String(s ?? '').replace(/'/g, "'\\''") + "'";
}
// PHP single-quoted literal: no $variable interpolation. (A-173)
function phpStr(s) {
    return "'" + String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

const NO_BODY = ['GET', 'HEAD', 'OPTIONS'];

/**
 * @param {'curl'|'fetch'|'axios'|'python'|'go'|'php'} lang
 * @param {{ method: string, url: string, headers: Record<string,string>, body?: string }} req
 */
function generateRequestCode(lang, req) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = String(req.url || '');
    const headers = req.headers || {};
    const body = req.body != null ? String(req.body) : '';
    const hasBody = !!body && !NO_BODY.includes(method);

    if (lang === 'curl') {
        const parts = [`curl -X ${method} ${shQuote(url)}`];
        for (const [k, v] of Object.entries(headers)) {
            if (k && v != null) parts.push(`  -H ${shQuote(`${k}: ${v}`)}`);
        }
        if (hasBody) {
            parts.push(`  --data-raw ${shQuote(body)}`);
        }
        return parts.join(' \\\n');
    }

    if (lang === 'fetch') {
        const hdr = JSON.stringify(headers, null, 2);
        return `(async () => {
  const res = await fetch(${escJs(url)}, {
    method: ${escJs(method)},
    headers: ${hdr},${hasBody ? `\n    body: ${escJs(body)},` : ''}
  });
  const text = await res.text();
  console.log(res.status, text);
})();`;
    }

    if (lang === 'axios') {
        const hdr = JSON.stringify(headers, null, 2);
        return `const axios = require('axios');
(async () => {
  const res = await axios({
    method: ${escJs(method)},
    url: ${escJs(url)},
    headers: ${hdr},${hasBody ? `\n    data: ${escJs(body)},` : ''}
  });
  console.log(res.status, res.data);
})();`;
    }

    if (lang === 'python') {
        const lines = ['import requests', ''];
        const hdr = Object.keys(headers).length
            ? `headers={${Object.entries(headers).map(([k, v]) => `${pyStr(k)}: ${pyStr(v)}`).join(', ')}}`
            : '';
        const data = hasBody ? `data=${pyStr(body)}` : '';
        const parts = [`r = requests.request(${pyStr(method)}, ${pyStr(url)}`];
        if (hdr) parts.push(`    ${hdr}`);
        if (data) parts.push(`    ${data}`);
        parts.push(')');
        lines.push(parts.join(',\n'));
        lines.push('print(r.status_code, r.text)');
        return lines.join('\n');
    }

    if (lang === 'go') {
        // Only import "strings" when the body branch (strings.NewReader) is used. (A-173)
        const imports = ['    "fmt"', '    "io"', '    "net/http"'];
        if (hasBody) imports.push('    "strings"');
        imports.sort();
        let out = `package main

import (
${imports.join('\n')}
)

func main() {
    url := ${escJs(url)}
    method := ${escJs(method)}
`;
        if (hasBody) {
            out += `    body := strings.NewReader(${escJs(body)})
    req, err := http.NewRequest(method, url, body)
`;
        } else {
            out += `    req, err := http.NewRequest(method, url, nil)
`;
        }
        out += `    if err != nil { panic(err) }
`;
        for (const [k, v] of Object.entries(headers)) {
            out += `    req.Header.Set(${escJs(k)}, ${escJs(v)})
`;
        }
        out += `    client := &http.Client{}
    resp, err := client.Do(req)
    if err != nil { panic(err) }
    defer resp.Body.Close()
    b, _ := io.ReadAll(resp.Body)
    fmt.Println(resp.StatusCode, string(b))
}
`;
        return out;
    }

    if (lang === 'php') {
        let out = `<?php
$ch = curl_init(${phpStr(url)});
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, ${phpStr(method)});
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
`;
        const hlist = Object.entries(headers).map(([k, v]) => `${phpStr(`${k}: ${v}`)}`).join(', ');
        out += `curl_setopt($ch, CURLOPT_HTTPHEADER, [${hlist}]);\n`;
        if (hasBody) {
            out += `curl_setopt($ch, CURLOPT_POSTFIELDS, ${phpStr(body)});\n`;
        }
        out += `$res = curl_exec($ch);
echo curl_getinfo($ch, CURLINFO_HTTP_CODE) . "\\n" . $res;
curl_close($ch);
`;
        return out;
    }

    return '';
}

if (typeof window !== 'undefined') {
    window.CupNetCodegen = { generateRequestCode };
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { generateRequestCode };
}
