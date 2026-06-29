import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    resolveProxyTemplateFromDbRow,
    resolveSessionProfileProxyUpstream,
    maskProxyUrlForLog,
} = require('../../main-process/services/proxy-profile-resolve.js');

describe('proxy-profile-resolve', () => {
    const ctx = {
        parseProxyTemplate: (tpl, vars) => tpl.replace('{SID}', vars.SID || ''),
        safeStorage: { isEncryptionAvailable: () => false },
        db: {
            getProxyProfileEncrypted: (id) => (id === 42 ? {
                url_encrypted: null,
                url_display: 'http://user:***@proxy.example:8080',
                variables: '{"SID":"abc"}',
                tls_profile: 'chrome_120',
                tls_ja3_mode: 'template',
            } : null),
        },
    };

    it('falls back to url_display when encryption unavailable', () => {
        const url = resolveProxyTemplateFromDbRow(ctx, {
            url_encrypted: Buffer.from('x'),
            url_display: 'http://user:pass@proxy.example:8080',
            variables: '{}',
        });
        expect(url).toBe('http://user:pass@proxy.example:8080');
    });

    it('prefers inline session template over DB row', () => {
        const r = resolveSessionProfileProxyUpstream(ctx, {
            template: 'http://inline:secret@gate.example:8080',
            variables: {},
            tlsProfile: 'firefox',
        }, 42);
        expect(r?.upstream).toBe('http://inline:secret@gate.example:8080');
        expect(r?.browser).toBe('firefox');
    });

    it('masks proxy password in logs', () => {
        const masked = maskProxyUrlForLog('http://user:secret@host:8080');
        expect(masked).not.toContain('secret');
    });
});
