'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let _updateCb = null;
let _pendingData = null;

ipcRenderer.on('omnibox-overlay-update', (_, data) => {
    if (_updateCb) _updateCb(data);
    else _pendingData = data;
});

contextBridge.exposeInMainWorld('omniboxOverlay', {
    onUpdate(cb) {
        _updateCb = cb;
        if (_pendingData) { cb(_pendingData); _pendingData = null; }
    },
    selectItem: (idx) => ipcRenderer.send('omnibox-overlay-select', idx),
    dismiss:    ()    => ipcRenderer.send('omnibox-overlay-dismiss'),
});
