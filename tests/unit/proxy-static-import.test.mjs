'use strict';

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseStaticProxyLine, parseStaticProxyLines, suggestStaticProfileNames } = require('../../proxy-static-import.js');

describe('parseStaticProxyLine', () => {
    it('scheme://user:pass@host:port', () => {
        const { entry } = parseStaticProxyLine('socks5://alice:s3cr%3At@proxy.example.com:1080');
        expect(entry.scheme).toBe('socks5');
        expect(entry.host).toBe('proxy.example.com');
        expect(entry.port).toBe(1080);
        expect(entry.username).toBe('alice');
        expect(entry.password).toBe('s3cr:t');
        expect(entry.url).toBe('socks5://alice:s3cr%3At@proxy.example.com:1080');
    });
    it('host:port:user:pass (password may contain colons)', () => {
        const { entry } = parseStaticProxyLine('1.2.3.4:8080:bob:pa:ss');
        expect(entry.scheme).toBe('http');
        expect(entry.username).toBe('bob');
        expect(entry.password).toBe('pa:ss');
        expect(entry.url).toBe('http://bob:pa%3Ass@1.2.3.4:8080');
    });
    it('user:pass@host:port and bare host:port', () => {
        expect(parseStaticProxyLine('u:p@h.example:3128').entry.url).toBe('http://u:p@h.example:3128');
        const bare = parseStaticProxyLine('h.example:3128').entry;
        expect(bare.url).toBe('http://h.example:3128');
        expect(bare.hasAuth).toBe(false);
    });
    it('IPv6 in brackets', () => {
        const { entry } = parseStaticProxyLine('[2001:db8::1]:8080:u:p');
        expect(entry.host).toBe('[2001:db8::1]');
        expect(entry.port).toBe(8080);
        expect(entry.username).toBe('u');
    });
    it('rejects garbage', () => {
        expect(parseStaticProxyLine('ftp://h:1').error).toMatch(/scheme/);
        expect(parseStaticProxyLine('host').error).toMatch(/port/);
        expect(parseStaticProxyLine('host:99999').error).toMatch(/port/);
        expect(parseStaticProxyLine('bad host:80').error).toMatch(/host/);
        expect(parseStaticProxyLine('http://u:p@h:80/path').error).toMatch(/path/);
        expect(parseStaticProxyLine('u:p@h:80:x:y').error).toMatch(/twice/);
        expect(parseStaticProxyLine('# comment').skip).toBe(true);
        expect(parseStaticProxyLine('').skip).toBe(true);
    });
});

describe('parseStaticProxyLines', () => {
    it('collects entries, errors and duplicates with line numbers', () => {
        const text = [
            '# my list',
            'http://a:b@h1.example:80',
            '',
            'h2.example:81:u:p',
            'h1.example:80:a:b',   // duplicate of line 2 (same normalized URL)
            'nonsense',
        ].join('\n');
        const r = parseStaticProxyLines(text);
        expect(r.entries.map((e) => e.url)).toEqual(['http://a:b@h1.example:80', 'http://u:p@h2.example:81']);
        expect(r.entries[1].line).toBe(4);
        expect(r.duplicates).toBe(1);
        expect(r.errors).toEqual([{ line: 6, text: 'nonsense', reason: 'invalid port ""' }]);
        expect(r.total).toBe(4);
    });
    it('suggests names with a zero-padded prefix or host:port', () => {
        const r = parseStaticProxyLines('h1.example:80\nh2.example:81');
        expect(suggestStaticProfileNames(r.entries, 'DC US')).toEqual(['DC US 01', 'DC US 02']);
        expect(suggestStaticProfileNames(r.entries, '')).toEqual(['h1.example:80', 'h2.example:81']);
    });
});
