'use strict';

/**
 * E2E (A-054): a proxied tab must not expose the host's public IP through WebRTC.
 * A local CONNECT proxy is used as the upstream (HTTP-only, so it can never carry STUN/UDP): any
 * srflx candidate gathered in a proxied tab means STUN went around the proxy.
 * Needs network (stun.l.google.com). Run:
 *   CUPNET_MITM_PORT=18877 npx playwright test tests/e2e/webrtc-leak.e2e.spec.js
 */

const http = require('http');
const net = require('net');
const { test, expect } = require('@playwright/test');
const { launchCupnet, getMainWindow, waitForAppContext, waitMitmReady, navigateAndWait } = require('./helpers.js');

const ICE_PAGE = `<!doctype html><title>ice</title><script>
window.__ice = new Promise((resolve) => {
  const out = [];
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pc.createDataChannel('x');
  pc.onicecandidate = (e) => { if (e.candidate) out.push(e.candidate.candidate); else resolve(out); };
  pc.createOffer().then((o) => pc.setLocalDescription(o));
  setTimeout(() => resolve(out), 12000);
});
</script>`;

test.describe.configure({ mode: 'serial' });

let electronApp;
let upstreamServer;
let pageServer;
let upstreamUrl;
let pageUrl;

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** ICE candidates and the WebRTC policy of the active tab after loading the ICE page. */
async function gatherActiveTab() {
    await navigateAndWait(electronApp, pageUrl, 60_000, { urlIncludes: '127.0.0.1', allowEmptyBody: true });
    return electronApp.evaluate(async () => {
        const wc = globalThis.__cupnetAppContext.modules.tabManager.getActiveTab().view.webContents;
        return { policy: wc.getWebRTCIPHandlingPolicy(), candidates: await wc.executeJavaScript('window.__ice') };
    });
}

const srflx = (candidates) => candidates.filter((c) => / typ srflx /.test(c));

test.beforeAll(async () => {
    upstreamServer = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
    upstreamServer.on('connect', (req, sock, head) => {
        const [host, port] = req.url.split(':');
        const up = net.connect(Number(port) || 443, host, () => {
            sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            up.write(head);
            up.pipe(sock);
            sock.pipe(up);
        });
        up.on('error', () => sock.destroy());
        sock.on('error', () => up.destroy());
    });
    upstreamUrl = `http://127.0.0.1:${await listen(upstreamServer)}`;
    pageServer = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(ICE_PAGE); });
    pageUrl = `http://127.0.0.1:${await listen(pageServer)}/ice.html`;

    electronApp = await launchCupnet();
    await getMainWindow(electronApp, 120_000);
    await waitForAppContext(electronApp, 120_000);
    await waitMitmReady(electronApp, 180_000);
});

test.afterAll(async () => {
    if (electronApp) await electronApp.close();
    upstreamServer?.close();
    pageServer?.close();
});

test('w1) global upstream: no srflx candidate, policy disable_non_proxied_udp', async () => {
    await electronApp.evaluate(async (_e, up) => {
        const ctx = globalThis.__cupnetAppContext;
        ctx.modules.mitmProxy.setUpstream(up);
        await ctx.modules.tabManager.setProxyAll(up);
    }, upstreamUrl);
    const r = await gatherActiveTab();
    expect(r.policy).toBe('disable_non_proxied_udp');
    expect(srflx(r.candidates)).toEqual([]);
});

test('w2) a tab created while proxied gets the policy too', async () => {
    const policy = await electronApp.evaluate(async () => {
        const tm = globalThis.__cupnetAppContext.modules.tabManager;
        const tabId = await tm.createTab({ url: 'about:blank' });
        return tm.getTab(tabId).view.webContents.getWebRTCIPHandlingPolicy();
    });
    expect(policy).toBe('disable_non_proxied_udp');
});

test('w3) per-tab proxy without a global upstream keeps the tab protected', async () => {
    const r = await electronApp.evaluate(async () => {
        const ctx = globalThis.__cupnetAppContext;
        const tm = ctx.modules.tabManager;
        ctx.modules.mitmProxy.setUpstream(null);
        await tm.setProxyAll(null);
        const tab = tm.getActiveTab();
        const direct = tab.view.webContents.getWebRTCIPHandlingPolicy();
        await tm.setTabProxy(tab.id, 999_999);
        const perTab = tab.view.webContents.getWebRTCIPHandlingPolicy();
        await tm.setTabProxy(tab.id, null);
        const cleared = tab.view.webContents.getWebRTCIPHandlingPolicy();
        return { direct, perTab, cleared };
    });
    expect(r).toEqual({ direct: 'default', perTab: 'disable_non_proxied_udp', cleared: 'default' });
});
