'use strict';
// Preload for the launcher window only.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  ready: () => ipcRenderer.send('launcher:ready'),
  action: (id) => ipcRenderer.send('launcher:action', String(id)),
  onState: (cb) => ipcRenderer.on('launcher:state', (_e, state) => cb(state)),
});
