'use strict';
// DEV ONLY transport: emulates Steam lobbies + P2P over a localhost TCP relay so several game
// instances on one machine can race each other. Enabled with HWMP_LOCAL_NET=1.

const net = require('node:net');
const crypto = require('node:crypto');
const { BrowserWindow } = require('electron');

const PORT = 47850;

function frame(obj) { return `${JSON.stringify(obj)}\n`; }

function lineReader(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line) { try { onLine(JSON.parse(line)); } catch {} } }
  };
}

// ---- relay server (started by whichever dev instance comes up first) ----
function startRelay() {
  const clients = new Map(); // id -> socket
  const lobbies = new Map(); // id -> { id, owner, members:[], data:{} }
  const memberOf = new Map();
  const info = (l) => ({ id: l.id, owner: l.owner, members: l.members.slice(), limit: 8, data: { ...l.data } });
  const push = (l) => { for (const m of l.members) clients.get(m)?.write(frame({ op: 'lobby', info: info(l) })); };
  const leave = (id) => {
    const lid = memberOf.get(id);
    const l = lid && lobbies.get(lid);
    memberOf.delete(id);
    if (!l) return;
    l.members = l.members.filter((m) => m !== id);
    clients.get(id)?.write(frame({ op: 'lobby', info: null }));
    if (!l.members.length) { lobbies.delete(l.id); return; }
    if (l.owner === id) l.owner = l.members[0];
    push(l);
  };
  const server = net.createServer((sock) => {
    let me = null;
    sock.setNoDelay(true);
    sock.on('data', lineReader((m) => {
      const reply = (value, error) => sock.write(frame({ op: 'result', req: m.req, value, error }));
      switch (m.op) {
        case 'hello': me = String(m.id); clients.set(me, sock); break;
        case 'create': {
          leave(me);
          const id = String(BigInt(`0x${crypto.randomBytes(7).toString('hex')}`) + 109775240000000000n);
          const l = { id, owner: me, members: [me], data: m.data || {} };
          lobbies.set(id, l); memberOf.set(me, id);
          reply(info(l)); push(l); break;
        }
        case 'join': {
          const l = lobbies.get(String(m.lobby));
          if (!l) { reply(null, 'Lobby not found'); break; }
          leave(me);
          l.members.push(me); memberOf.set(me, l.id);
          reply(info(l)); push(l); break;
        }
        case 'leave': leave(me); reply(true); break;
        case 'list': reply([...lobbies.values()].map(info)); break;
        case 'setData': { const l = lobbies.get(memberOf.get(me)); if (l && l.owner === me) { Object.assign(l.data, m.data); push(l); } reply(true); break; }
        case 'send': {
          const l = lobbies.get(memberOf.get(me));
          if (!l) break;
          for (const t of m.to) if (l.members.includes(t)) clients.get(t)?.write(frame({ op: 'packet', from: me, data: m.data }));
          break;
        }
        default:
      }
    }));
    const drop = () => { if (me) { leave(me); clients.delete(me); } };
    sock.on('close', drop);
    sock.on('error', drop);
  });
  server.listen(PORT, '127.0.0.1');
  return server;
}

class LocalNet {
  constructor({ name }) {
    this.id = String(76561190000000000n + BigInt(crypto.randomInt(1, 99999999)));
    this.name = name || `Dev${this.id.slice(-3)}`;
    this.lobby = null;
    this.members = new Set();
    this.reqs = new Map();
    this.reqId = 0;
    this.sock = null;
    this.stats = { rx: 0, tx: 0, rxBytes: 0, txBytes: 0 };
  }

  async connect() {
    const tryConnect = () => new Promise((resolve, reject) => {
      const s = net.connect(PORT, '127.0.0.1');
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    try { this.sock = await tryConnect(); } catch { startRelay(); await new Promise((r) => setTimeout(r, 150)); this.sock = await tryConnect(); }
    this.sock.setNoDelay(true);
    this.sock.on('data', lineReader((m) => this.onMsg(m)));
    this.sock.write(frame({ op: 'hello', id: this.id }));
  }

  emit(ch, ...a) { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(ch, ...a); }

  onMsg(m) {
    if (m.op === 'result') { const r = this.reqs.get(m.req); this.reqs.delete(m.req); if (r) (m.error ? r.reject(new Error(m.error)) : r.resolve(m.value)); return; }
    if (m.op === 'lobby') {
      this.lobby = m.info;
      this.members = new Set((m.info?.members || []).filter((x) => x !== this.id));
      this.emit('hwmp:lobby:update', m.info);
      return;
    }
    if (m.op === 'packet' && this.members.has(m.from)) {
      const data = Buffer.from(m.data, 'base64');
      this.stats.rx++; this.stats.rxBytes += data.length;
      this.emit('hwmp:net:packet', m.from, new Uint8Array(data));
    }
  }

  req(op, extra) {
    return new Promise((resolve, reject) => {
      const req = ++this.reqId;
      this.reqs.set(req, { resolve, reject });
      this.sock.write(frame({ op, req, ...extra }));
    });
  }

  get available() { return true; }
  self() { return { steamId: this.id, name: this.name }; }
  async create({ data = {} } = {}) { const i = await this.req('create', { data: { hwmp: '1', proto: '1', ...data } }); this.lobby = i; return i; }
  async join(id) { const i = await this.req('join', { lobby: id }); this.lobby = i; return i; }
  leave() { if (this.lobby) this.req('leave').catch(() => {}); this.lobby = null; this.members = new Set(); }
  async list() { return (await this.req('list')).map((l) => ({ ...l, compatible: true })); }
  lobbyInfo() { return this.lobby; }
  setData(d) { this.req('setData', { data: d }).catch(() => {}); return true; }
  setJoinable() { return true; }
  invite() {}
  takePendingInvite() { return null; }
  avatar() { return null; }
  send(targets, data) {
    const to = targets.filter((t) => this.members.has(t));
    if (!to.length) return 0;
    this.stats.tx += to.length; this.stats.txBytes += data.byteLength * to.length;
    this.sock.write(frame({ op: 'send', to, data: Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64') }));
    return to.length;
  }
  shutdown() { try { this.sock?.destroy(); } catch {} }
}

module.exports = { LocalNet };
