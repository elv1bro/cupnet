'use strict';

const { test, expect } = require('@playwright/test');
const { launchCupnet, waitForAppContext, waitMitmReady } = require('./helpers.js');

test.describe.configure({ mode: 'serial' });

let electronApp;
/** @type {import('@playwright/test').Page} */
let mainWindow;

test.beforeAll(async () => {
    electronApp = await launchCupnet();
    mainWindow = await electronApp.firstWindow({ timeout: 120_000 });
    await mainWindow.waitForLoadState('domcontentloaded');
    await waitForAppContext(electronApp, 120_000);
    await waitMitmReady(electronApp, 180_000);
});

test.afterAll(async () => {
    if (electronApp) await electronApp.close();
});

test('nt1) save list plain note', async () => {
    const title = `e2e-${Date.now()}`;
    const id = await mainWindow.evaluate(
        async (t) =>
            window.electronAPI.notesSave({
                title: t,
                body: 'hello **world**',
                url_match: 'httpbin.org',
                page_url: 'https://httpbin.org/get',
                is_encrypted: false,
            }),
        title
    );
    expect(typeof id === 'number' || id > 0).toBeTruthy();

    const list = await mainWindow.evaluate(() => window.electronAPI.notesList({ limit: 50 }));
    expect(Array.isArray(list)).toBe(true);
    expect((list || []).some((n) => n.title === title)).toBe(true);

    const full = await mainWindow.evaluate(async (nid) => window.electronAPI.notesGet(nid, ''), id);
    expect(full?.body || full?.title).toBeTruthy();

    await mainWindow.evaluate(async (nid) => window.electronAPI.notesDelete(nid), id);
});

test('nt2) encrypted note — wrong password yields locked', async () => {
    const id = await mainWindow.evaluate(async () =>
        window.electronAPI.notesSave({
            title: 'enc',
            body: 'secret',
            url_match: 'httpbin.org',
            page_url: 'https://httpbin.org/get',
            is_encrypted: true,
            password: 'notePw12345',
        })
    );
    expect(id).toBeTruthy();

    const locked = await mainWindow.evaluate(async (nid) => window.electronAPI.notesGet(nid, ''), id);
    expect(locked?.locked === true || (locked?.body === '' && locked?.title)).toBeTruthy();

    const ok = await mainWindow.evaluate(async (nid) => window.electronAPI.notesGet(nid, 'notePw12345'), id);
    expect(ok?.body).toContain('secret');

    await mainWindow.evaluate(async (nid) => window.electronAPI.notesDelete(nid), id);
});

test('nt3) pin + embed request IPC', async () => {
    const id = await mainWindow.evaluate(async () =>
        window.electronAPI.notesSave({
            title: 'pin',
            body: 'x',
            url_match: 'httpbin.org',
            page_url: 'https://httpbin.org/get',
            is_encrypted: false,
        })
    );
    await mainWindow.evaluate(async (nid) => window.electronAPI.notesPin(nid, true), id);

    const emb = await mainWindow.evaluate(() =>
        window.electronAPI.notesEmbedRequest({
            requestId: 1,
            url: 'https://example.com/',
            method: 'GET',
        })
    );
    expect(emb === true || emb?.success === true).toBe(true);

    await mainWindow.evaluate(async (nid) => window.electronAPI.notesDelete(nid), id);
});
