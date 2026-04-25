import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const db = require('../../db.js');
const {
    buildHarEntryFromRow,
    getHarExportMaxChars,
    getExportWsFrameLimit,
    exportWebSocketSidecarPayload,
} = require('../../har-exporter.js');

describe('har-exporter', () => {
    let queryWsSpy;
    let queryWsBySessionSpy;

    beforeEach(() => {
        queryWsSpy = vi.spyOn(db, 'queryWsEvents').mockReturnValue([]);
        queryWsBySessionSpy = vi.spyOn(db, 'queryWsEventsBySession').mockReturnValue([]);
    });

    afterEach(() => {
        queryWsSpy.mockRestore();
        queryWsBySessionSpy.mockRestore();
    });

    it('buildHarEntryFromRow builds minimal entry', () => {
        const row = {
            created_at: '2020-01-01T00:00:00.000Z',
            method: 'GET',
            url: 'https://example.com/path?q=1',
            duration_ms: 12,
            request_headers: '{"Accept":"text/html"}',
            response_headers: '{"Content-Type":"text/html"}',
            request_body: null,
            response_body: 'ok',
            status: 200,
            tab_id: 1,
            session_id: 2,
            type: 'http',
        };
        const e = buildHarEntryFromRow(row, 100);
        expect(e.request.method).toBe('GET');
        expect(e.response.status).toBe(200);
        expect(e.request.url).toContain('example.com');
    });

    it('buildHarEntryFromRow tolerates broken JSON headers', () => {
        const row = {
            created_at: '2020-01-01T00:00:00.000Z',
            method: 'GET',
            url: 'https://example.com/',
            duration_ms: 1,
            request_headers: '{broken',
            response_headers: null,
            request_body: null,
            response_body: null,
            status: 204,
            tab_id: 1,
            session_id: 2,
            type: 'http',
        };
        const e = buildHarEntryFromRow(row, 100);
        expect(e.request.headers).toEqual([]);
        expect(e.response.status).toBe(204);
    });

    it('buildHarEntryFromRow attaches WebSocket messages when type is websocket', () => {
        queryWsSpy.mockReturnValue([
            { direction: 'send', created_at: '2020-01-01T00:00:00.000Z', payload: 'hello' },
            { direction: 'recv', created_at: '2020-01-01T00:00:01.000Z', payload: 'world' },
        ]);
        const row = {
            created_at: '2020-01-01T00:00:00.000Z',
            method: 'GET',
            url: 'wss://example.com/ws',
            duration_ms: 5,
            request_headers: '{}',
            response_headers: '{}',
            request_body: null,
            response_body: null,
            status: 101,
            tab_id: 3,
            session_id: 4,
            type: 'websocket',
        };
        const e = buildHarEntryFromRow(row, 1000);
        expect(e._webSocketMessages).toHaveLength(2);
        expect(e._webSocketMessages[0].type).toBe('send');
        expect(e._webSocketMessages[1].type).toBe('receive');
        expect(e._cupnetWebSocketMessages[0].payload).toBe('hello');
    });

    it('getHarExportMaxChars and getExportWsFrameLimit respect env', () => {
        const prevHar = process.env.CUPNET_HAR_MAX_EXPORT_CHARS;
        const prevWs = process.env.CUPNET_EXPORT_WS_FRAME_LIMIT;
        try {
            process.env.CUPNET_HAR_MAX_EXPORT_CHARS = '100';
            expect(getHarExportMaxChars()).toBe(100);
            process.env.CUPNET_HAR_MAX_EXPORT_CHARS = '0';
            expect(getHarExportMaxChars()).toBe(Number.MAX_SAFE_INTEGER);

            process.env.CUPNET_EXPORT_WS_FRAME_LIMIT = '1000';
            expect(getExportWsFrameLimit()).toBe(1000);
            process.env.CUPNET_EXPORT_WS_FRAME_LIMIT = '0';
            expect(getExportWsFrameLimit()).toBe(500_000_000);
        } finally {
            if (prevHar === undefined) delete process.env.CUPNET_HAR_MAX_EXPORT_CHARS;
            else process.env.CUPNET_HAR_MAX_EXPORT_CHARS = prevHar;
            if (prevWs === undefined) delete process.env.CUPNET_EXPORT_WS_FRAME_LIMIT;
            else process.env.CUPNET_EXPORT_WS_FRAME_LIMIT = prevWs;
        }
    });

    it('exportWebSocketSidecarPayload returns schema payload from db', () => {
        queryWsBySessionSpy.mockReturnValue([{ id: 1, payload: 'x' }]);
        const payload = exportWebSocketSidecarPayload(42);
        expect(payload.schema).toBe('cupnet.ws_sidecar.v1');
        expect(payload.sessionId).toBe(42);
        expect(payload.events).toHaveLength(1);
        expect(queryWsBySessionSpy).toHaveBeenCalled();
    });

    it('exportWebSocketSidecarPayload returns null for invalid session', () => {
        expect(exportWebSocketSidecarPayload(0)).toBe(null);
        expect(exportWebSocketSidecarPayload('')).toBe(null);
    });
});
