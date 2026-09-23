import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseCurlCommand } = require('../../request-editor-curl-parser.js');

describe('request-editor-curl-parser (A-174)', () => {
    it('parses a basic GET', () => {
        const r = parseCurlCommand("curl 'https://api.example.com/x'");
        expect(r.method).toBe('GET');
        expect(r.url).toBe('https://api.example.com/x');
    });

    it('-d without -X defaults to POST and keeps the body', () => {
        const r = parseCurlCommand("curl 'https://a.com/api' --data-raw 'hello=world'");
        expect(r.method).toBe('POST');
        expect(r.body).toBe('hello=world');
    });

    it('decodes Chrome ANSI-C $\'...\' bodies including escaped quotes', () => {
        const r = parseCurlCommand(
            "curl 'https://a.com/api' -H 'content-type: application/json' --data-raw $'{\"a\":\"it\\'s\"}'",
        );
        expect(r.method).toBe('POST');
        expect(r.body).toBe('{"a":"it\'s"}');
        expect(r.headers['content-type']).toBe('application/json');
    });

    it('-x proxy is not treated as the method (case-sensitive flags)', () => {
        const r = parseCurlCommand("curl -x http://proxy:8080 -X PUT 'https://a.com/x'");
        expect(r.method).toBe('PUT');
        expect(r.url).toBe('https://a.com/x');
    });

    it('joins multiple -d values with &', () => {
        const r = parseCurlCommand("curl 'https://a.com' -d a=1 -d b=2");
        expect(r.method).toBe('POST');
        expect(r.body).toBe('a=1&b=2');
    });

    it('-e/--referer and -A/--user-agent become headers, not the URL', () => {
        const r = parseCurlCommand("curl 'https://a.com/x' -e 'https://ref.example/' -A 'MyUA/1.0'");
        expect(r.url).toBe('https://a.com/x');
        expect(r.headers['Referer']).toBe('https://ref.example/');
        expect(r.headers['User-Agent']).toBe('MyUA/1.0');
    });

    it('--data-urlencode encodes the value', () => {
        const r = parseCurlCommand("curl 'https://a.com' --data-urlencode 'q=a b&c'");
        expect(r.body).toBe('q=a%20b%26c');
    });

    it('takes the URL from the first positional token, not a header URL', () => {
        const r = parseCurlCommand("curl -H 'Origin: https://evil.example' 'https://real.example/api'");
        expect(r.url).toBe('https://real.example/api');
    });

    it('returns null for input with no URL', () => {
        expect(parseCurlCommand('curl -X POST')).toBeNull();
    });
});
