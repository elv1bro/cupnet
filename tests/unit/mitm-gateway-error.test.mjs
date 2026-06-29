import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    buildMitmGatewayErrorResponse,
    summarizeMitmGatewayError,
    resolveMitmGatewayDnsContext,
    isLikelyDocumentNavigation,
} = require('../../mitm-gateway-error.js');

describe('mitm-gateway-error', () => {
    it('summarizeMitmGatewayError explains DNS override to loopback + refused', () => {
        const s = summarizeMitmGatewayError({
            url: 'https://app.example.com/account/login',
            errorMessage: 'failed to dial: dial tcp 127.0.0.1:443: connect: connection refused',
            dnsOverride: { host: 'app.example.com', ip: '127.0.0.1' },
        });
        expect(s).toContain('DNS override');
        expect(s).toContain('127.0.0.1');
        expect(s).toContain('connection refused');
    });

    it('buildMitmGatewayErrorResponse returns HTML body with hints', () => {
        const res = buildMitmGatewayErrorResponse({
            url: 'https://example.com/',
            errorMessage: 'connection refused',
            dnsOverride: { host: 'example.com', ip: '127.0.0.1' },
        });
        expect(res.statusCode).toBe(502);
        expect(res.headers['Content-Type']).toContain('text/html');
        const html = Buffer.from(res.bodyBase64, 'base64').toString('utf8');
        expect(html).toContain('Page failed to load');
        expect(html).toContain('DNS');
        expect(html).toContain('127.0.0.1');
    });

    it('isLikelyDocumentNavigation detects HTML navigations', () => {
        expect(isLikelyDocumentNavigation({ method: 'GET', headers: { accept: 'text/html' }, path: '/login' })).toBe(true);
        expect(isLikelyDocumentNavigation({ method: 'GET', path: '/app.js' })).toBe(false);
        expect(isLikelyDocumentNavigation({ method: 'POST', headers: { accept: 'text/html' }, path: '/login' })).toBe(false);
    });

    it('resolveMitmGatewayDnsContext infers localhost routing from dial error', () => {
        const ctx = resolveMitmGatewayDnsContext({
            url: 'https://app.example.com/',
            errorMessage: 'failed to dial: dial tcp 127.0.0.1:443: connect: connection refused',
            dnsOverride: null,
        });
        expect(ctx).toMatchObject({
            host: 'app.example.com',
            ip: '127.0.0.1',
            inferred: true,
        });
        expect(typeof ctx.fromEtcHosts).toBe('boolean');
        const summary = summarizeMitmGatewayError({
            url: 'https://app.example.com/',
            errorMessage: 'failed to dial: dial tcp 127.0.0.1:443: connect: connection refused',
            dnsOverride: ctx,
        });
        expect(summary).toContain('localhost');
        expect(summary).toContain('app.example.com');
    });
});
