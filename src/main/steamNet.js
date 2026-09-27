'use strict';
// Steam lobby + P2P transport (runs in the main process).
// The renderer owns the game protocol; this module only manages the lobby and moves bytes.

const { BrowserWindow } = require('electron');
const { log } = require('./log');

const PROTOCOL_VERSION = 2; // 2: AI racers (host-sent bot messages)
const LOBBY_MARKER = 'hwmp';
const MAX_PACKET = 1200; // Steam unreliable limit; larger messages go reliable
const LobbyType = { private: 0, friends: 1, public: 2, invisible: 3 };
const SendType = { Unreliable: 0, UnreliableNoDelay: 1, Reliable: 2, ReliableWithBuffering: 3 };
const Cb = { LobbyDataUpdate: 4, LobbyChatUpdate: 5, P2PSessionRequest: 6, P2PSessionConnectFail: 7, GameLobbyJoinRequested: 8, PersonaStateChange: 0 };

class SteamNet {
  constructor({ modVersion }) {
    this.client = null;
    this.lobby = null;
    this.modVersion = modVersion;
    this.members = new Set();
    this.handles = [];
    this.pollTimer = null;
    this.memberTimer = null;
    this.pendingInvite = null;
    this.stats = { rx: 0, tx: 0, rxBytes: 0, txBytes: 0 };
  }

  attach(client) {
    this.client = client;
    const reg = (id, fn) => {
      try { this.handles.push(client.callback.register(id, fn)); } catch (e) { console.warn('[hwmp] callback register failed', id, e.message); }
    };
    reg(Cb.P2PSessionRequest, ({ remote }) => {
      const id = String(remote);
      // Only accept P2P sessions from people in our lobby.
      if (this.isMember(id)) {
        this.client.networking.acceptP2PSession(BigInt(id));
        log.info(`[hwmp] accepted P2P session from ${id}`);
      } else {
        log.warn(`[hwmp] ignored P2P session request from non-member ${id}`);
      }
    });
    reg(Cb.P2PSessionConnectFail, ({ remote, error }) => {
      log.warn(`[hwmp] P2P connection to ${String(remote)} failed (error ${error})`);
      this.emit('hwmp:net:connectFail', String(remote), error);
    });
    reg(Cb.LobbyChatUpdate, ({ lobby }) => { if (this.lobby && String(lobby) === String(this.lobby.id)) this.refreshMembers(); });
    reg(Cb.LobbyDataUpdate, ({ lobby }) => { if (this.lobby && String(lobby) === String(this.lobby.id)) this.pushLobby(); });
    reg(Cb.GameLobbyJoinRequested, (e) => {
      const lobbyId = String(e.lobby_steam_id ?? e.lobby ?? '');
      if (!lobbyId) return;
      this.pendingInvite = lobbyId;
      this.emit('hwmp:lobby:inviteAccepted', lobbyId);
    });
    this.pollTimer = setInterval(() => this.poll(), 4);
    this.memberTimer = setInterval(() => { if (this.lobby) this.refreshMembers(); }, 2000);
  }

  get available() { return this.client !== null; }

  self() {
    if (!this.client) return null;
    const id = this.client.localplayer.getSteamId();
    return { steamId: id.steamId64.toString(), name: this.client.localplayer.getName() };
  }

  emit(channel, ...args) {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
  }

  lobbyInfo(lobby = this.lobby) {
    if (!lobby) return null;
    let data = {};
    try { data = lobby.getFullData() || {}; } catch {}
    let owner = null;
    try { owner = lobby.getOwner().steamId64.toString(); } catch {}
    let members = [];
    try { members = lobby.getMembers().map((m) => m.steamId64.toString()); } catch {}
    let limit = null;
    try { limit = Number(lobby.getMemberLimit() ?? 0) || null; } catch {}
    return { id: String(lobby.id), owner, members, limit, data };
  }

  /** Membership check; on a miss, re-read the lobby first (Steam may not have told us yet). */
  isMember(id) {
    if (this.members.has(id)) return true;
    if (!this.lobby) return false;
    const now = Date.now();
    if (now - (this.lastMissRefresh || 0) < 250) return false;
    this.lastMissRefresh = now;
    this.refreshMembers();
    return this.members.has(id);
  }

  refreshMembers() {
    if (!this.lobby) return;
    const info = this.lobbyInfo();
    const next = new Set(info.members);
    const self = this.self()?.steamId;
    next.delete(self);
    this.members = next;
    // Polled every 2s: only tell the page when something changed (a re-render resets its UI state).
    const sig = JSON.stringify(info);
    if (sig === this.lastInfoSig) return;
    if (!this.lastInfoSig || JSON.parse(this.lastInfoSig).members.length !== info.members.length) {
      log.info(`[hwmp] lobby ${info.id}: ${info.members.length} member(s), owner ${info.owner}`);
    }
    this.lastInfoSig = sig;
    this.emit('hwmp:lobby:update', info);
  }

  pushLobby() { this.refreshMembers(); }

  async create({ type = 'friends', maxMembers = 8, data = {} }) {
    this.leave(true);
    const lobby = await this.client.matchmaking.createLobby(LobbyType[type] ?? LobbyType.friends, Math.max(2, Math.min(16, maxMembers | 0)));
    this.lobby = lobby;
    log.info(`[hwmp] created lobby ${lobby.id} (${type})`);
    lobby.mergeFullData({
      [LOBBY_MARKER]: '1',
      proto: String(PROTOCOL_VERSION),
      modVersion: this.modVersion,
      ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])),
    });
    this.refreshMembers();
    return this.lobbyInfo();
  }

  async join(lobbyId) {
    if (this.lobby && String(this.lobby.id) === String(lobbyId)) return this.lobbyInfo();
    this.leave(true);
    const lobby = await this.client.matchmaking.joinLobby(BigInt(lobbyId));
    const data = lobby.getFullData() || {};
    if (data[LOBBY_MARKER] !== '1') { lobby.leave(); throw new Error('Not a Happy Wheels Multiplayer lobby'); }
    if (data.proto !== String(PROTOCOL_VERSION)) {
      lobby.leave();
      throw new Error(`Version mismatch: lobby uses mod ${data.modVersion || '?'}, you have ${this.modVersion}. Restart to update.`);
    }
    this.lobby = lobby;
    log.info(`[hwmp] joined lobby ${lobby.id}`);
    this.refreshMembers();
    return this.lobbyInfo();
  }

  /** silent: switching lobbies; the renderer resets its own state when it enters the new one. */
  leave(silent = false) {
    if (!this.lobby) return;
    log.info(`[hwmp] left lobby ${this.lobby.id}`);
    try { this.lobby.leave(); } catch {}
    this.lobby = null;
    this.members = new Set();
    this.lastInfoSig = null;
    if (!silent) this.emit('hwmp:lobby:update', null);
  }

  async list() {
    const lobbies = await this.client.matchmaking.getLobbies();
    const out = [];
    for (const l of lobbies) {
      const info = this.lobbyInfo(l);
      if (info && info.data[LOBBY_MARKER] === '1') {
        info.compatible = info.data.proto === String(PROTOCOL_VERSION);
        out.push(info);
      }
    }
    return out;
  }

  setData(data) {
    if (!this.lobby) return false;
    const self = this.self()?.steamId;
    if (this.lobbyInfo().owner !== self) return false;
    return this.lobby.mergeFullData(Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])));
  }

  setJoinable(joinable) { return this.lobby ? this.lobby.setJoinable(Boolean(joinable)) : false; }

  invite() { if (this.lobby) this.lobby.openInviteDialog(); }

  send(targets, data, reliable) {
    if (!this.client || !this.lobby) return 0;
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const type = reliable || buf.length > MAX_PACKET ? SendType.Reliable : SendType.UnreliableNoDelay;
    let sent = 0;
    for (const t of targets) {
      if (!this.members.has(t)) continue;
      let ok = false;
      try { ok = this.client.networking.sendP2PPacket(BigInt(t), type, buf); } catch {}
      if (ok) { sent++; this.stats.tx++; this.stats.txBytes += buf.length; } else this.logSendFailure(t, type);
    }
    return sent;
  }

  /** At most one line per peer every 10s, so a dead connection can't flood the log. */
  logSendFailure(peer, type) {
    this.sendFailLog ||= new Map();
    const now = Date.now();
    if (now - (this.sendFailLog.get(peer) || 0) < 10000) return;
    this.sendFailLog.set(peer, now);
    log.warn(`[hwmp] Steam refused to send a ${type === SendType.Reliable ? 'reliable' : 'fast'} packet to ${peer}`);
  }

  poll() {
    if (!this.client) return;
    const net = this.client.networking;
    for (let i = 0; i < 256; i++) {
      let size = 0;
      try { size = net.isP2PPacketAvailable(); } catch { return; }
      if (!size) return;
      let pkt;
      try { pkt = net.readP2PPacket(size); } catch { return; }
      const from = pkt.steamId.steamId64.toString();
      if (!this.isMember(from)) continue; // drop traffic from outside the lobby
      this.stats.rx++; this.stats.rxBytes += pkt.data.length;
      this.emit('hwmp:net:packet', from, new Uint8Array(pkt.data));
    }
  }

  avatar(steamId) {
    try {
      const a = steamId === this.self()?.steamId ? this.client.localplayer.getAvatar() : this.client.friends.getFriendAvatar(BigInt(steamId));
      return a ? { width: a.width, height: a.height, rgba: a.data.toString('base64') } : null;
    } catch {
      return null;
    }
  }

  takePendingInvite() { const p = this.pendingInvite; this.pendingInvite = null; return p; }

  shutdown() {
    this.leave();
    clearInterval(this.pollTimer);
    clearInterval(this.memberTimer);
    for (const h of this.handles) { try { h.disconnect(); } catch {} }
    this.handles = [];
  }
}

module.exports = { SteamNet, PROTOCOL_VERSION };
