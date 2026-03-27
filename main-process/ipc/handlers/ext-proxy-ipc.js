'use strict';

/**
 * Внешние прокси-порты.
 * @param {object} ctx
 */
function registerExtProxyIpc(ctx) {
    // ── External Proxy Ports ──────────────────────────────────────────────────

    async function startExtPort(config) {
        if (ctx.activeExtPorts.has(config.port)) return ctx.activeExtPorts.get(config.port);
        const sess = await ctx.db.createExternalSessionAsync(`ext:${config.port}`, `ext_${config.port}`, config.port);
        const instance = new ctx.ExternalProxyPort(ctx.mitmProxy, {
            port: config.port,
            login: config.login,
            password: config.password,
            name: config.name,
            sessionId: sess.id,
            followRedirects: config.followRedirects || false,
            onRequestLogged: (entry) => {
                if (!ctx.db) return;
                try {
                    const logEntry = {
                        id: `ext_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
                        url: entry.url,
                        method: entry.method,
                        status: entry.status,
                        type: entry.type || 'Document',
                        request: { headers: entry.requestHeaders || {}, body: entry.requestBody || null },
                        response: { statusCode: entry.status, headers: entry.responseHeaders || {}, mimeType: null },
                        duration: entry.duration,
                        duration_ms: entry.duration,
                        responseBody: entry.responseBody || null,
                        source: 'external',
                        extPort: entry.extPort,
                        extName: entry.extName,
                    };
                    ctx.db.insertRequestAsync(entry.sessionId, entry.tabId, {
                        requestId: logEntry.id,
                        url: logEntry.url,
                        method: logEntry.method,
                        status: logEntry.response?.statusCode,
                        type: logEntry.type,
                        duration: logEntry.duration,
                        requestHeaders: logEntry.request?.headers,
                        responseHeaders: logEntry.response?.headers,
                        requestBody: entry.requestBody || null,
                        responseBody: logEntry.responseBody,
                    }).then((dbId) => {
                        if (dbId) logEntry.id = dbId;
                        ctx._broadcastLogEntryToViewers({ ...logEntry, tabId: entry.tabId, sessionId: entry.sessionId });
                    }).catch((err) => {
                        ctx.sysLog('warn', 'ext-proxy', `Log insert failed for port ${config.port}: ${err?.message || err}`);
                    });
                } catch (e) { ctx.sysLog('warn', 'ext-proxy', `Log insert failed for port ${config.port}: ${e?.message}`); }
            },
        });
        try {
            await instance.start();
            ctx.extPortErrors.delete(config.port);
        } catch (e) {
            ctx.extPortErrors.set(config.port, e.message);
            ctx.sysLog('error', 'ext-proxy', `Failed to start port ${config.port}: ${e.message}`);
            throw e;
        }
        ctx.activeExtPorts.set(config.port, { instance, sessionId: sess.id, config });
        ctx.sysLog('info', 'ext-proxy', `Started external proxy on port ${config.port} → session #${sess.id}`);
        return ctx.activeExtPorts.get(config.port);
    }

    async function stopExtPort(port) {
        const entry = ctx.activeExtPorts.get(port);
        if (!entry) return;
        entry.instance.stop();
        if (entry.sessionId) await ctx.db.endSessionAsync(entry.sessionId);
        ctx.activeExtPorts.delete(port);
        ctx.extPortErrors.delete(port);
        ctx.sysLog('info', 'ext-proxy', `Stopped external proxy on port ${port}`);
    }

    function getExtPortsList() {
        const localIp = ctx.getLocalIp();
        const list = [];
        const config = ctx.extPortsStore.loadExtPortsConfig();
        for (const c of config.ports) {
            const active = ctx.activeExtPorts.get(c.port);
            const reqCount = active?.sessionId ? (ctx.db.countRequests({ sessionId: active.sessionId }) || 0) : 0;
            list.push({
                port: c.port,
                name: c.name,
                login: c.login,
                password: c.password,
                autoStart: c.autoStart ?? false,
                followRedirects: c.followRedirects ?? false,
                active: !!active,
                sessionId: active?.sessionId || null,
                requestCount: reqCount,
                error: ctx.extPortErrors.get(c.port) || null,
                localIp,
                effectiveMode: ctx.getCurrentTrafficMode(),
            });
        }
        return list;
    }

    ctx.ipcMain.handle('ext-proxy:list', () => getExtPortsList());

    ctx.ipcMain.handle('ext-proxy:create', async (_, opts) => {
        try {
            const port = parseInt(opts.port, 10);
            if (!port || port < 1024 || port > 65535) return { success: false, error: 'Port must be 1024-65535' };
            const config = ctx.extPortsStore.loadExtPortsConfig();
            if (config.ports.find(p => p.port === port)) return { success: false, error: `Port ${port} already configured` };
            const entry = {
                port,
                name: opts.name || `External :${port}`,
                login: opts.login || 'cupnet',
                password: opts.password || ctx.generatePassword(),
                autoStart: opts.autoStart ?? true,
            };
            config.ports.push(entry);
            ctx.extPortsStore.saveExtPortsConfig(config);
            await startExtPort(entry);
            return { success: true, port, password: entry.password };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ctx.ipcMain.handle('ext-proxy:start', async (_, port) => {
        try {
            const config = ctx.extPortsStore.loadExtPortsConfig();
            const entry = config.ports.find(p => p.port === port);
            if (!entry) return { success: false, error: 'Port not found' };
            if (ctx.activeExtPorts.has(port)) return { success: true, already: true };
            await startExtPort(entry);
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ctx.ipcMain.handle('ext-proxy:stop', async (_, port) => {
        try {
            await stopExtPort(port);
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ctx.ipcMain.handle('ext-proxy:delete', async (_, port) => {
        try {
            await stopExtPort(port);
            const config = ctx.extPortsStore.loadExtPortsConfig();
            config.ports = config.ports.filter(p => p.port !== port);
            ctx.extPortsStore.saveExtPortsConfig(config);
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ctx.ipcMain.handle('ext-proxy:reset-session', async (_, port) => {
        try {
            const entry = ctx.activeExtPorts.get(port);
            if (!entry) return { success: false, error: 'Port not active' };
            if (entry.sessionId) await ctx.db.endSessionAsync(entry.sessionId);
            const sess = await ctx.db.createExternalSessionAsync(`ext:${port}`, `ext_${port}`, port);
            entry.sessionId = sess.id;
            entry.instance.sessionId = sess.id;
            entry.instance._reqCount = 0;
            ctx.sysLog('info', 'ext-proxy', `Reset session for port ${port} → new session #${sess.id}`);
            return { success: true, sessionId: sess.id };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ctx.ipcMain.handle('ext-proxy:get-local-ip', () => ctx.getLocalIp());

    ctx.ipcMain.handle('ext-proxy:set-port', async (_, oldPort, newPort) => {
        try {
            const port = parseInt(newPort, 10);
            if (!port || port < 1024 || port > 65535) return { success: false, error: 'Port must be 1024-65535' };
            const config = ctx.extPortsStore.loadExtPortsConfig();
            const entry = config.ports.find(p => p.port === oldPort);
            if (!entry) return { success: false, error: 'Port config not found' };
            const wasActive = ctx.activeExtPorts.has(oldPort);
            if (wasActive) await stopExtPort(oldPort);
            entry.port = port;
            ctx.extPortsStore.saveExtPortsConfig(config);
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });

    ctx.ipcMain.handle('ext-proxy:set-redirects', async (_, port, follow) => {
        try {
            const config = ctx.extPortsStore.loadExtPortsConfig();
            const entry = config.ports.find(p => p.port === port);
            if (!entry) return { success: false, error: 'Port not found' };
            entry.followRedirects = !!follow;
            ctx.extPortsStore.saveExtPortsConfig(config);
            const active = ctx.activeExtPorts.get(port);
            if (active?.instance) active.instance.followRedirects = !!follow;
            return { success: true };
        } catch (e) { return { success: false, error: e.message }; }
    });
}

module.exports = { registerExtProxyIpc };
