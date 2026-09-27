'use strict';
// IPC surface for the renderer's multiplayer code. Works with any transport implementing the
// SteamNet interface (SteamNet in production, LocalNet for local multi-instance testing).

const { ipcMain } = require('electron');

function registerNetIpc(getImpl, isTrustedSender) {
  const handle = (ch, fn) => ipcMain.handle(ch, async (e, ...args) => {
    if (!isTrustedSender(e)) throw new Error('untrusted sender');
    const impl = getImpl();
    if (!impl || !impl.available) throw new Error('Steam is not running. Start Steam, then restart Happy Wheels Multiplayer.');
    return fn(impl, ...args);
  });
  handle('hwmp:self', (n) => n.self());
  handle('hwmp:lobby:create', (n, opts) => n.create(opts && typeof opts === 'object' ? opts : {}));
  handle('hwmp:lobby:join', (n, id) => {
    if (!/^\d{1,20}$/.test(String(id))) throw new Error('Invalid lobby id');
    return n.join(String(id));
  });
  handle('hwmp:lobby:leave', (n) => n.leave());
  handle('hwmp:lobby:list', (n) => n.list());
  handle('hwmp:lobby:info', (n) => n.lobbyInfo());
  handle('hwmp:lobby:setData', (n, d) => {
    if (!d || typeof d !== 'object') return false;
    const clean = {};
    for (const [k, v] of Object.entries(d).slice(0, 16)) if (/^[a-zA-Z0-9_]{1,24}$/.test(k)) clean[k] = String(v).slice(0, 128);
    return n.setData(clean);
  });
  handle('hwmp:lobby:setJoinable', (n, j) => n.setJoinable(!!j));
  handle('hwmp:lobby:invite', (n) => n.invite());
  handle('hwmp:lobby:pendingInvite', (n) => n.takePendingInvite());
  handle('hwmp:avatar', (n, id) => (/^\d{1,20}$/.test(String(id)) ? n.avatar(String(id)) : null));
  handle('hwmp:net:stats', (n) => ({ ...n.stats }));
  ipcMain.on('hwmp:net:send', (e, targets, data, reliable) => {
    if (!isTrustedSender(e) || !Array.isArray(targets) || targets.length > 32 || !(data instanceof Uint8Array) || data.byteLength > 256 * 1024) return;
    const impl = getImpl();
    if (impl && impl.available) impl.send(targets.map(String), data, !!reliable);
  });
}

module.exports = { registerNetIpc };
