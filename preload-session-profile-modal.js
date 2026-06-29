'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sessionProfileAPI', {
    pickSessionProfileFile: () => ipcRenderer.invoke('pick-session-profile-file'),
    readSessionProfileFile: (path) => ipcRenderer.invoke('read-session-profile-file', path),
    loadSessionProfile: (payload) => ipcRenderer.invoke('load-session-profile', payload),
    validateProfile: (profile) => ipcRenderer.invoke('validate-launch-profile', profile),
    getLastLaunchProfilePath: () => ipcRenderer.invoke('get-last-launch-profile-path'),
    setLastLaunchProfilePath: (path) => ipcRenderer.invoke('set-last-launch-profile-path', path),
    closeModal: () => ipcRenderer.send('close-session-profile-modal'),
});
