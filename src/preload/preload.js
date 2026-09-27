'use strict';
// Bridge between the game page (main world) and our main process. Only a narrow, typed API
// is exposed; the page never gets ipcRenderer itself.
const { contextBridge, ipcRenderer } = require('electron');

const flags = ipcRenderer.sendSync('hwmp:devFlags') || {};

function listen(channel, cb) {
  if (typeof cb !== 'function') return;
  ipcRenderer.on(channel, (_e, ...args) => { try { cb(...args); } catch (err) { console.error(err); } });
}

contextBridge.exposeInMainWorld('hwmp', {
  dev: flags.dev === true,
  devCapture: flags.capture === true,
  modVersion: flags.modVersion || '',
  version: () => ipcRenderer.invoke('hwmp:version'),
  log: (level, message) => ipcRenderer.send('hwmp:log', String(level), String(message).slice(0, 4000)),
  self: () => ipcRenderer.invoke('hwmp:self'),
  avatar: (id) => ipcRenderer.invoke('hwmp:avatar', String(id)),
  openExternal: (url) => ipcRenderer.send('hwmp:openExternal', String(url)),
  lobby: {
    create: (opts) => ipcRenderer.invoke('hwmp:lobby:create', opts),
    join: (id) => ipcRenderer.invoke('hwmp:lobby:join', String(id)),
    leave: () => ipcRenderer.invoke('hwmp:lobby:leave'),
    list: () => ipcRenderer.invoke('hwmp:lobby:list'),
    info: () => ipcRenderer.invoke('hwmp:lobby:info'),
    setData: (data) => ipcRenderer.invoke('hwmp:lobby:setData', data),
    setJoinable: (j) => ipcRenderer.invoke('hwmp:lobby:setJoinable', !!j),
    invite: () => ipcRenderer.invoke('hwmp:lobby:invite'),
    pendingInvite: () => ipcRenderer.invoke('hwmp:lobby:pendingInvite'),
    onUpdate: (cb) => listen('hwmp:lobby:update', cb),
    onInviteAccepted: (cb) => listen('hwmp:lobby:inviteAccepted', cb),
  },
  net: {
    send: (targets, data, reliable) => ipcRenderer.send('hwmp:net:send', targets, data, !!reliable),
    onPacket: (cb) => listen('hwmp:net:packet', cb),
    stats: () => ipcRenderer.invoke('hwmp:net:stats'),
  },
  update: {
    status: () => ipcRenderer.invoke('hwmp:update:status'),
    install: () => ipcRenderer.send('hwmp:update:install'),
    onStatus: (cb) => listen('hwmp:update:status', cb),
  },
});
