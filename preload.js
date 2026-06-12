'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onStrike:   (cb) => ipcRenderer.on('strike',    (_e, d) => cb(d)),
  onWsStatus: (cb) => ipcRenderer.on('ws-status', (_e, s) => cb(s)),
  onWsStats:  (cb) => ipcRenderer.on('ws-stats',  (_e, s) => cb(s)),
  reverseGeocode: (lat, lon) => ipcRenderer.invoke('reverse-geocode', { lat, lon }),
});
