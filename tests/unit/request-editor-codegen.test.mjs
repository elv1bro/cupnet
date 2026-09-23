import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { generateRequestCode } = require('../../request-editor-codegen.js');

const REQ = {
    method: 'POST',
    url: 'https://api.example.com/x',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
    body: '{"price":"$5"}',
};

describe('request-editor-codegen (A-173)', () => {
    it('python quotes method/url/headers/data (no bare identifiers)', () => {
        const out = generateRequestCode('python', REQ);
        expect(out).toContain("requests.request('POST', 'https://api.example.com/x'");
        expect(out).toContain("data='{\"price\":\"$5\"}'");
        // must NOT contain an unquoted bareword method
        expect(out).not.toMatch(/requests\.request\(POST/);
    });

    it('curl uses single-quoted shell literals so $ is not expanded', () => {
        const out = generateRequestCode('curl', REQ);
        expect(out).toContain("--data-raw '{\"price\":\"$5\"}'");
        expect(out).toContain("-X POST 'https://api.example.com/x'");
    });

    it('go imports "strings" only when there is a body', () => {
        const withBody = generateRequestCode('go', REQ);
        expect(withBody).toContain('"strings"');
        const noBody = generateRequestCode('go', { method: 'GET', url: 'https://a.com', headers: {} });
        expect(noBody).not.toContain('"strings"');
        expect(noBody).toContain('http.NewRequest(method, url, nil)');
    });

    it('php uses single-quoted literals (no $ interpolation)', () => {
        const out = generateRequestCode('php', REQ);
        expect(out).toContain("CURLOPT_POSTFIELDS, '{\"price\":\"$5\"}'");
        expect(out).toContain("curl_init('https://api.example.com/x')");
    });

    it('axios/fetch wrap the call in an async IIFE', () => {
        expect(generateRequestCode('axios', REQ)).toContain('(async () => {');
        expect(generateRequestCode('fetch', REQ)).toContain('(async () => {');
    });

    it('omits body for GET', () => {
        const out = generateRequestCode('curl', { method: 'GET', url: 'https://a.com', headers: {}, body: 'x=1' });
        expect(out).not.toContain('--data-raw');
    });
});
