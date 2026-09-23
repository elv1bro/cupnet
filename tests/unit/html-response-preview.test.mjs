import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    buildSandboxPreviewDoc,
    extractHtmlPlainText,
    isLikelyHtmlContent,
    isSandboxSafeResourceUrl,
    normalizePlainText,
    previewDocHash,
    sanitizeSrcsetValue,
} = require('../../html-response-preview.js');

describe('html-response-preview', () => {
    it('detects likely HTML', () => {
        expect(isLikelyHtmlContent('<!doctype html><html><body>x</body></html>')).toBe(true);
        expect(isLikelyHtmlContent('{"a":1}')).toBe(false);
    });

    it('isSandboxSafeResourceUrl allows inline data and blob only', () => {
        expect(isSandboxSafeResourceUrl('data:image/png;base64,abc')).toBe(true);
        expect(isSandboxSafeResourceUrl('blob:abc-123')).toBe(true);
        expect(isSandboxSafeResourceUrl('https://evil.test/x.png')).toBe(false);
        expect(isSandboxSafeResourceUrl('/relative.png')).toBe(false);
    });

    it('sanitizeSrcsetValue keeps only data/blob entries', () => {
        const srcset = 'data:image/png;base64,aaa 1x, https://evil.test/x.png 2x, data:image/png;base64,bbb 3x';
        expect(sanitizeSrcsetValue(srcset)).toBe('data:image/png;base64,aaa 1x, data:image/png;base64,bbb 3x');
    });

    it('buildSandboxPreviewDoc avoids preview unavailable placeholder leaking URLs', () => {
        const html = '<html><body><img src="https://evil.test/x.png"><p>Hi</p></body></html>';
        const doc = buildSandboxPreviewDoc(html);
        expect(doc).not.toContain('https://evil.test');
        if (typeof DOMParser !== 'undefined') {
            expect(doc).toContain('Hi');
            expect(doc).toContain("default-src 'none'");
            expect(doc).not.toMatch(/<body>\s*<html/i);
            const dataImg = buildSandboxPreviewDoc('<html><body><img src="data:image/png;base64,QUJD" alt="x"></body></html>');
            expect(dataImg).toContain('src="data:image/png;base64,QUJD"');
        } else {
            expect(doc).toContain('Preview unavailable');
        }
    });

    it('extractHtmlPlainText collapses spaces and limits blank lines', () => {
        const text = extractHtmlPlainText('<html><body><p>Hello    world</p><p>Line2</p><p></p><p></p><p>Line3</p></body></html>');
        expect(text).not.toMatch(/  /);
        expect(text).not.toMatch(/\n{3,}/);
        expect(text).toMatch(/Hello world/);
    });

    it('normalizePlainText keeps at most two consecutive newlines', () => {
        expect(normalizePlainText('a\n\n\n\nb')).toBe('a\n\nb');
        expect(normalizePlainText('too   many   spaces')).toBe('too many spaces');
    });

    it('previewDocHash is stable', () => {
        expect(previewDocHash('abc')).toBe(previewDocHash('abc'));
        expect(previewDocHash('abc')).not.toBe(previewDocHash('abcd'));
    });
});
