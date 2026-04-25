'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('breakpointAPI', {
    onBreakpointSet: (cb) => {
        ipcRenderer.on('breakpoint-set', (_e, payload) => {
            try { cb(payload); } catch { /* ignore */ }
        });
    },
    resume: (payload) => ipcRenderer.invoke('breakpoint-resume', payload),
});
