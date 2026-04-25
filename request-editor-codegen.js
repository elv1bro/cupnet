'use strict';

function escPy(s) {
    return String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
function escJs(s) {
    return JSON.stringify(String(s ?? ''));
}

/**
 * @param {'curl'|'fetch'|'axios'|'python'|'go'|'php'} lang
 * @param {{ method: string, url: string, headers: Record<string,string>, body?: string }} req
 */
function generateRequestCode(lang, req) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = String(req.url || '');
    const headers = req.headers || {};
    const body = req.body != null ? String(req.body) : '';

    if (lang === 'curl') {
        const parts = [`curl -X ${method} ${escJs(url)}`];
        for (const [k, v] of Object.entries(headers)) {
            if (k && v != null) parts.push(`  -H ${escJs(`${k}: ${v}`)}`);
        }
        if (body && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
            parts.push(`  --data-raw ${escJs(body)}`);
        }
        return parts.join(' \\\n');
    }

    if (lang === 'fetch') {
        const hdr = JSON.stringify(headers, null, 2);
        const hasBody = body && !['GET', 'HEAD', 'OPTIONS'].includes(method);
        return `const res = await fetch(${escJs(url)}, {
  method: ${escJs(method)},
  headers: ${hdr},
  ${hasBody ? `body: ${escJs(body)},` : ''}
});
const text = await res.text();
console.log(res.status, text);`;
    }

    if (lang === 'axios') {
        const hdr = JSON.stringify(headers, null, 2);
        const hasBody = body && !['GET', 'HEAD', 'OPTIONS'].includes(method);
        return `const axios = require('axios');
const res = await axios({
  method: ${escJs(method)},
  url: ${escJs(url)},
  headers: ${hdr},
  ${hasBody ? `data: ${escJs(body)},` : ''}
});
console.log(res.status, res.data);`;
    }

    if (lang === 'python') {
        const lines = ['import requests', ''];
        const hdr = Object.keys(headers).length
            ? `headers={${Object.entries(headers).map(([k, v]) => `${escPy(k)}: ${escPy(v)}`).join(', ')}}`
            : '';
        const data = body && !['GET', 'HEAD', 'OPTIONS'].includes(method) ? `data=${escPy(body)}` : '';
        const parts = [`r = requests.request(${escPy(method)}, ${escPy(url)}`];
        if (hdr) parts.push(`    ${hdr}`);
        if (data) parts.push(`    ${data}`);
        parts.push(')');
        lines.push(parts.join(',\n'));
        lines.push('print(r.status_code, r.text)');
        return lines.join('\n');
    }

    if (lang === 'go') {
        let out = `package main

import (
    "fmt"
    "io"
    "net/http"
    "strings"
)

func main() {
    url := ${escJs(url)}
    method := ${escJs(method)}
`;
        if (body && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
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
$ch = curl_init(${escJs(url)});
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, ${escJs(method)});
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
`;
        const hlist = Object.entries(headers).map(([k, v]) => `${escJs(`${k}: ${v}`)}`).join(', ');
        out += `curl_setopt($ch, CURLOPT_HTTPHEADER, [${hlist}]);\n`;
        if (body && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
            out += `curl_setopt($ch, CURLOPT_POSTFIELDS, ${escJs(body)});\n`;
        }
        out += `$res = curl_exec($ch);
echo curl_getinfo($ch, CURLINFO_HTTP_CODE) . "\\n" . $res;
curl_close($ch);
`;
        return out;
    }

    return '';
}

window.CupNetCodegen = { generateRequestCode };
