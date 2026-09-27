// Lobby + race state machine. The Steam lobby owner is the host and is authoritative for race
// control (load, start, results). Body state is streamed peer-to-peer by every player.

import { log } from '../log.js';
import { T, encodeState, decodeState, encodeCtrl, decodeCtrl, encodePing, decodePing, V, cleanText } from './protocol.js';
import { Clock } from './clock.js';
import { sampleBodies, MAX_BODIES } from '../game/character.js';

const COUNTDOWN_MS = 3500;
const READY_TIMEOUT_MS = 30000;
const PREF_KEY = 'hwmp.prefs';

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch { return {}; }
}
function savePrefs(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch {} }

export class Multiplayer {
  constructor(transport, bridge) {
    this.tx = transport;
    this.bridge = bridge;
    this.clock = new Clock();
    this.listeners = new Set();
    this.prefs = { character: 1, collisions: false, graceSec: 45, lobbyType: 'public', ...loadPrefs() };
    this.self = null;          // { id, name }
    this.lobby = null;         // { id, owner, members, data }
    this.players = new Map();  // id -> player
    this.settings = { level: null, collisions: !!this.prefs.collisions, forceCharacter: 0, graceSec: this.prefs.graceSec, name: '' };
    this.phase = 'idle';       // idle | lobby | loading | countdown | racing | results
    this.race = null;          // { id, level, participants, goAt, finishes: {id: ms}, dnf: Set, deadline, forceCharacter, collisions }
    this.raceCounter = 0;
    this.chat = [];
    this.playedLevels = new Set(); // level ids raced in this lobby, for 'random unplayed level'
    this.pingId = 0;
    this.pendingPings = new Map();
    this.peerSerial = new Map(); // peer -> session serial of their current puppet
    this.samples = new Float64Array(MAX_BODIES * 6);
    this.localSerial = 0;
    this.finished = false;
    this.goTimer = null;
    this.readyTimer = null;
    this.graceTimer = null;
    this.broadcastTimer = null;
    this.error = null;
  }

  // ---- plumbing ------------------------------------------------------------------------------
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { for (const fn of this.listeners) { try { fn(this); } catch (e) { log.error(e); } } }
  toast(text, kind = 'info') {
    (kind === 'error' ? log.warn : log.info)('toast:', text);
    for (const fn of this.listeners) { try { fn(this, { toast: text, kind }); } catch {} }
  }

  get isHost() { return !!(this.lobby && this.self && this.lobby.owner === this.self.id); }
  get hostId() { return this.lobby ? this.lobby.owner : null; }
  peers() { return this.lobby ? this.lobby.members.filter((m) => m !== this.self.id) : []; }

  send(targets, bytes, reliable) { if (targets.length) this.tx.net.send(targets, bytes, reliable); }
  sendAll(obj) { this.send(this.peers(), encodeCtrl(obj), true); }
  sendTo(id, obj) { if (id && id !== this.self.id) this.send([id], encodeCtrl(obj), true); }
  sendHost(obj) { if (this.isHost) this.onCtrl(this.self.id, obj); else this.sendTo(this.hostId, obj); }

  async start() {
    const me = await this.tx.self().catch(() => null);
    this.self = me ? { id: String(me.steamId), name: me.name } : null;
    this.tx.net.onPacket((from, bytes) => this.onPacket(from, bytes));
    this.tx.lobby.onUpdate((info) => this.onLobbyUpdate(info));
    this.tx.lobby.onInviteAccepted((id) => this.join(id).catch((e) => this.toast(e.message, 'error')));
    const pending = await this.tx.lobby.pendingInvite().catch(() => null);
    if (pending) this.join(pending).catch((e) => this.toast(e.message, 'error'));

    const b = this.bridge;
    b.now = () => this.clock.now();
    b.on('sessionStart', (s, serial) => this.onLocalSessionStart(s, serial));
    b.on('step', () => this.onLocalStep());
    b.on('localEvent', (path, method, args) => this.onLocalEvent(path, method, args));
    b.on('levelComplete', () => this.onLocalFinish());
    b.on('exitedToMenu', () => this.onLocalExit());
    setInterval(() => this.pingHost(), 500);
    // Handshake repair: keep greeting lobby members we haven't heard from (a dropped hello would
    // otherwise leave them missing from the player list).
    setInterval(() => {
      if (!this.lobby || !this.self) return;
      for (const m of this.peers()) if (!this.players.has(m)) this.sendTo(m, this.helloMsg());
    }, 3000);
    // Host safety net: re-check race completion (covers finish windows inherited from a previous host).
    setInterval(() => { if (this.isHost && this.race && (this.phase === 'racing' || this.phase === 'countdown')) this.checkRaceProgress(); }, 1000);
    this.changed();
  }

  // ---- lobby management ----------------------------------------------------------------------
  async create() {
    const name = `${this.self?.name || 'Player'}'s race`;
    this.settings.name = name;
    const info = await this.tx.lobby.create({ type: this.prefs.lobbyType, maxMembers: 8, data: this.lobbySummary() });
    this.enterLobby(info);
  }

  async join(lobbyId) {
    if (this.lobby && this.lobby.id === String(lobbyId)) return;
    const info = await this.tx.lobby.join(String(lobbyId));
    this.enterLobby(info);
  }

  async leave() {
    this.resetRace(true);
    await this.tx.lobby.leave().catch(() => {});
    this.lobby = null;
    this.players.clear();
    this.phase = 'idle';
    this.changed();
  }

  list() { return this.tx.lobby.list(); }
  invite() { return this.tx.lobby.invite(); }

  enterLobby(info) {
    this.resetRace(true);
    this.lobby = info;
    this.phase = 'lobby';
    this.chat = [];
    this.playedLevels.clear();
    this.players.clear();
    const me = this.newPlayer(this.self.id, this.self.name);
    me.character = this.prefs.character;
    this.players.set(this.self.id, me);
    this.clock.reset(this.isHost);
    for (const m of info.members) if (m !== this.self.id) this.sendTo(m, this.helloMsg());
    this.changed();
  }

  newPlayer(id, name) {
    return { id, name: cleanText(name || 'Player', 32), ready: false, character: 1, status: 'lobby', finishMs: null, modVersion: '', gameVersion: id === this.self?.id ? this.bridge.gameVersion() : '' };
  }

  helloMsg() {
    return { t: 'hello', name: this.self.name, character: this.prefs.character, ready: !!this.players.get(this.self.id)?.ready, ver: this.tx.modVersion || '', game: this.bridge.gameVersion() };
  }

  onLobbyUpdate(info) {
    if (!info) { if (this.lobby) { this.lobby = null; this.resetRace(true); this.phase = 'idle'; this.players.clear(); this.changed(); } return; }
    if (!this.lobby || info.id !== this.lobby.id) return;
    if (JSON.stringify(info) === JSON.stringify(this.lobby)) return;
    const prevOwner = this.lobby.owner;
    const prevMembers = new Set(this.lobby.members);
    this.lobby = info;
    const now = new Set(info.members);
    for (const m of info.members) {
      if (!prevMembers.has(m) && m !== this.self.id) this.sendTo(m, this.helloMsg());
    }
    for (const id of prevMembers) {
      if (!now.has(id) && id !== this.self.id) {
        const p = this.players.get(id);
        if (p) this.toast(`${p.name} left`);
        this.players.delete(id);
        this.bridge.removePuppet(id);
        this.peerSerial.delete(id);
      }
    }
    if (prevOwner !== info.owner) {
      this.clock.reset(this.isHost);
      if (this.isHost) {
        this.toast('You are now the host');
        this.adoptHostRole();
      }
    }
    if (this.isHost) { this.checkRaceProgress(); this.broadcastLobby(); }
    this.changed();
  }

  lobbySummary() {
    return {
      name: this.settings.name,
      level: this.settings.level ? this.settings.level.name : '',
      levelId: this.settings.level ? this.settings.level.id : 0,
      phase: this.phase === 'idle' ? 'lobby' : this.phase,
      collisions: this.settings.collisions ? 1 : 0,
      game: this.bridge.gameVersion(),
    };
  }

  // Host: send the authoritative lobby snapshot (debounced).
  broadcastLobby() {
    if (!this.isHost) return;
    clearTimeout(this.broadcastTimer);
    this.broadcastTimer = setTimeout(() => {
      const snap = {
        t: 'lobby',
        phase: this.phase,
        settings: this.settings,
        race: this.race ? { id: this.race.id, level: this.race.level, participants: this.race.participants, goAt: this.race.goAt, finishes: this.race.finishes, dnf: [...this.race.dnf], deadline: this.race.deadline, collisions: this.race.collisions, forceCharacter: this.race.forceCharacter, skipVotes: [...this.race.skipVotes] } : null,
        players: [...this.players.values()].map((p) => ({ id: p.id, ready: p.ready, status: p.status, character: p.character })),
      };
      this.sendAll(snap);
      this.tx.lobby.setData(this.lobbySummary()).catch(() => {});
    }, 60);
  }

  adoptHostRole() {
    // Continue an in-flight race with the state we mirrored from the previous host.
    if (this.race && (this.phase === 'loading')) this.scheduleReadyTimeout();
    if (this.race && this.phase === 'racing') this.checkRaceProgress();
  }

  // ---- host actions ---------------------------------------------------------------------------
  setLevel(level) {
    if (!this.isHost) return;
    this.settings.level = level && V.int(level.id, 1, 2e9) ? { id: level.id, name: cleanText(level.name || `Level ${level.id}`, 80), character: level.character | 0, forceChar: !!level.forceChar } : null;
    this.broadcastLobby(); this.changed();
  }
  setCollisions(on) { if (!this.isHost) return; this.settings.collisions = !!on; this.prefs.collisions = !!on; savePrefs(this.prefs); this.broadcastLobby(); this.changed(); }
  setForceCharacter(idx) { if (!this.isHost) return; this.settings.forceCharacter = V.int(idx, 0, 11) ? idx : 0; this.broadcastLobby(); this.changed(); }
  setGrace(sec) { if (!this.isHost) return; this.settings.graceSec = V.int(sec, 10, 600) ? sec : 45; this.prefs.graceSec = this.settings.graceSec; savePrefs(this.prefs); this.broadcastLobby(); this.changed(); }
  setLobbyType(type) { this.prefs.lobbyType = type; savePrefs(this.prefs); }

  /** force: replace a race in progress (skip level). */
  startRace({ force = false } = {}) {
    if (!this.isHost || !this.settings.level) return;
    const idle = this.phase === 'lobby' || this.phase === 'results';
    const racing = this.phase === 'loading' || this.phase === 'countdown' || this.phase === 'racing';
    if (!idle && !(force && racing)) return;
    const participants = [...this.players.keys()];
    this.raceCounter = ((this.race?.id || this.raceCounter) % 60000) + 1;
    const msg = {
      t: 'load',
      race: this.raceCounter,
      level: this.settings.level,
      collisions: this.settings.collisions,
      forceCharacter: this.settings.forceCharacter,
      participants,
    };
    this.sendAll(msg);
    this.onCtrl(this.self.id, msg);
    this.scheduleReadyTimeout();
  }

  /**
   * Host: pick a featured level nobody in this lobby has raced yet (starting over once all have
   * been played) and optionally start it straight away.
   */
  async randomLevel({ start = false, force = false } = {}) {
    if (!this.isHost) return null;
    const all = await this.bridge.featuredLevels();
    const current = this.settings.level && this.settings.level.id;
    let pool = all.filter((l) => !this.playedLevels.has(l.id) && l.id !== current);
    if (!pool.length) {
      this.playedLevels.clear();
      pool = all.filter((l) => l.id !== current);
    }
    if (!pool.length) return null;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    this.setLevel(pick);
    if (start) this.startRace({ force });
    return pick;
  }

  /** Host: abandon the current level and race a random unplayed one. */
  skipLevel() {
    if (!this.isHost || !this.race) return Promise.resolve(null);
    return this.randomLevel({ start: true, force: true }).then((pick) => {
      if (pick) this.sendAll({ t: 'notice', text: `Skipping to ${pick.name}` });
      return pick;
    });
  }

  /** Host: finish the race now with the times recorded so far. */
  endRaceNow() { if (this.isHost && this.race && this.phase !== 'results') this.hostResults(); }

  /** Everyone else: vote to skip; the host skips once half the racers agree. */
  voteSkip() {
    if (!this.race || this.isHost || this.phase === 'results') return;
    this.sendHost({ t: 'voteSkip', race: this.race.id });
    this.race.skipVotes.add(this.self.id);
    this.changed();
  }

  skipVotesNeeded() {
    if (!this.race) return 0;
    const alive = this.race.participants.filter((id) => this.players.has(id));
    return Math.max(1, Math.ceil(alive.length / 2));
  }

  backToLobby() {
    if (!this.isHost) return;
    const msg = { t: 'backToLobby' };
    this.sendAll(msg);
    this.onCtrl(this.self.id, msg);
  }

  scheduleReadyTimeout() {
    clearTimeout(this.readyTimer);
    const race = this.race && this.race.id;
    this.readyTimer = setTimeout(() => { if (this.isHost && this.race && this.race.id === race && this.phase === 'loading') this.hostGo(); }, READY_TIMEOUT_MS);
  }

  hostGo() {
    if (!this.isHost || !this.race || this.phase !== 'loading') return;
    clearTimeout(this.readyTimer);
    const msg = { t: 'start', race: this.race.id, goAt: this.clock.now() + COUNTDOWN_MS };
    this.sendAll(msg);
    this.onCtrl(this.self.id, msg);
  }

  checkRaceProgress() {
    if (!this.isHost || !this.race) return;
    const alive = this.race.participants.filter((id) => this.players.has(id));
    if (this.phase === 'loading') {
      if (alive.length && alive.every((id) => this.players.get(id).status === 'ready' || this.race.dnf.has(id))) this.hostGo();
      return;
    }
    if (this.phase !== 'racing' && this.phase !== 'countdown') return;
    const done = alive.every((id) => this.race.finishes[id] != null || this.race.dnf.has(id));
    const expired = this.race.deadline && this.clock.now() >= this.race.deadline;
    if (done || expired) this.hostResults();
  }

  hostResults() {
    if (!this.isHost || !this.race || this.phase === 'results') return;
    clearTimeout(this.graceTimer);
    const msg = { t: 'results', race: this.race.id, finishes: this.race.finishes, dnf: [...this.race.dnf] };
    this.sendAll(msg);
    this.onCtrl(this.self.id, msg);
  }

  // ---- player actions --------------------------------------------------------------------------
  setCharacter(idx) {
    if (!V.int(idx, 1, 11)) return;
    this.prefs.character = idx; savePrefs(this.prefs);
    const me = this.players.get(this.self?.id);
    if (me) me.character = idx;
    if (this.lobby) this.sendHost({ t: 'setReady', ready: !!me?.ready, character: idx });
    this.changed();
  }

  setReady(ready) {
    const me = this.players.get(this.self?.id);
    if (!me) return;
    me.ready = !!ready;
    this.sendHost({ t: 'setReady', ready: me.ready, character: this.prefs.character });
    this.changed();
  }

  sendChat(text) {
    const clean = cleanText(text, 200).trim();
    if (!clean || !this.lobby) return;
    this.sendAll({ t: 'chat', text: clean });
    this.addChat(this.self.id, clean);
  }

  addChat(id, text) {
    const p = this.players.get(id);
    this.chat.push({ name: p ? p.name : 'Player', text, at: Date.now() });
    if (this.chat.length > 100) this.chat.shift();
    this.changed();
  }

  // ---- race flow (all clients) -----------------------------------------------------------------
  resetRace(clearPuppets) {
    clearTimeout(this.goTimer); clearTimeout(this.readyTimer); clearTimeout(this.graceTimer);
    this.race = null;
    this.finished = false;
    this.bridge.raceMode = false;
    this.bridge.setFrozen(false);
    if (clearPuppets) this.bridge.clearPuppets();
    this.peerSerial.clear();
  }

  onLoad(msg) {
    this.resetRace(true);
    this.race = {
      id: msg.race, level: msg.level, participants: msg.participants, goAt: null,
      finishes: {}, dnf: new Set(), deadline: null, collisions: !!msg.collisions, forceCharacter: msg.forceCharacter | 0,
      skipVotes: new Set(),
    };
    this.phase = 'loading';
    this.playedLevels.add(msg.level.id);
    for (const p of this.players.values()) { p.status = msg.participants.includes(p.id) ? 'loading' : 'spectating'; p.finishMs = null; p.ready = false; }
    const me = this.players.get(this.self.id);
    this.changed();
    if (!msg.participants.includes(this.self.id)) return;
    const b = this.bridge;
    b.raceMode = true;
    b.setCollisions(!!msg.collisions);
    b.setFrozen(true);
    const character = msg.forceCharacter || this.prefs.character;
    b.loadLevel(msg.level.id, { characterIndex: character }).catch((e) => {
      if (!this.race || this.race.id !== msg.race || e.message === 'superseded') return;
      this.toast(`Could not load the level: ${e.message}`, 'error');
      if (me) me.status = 'dnf';
      this.sendAll({ t: 'dnf', race: msg.race });
      this.onCtrl(this.self.id, { t: 'dnf', race: msg.race });
      b.raceMode = false; b.setFrozen(false);
    });
  }

  onStart(msg) {
    if (!this.race || this.race.id !== msg.race) return;
    this.race.goAt = msg.goAt;
    if (this.phase === 'loading') this.phase = 'countdown';
    clearTimeout(this.goTimer);
    const tick = () => {
      if (!this.race || this.race.id !== msg.race) return;
      const left = this.race.goAt - this.clock.now();
      if (left <= 0) {
        if (this.phase === 'countdown') this.phase = 'racing';
        this.bridge.setFrozen(false);
        for (const p of this.players.values()) if (p.status === 'ready') p.status = 'racing';
        this.changed();
      } else {
        this.goTimer = setTimeout(tick, Math.min(left, 50));
      }
    };
    tick();
    this.changed();
  }

  onLocalSessionStart(session, serial) {
    if (!this.race || !this.self) return;
    this.localSerial = serial;
    const info = this.bridge.localCharacterInfo();
    if (Number(info.levelId) !== Number(this.race.level.id)) return;
    // If we (re)started after GO there is nothing to wait for.
    if (this.race.goAt != null && this.clock.now() >= this.race.goAt) this.bridge.setFrozen(false);
    const msg = { t: 'spawn', race: this.race.id, serial: serial & 0xffff, character: info.characterIndex, hideVehicle: info.hideVehicle, layout: info.layout };
    this.sendAll(msg);
    this.onCtrl(this.self.id, msg);
  }

  onLocalStep() {
    if (!this.race || !this.self || this.bridge.frozen) return;
    const s = this.bridge.session;
    if (!s || !s.character) return;
    const peers = this.peers();
    if (!peers.length) return;
    const layout = this.bridge.layout;
    const n = Math.min(layout.length, MAX_BODIES);
    sampleBodies(s.character, layout, this.samples);
    this.send(peers, encodeState(this.race.id, this.localSerial, this.clock.now(), this.samples, n), false);
  }

  onLocalEvent(path, method, args) {
    if (!this.race) return;
    this.sendAll({ t: 'event', race: this.race.id, serial: this.localSerial & 0xffff, path, method, args: args.map((a) => (a === undefined ? null : a)) });
  }

  onLocalFinish() {
    if (!this.race || this.finished || this.race.goAt == null) return;
    if (!this.race.participants.includes(this.self.id)) return;
    this.finished = true;
    const ms = Math.max(0, Math.round(this.clock.now() - this.race.goAt));
    const msg = { t: 'finish', race: this.race.id, ms };
    this.sendAll(msg);
    this.onCtrl(this.self.id, msg);
  }

  onLocalExit() {
    if (!this.race || this.bridge.pendingLoad) return;
    if (this.phase === 'results' || this.finished) return;
    if (!this.race.participants.includes(this.self.id) || this.race.dnf.has(this.self.id)) return;
    log.info('left the race (returned to the main menu)', new Error('exit trace').stack.split('\n').slice(1, 6).join(' | '));
    const msg = { t: 'dnf', race: this.race.id };
    this.sendAll(msg);
    this.onCtrl(this.self.id, msg);
    this.bridge.raceMode = false;
    this.bridge.setFrozen(false);
    this.bridge.clearPuppets();
    this.toast('You left the race');
  }

  // ---- inbound ---------------------------------------------------------------------------------
  onPacket(from, bytes) {
    if (!this.lobby || !this.self || !(bytes instanceof Uint8Array) || !bytes.length) return;
    switch (bytes[0]) {
      case T.STATE: {
        const st = decodeState(bytes);
        if (!st || !this.race || st.race !== this.race.id) return;
        if (this.peerSerial.get(from) !== st.serial) return;
        this.bridge.puppetState(from, st.time, st.data);
        return;
      }
      case T.PING: {
        const p = decodePing(bytes);
        if (p && this.isHost) this.send([from], encodePing(T.PONG, p.id, p.t0, this.clock.now()), false);
        return;
      }
      case T.PONG: {
        const p = decodePing(bytes);
        if (!p || from !== this.hostId || !this.pendingPings.has(p.id)) return;
        this.pendingPings.delete(p.id);
        this.clock.addSample(p.t0, performance.now(), p.hostNow);
        return;
      }
      case T.CTRL: {
        const msg = decodeCtrl(bytes);
        if (msg) this.onCtrl(from, msg);
        return;
      }
      default:
    }
  }

  pingHost() {
    if (!this.lobby || this.isHost || !this.hostId) return;
    const id = ++this.pingId;
    this.pendingPings.set(id, true);
    if (this.pendingPings.size > 20) this.pendingPings.delete(this.pendingPings.keys().next().value);
    this.send([this.hostId], encodePing(T.PING, id, performance.now()), false);
  }

  onCtrl(from, m) {
    const fromHost = from === this.hostId;
    const self = from === this.self.id;
    const player = this.players.get(from);
    const race = this.race;
    switch (m.t) {
      case 'hello': {
        if (!V.str(m.name, 64)) return;
        const p = player || this.newPlayer(from, m.name);
        p.name = cleanText(m.name, 32) || 'Player';
        p.modVersion = cleanText(m.ver, 20);
        p.gameVersion = cleanText(m.game, 20);
        if (V.int(m.character, 1, 11)) p.character = m.character;
        if (V.bool(m.ready)) p.ready = m.ready;
        const isNew = !player;
        this.players.set(from, p);
        if (isNew) {
          this.toast(`${p.name} joined`);
          this.sendTo(from, this.helloMsg());
        }
        if (this.isHost) this.broadcastLobby();
        this.changed();
        return;
      }
      case 'lobby': {
        if (!fromHost || self) return;
        this.applyLobbySnapshot(m);
        return;
      }
      case 'setReady': {
        if (!this.isHost || !player) return;
        if (V.bool(m.ready)) player.ready = m.ready;
        if (V.int(m.character, 1, 11)) player.character = m.character;
        this.broadcastLobby(); this.changed();
        return;
      }
      case 'chat': {
        if (!player || self || !V.str(m.text, 400)) return;
        this.addChat(from, cleanText(m.text, 200));
        return;
      }
      case 'load': {
        if (!fromHost && !self) return;
        if (!V.int(m.race, 1, 65535) || !m.level || !V.int(m.level.id, 1, 2e9) || !Array.isArray(m.participants) || !m.participants.every(V.id)) return;
        this.onLoad({ race: m.race, level: { id: m.level.id, name: cleanText(m.level.name, 80), forceChar: !!m.level.forceChar }, collisions: !!m.collisions, forceCharacter: V.int(m.forceCharacter, 0, 11) ? m.forceCharacter : 0, participants: m.participants.slice(0, 16) });
        return;
      }
      case 'start': {
        if ((!fromHost && !self) || !V.num(m.goAt)) return;
        this.onStart(m);
        return;
      }
      case 'spawn': {
        if (!race || m.race !== race.id || !player) return;
        if (!V.int(m.character, 1, 11) || !V.layout(m.layout) || !V.int(m.serial, 0, 65535)) return;
        if (!self) {
          this.peerSerial.set(from, m.serial);
          this.bridge.setPuppet(from, { characterIndex: m.character, hideVehicle: !!m.hideVehicle, layout: m.layout });
        }
        if (player.status === 'loading' || player.status === 'spectating') player.status = this.phase === 'racing' ? 'racing' : 'ready';
        if (this.isHost) { this.checkRaceProgress(); this.broadcastLobby(); }
        this.changed();
        return;
      }
      case 'event': {
        if (self || !race || m.race !== race.id || this.peerSerial.get(from) !== m.serial) return;
        if (!V.str(m.path, 64) || !/^[A-Za-z0-9_.]*$/.test(m.path) || !V.str(m.method, 40) || !V.args(m.args)) return;
        this.bridge.puppetEvent(from, m.path, m.method, m.args.map((a) => (a === null ? undefined : a)));
        return;
      }
      case 'finish': {
        if (!race || m.race !== race.id || !player || !V.int(m.ms, 0, 36e5)) return;
        if (race.finishes[from] != null) return;
        race.finishes[from] = m.ms;
        player.status = 'finished';
        player.finishMs = m.ms;
        if (!self) this.toast(`${player.name} finished — ${fmtTime(m.ms)}`);
        if (this.isHost) {
          if (!race.deadline) {
            race.deadline = this.clock.now() + this.settings.graceSec * 1000;
            clearTimeout(this.graceTimer);
            this.graceTimer = setTimeout(() => this.checkRaceProgress(), this.settings.graceSec * 1000 + 50);
          }
          this.checkRaceProgress();
          this.broadcastLobby();
        }
        this.changed();
        return;
      }
      case 'dnf': {
        if (!race || m.race !== race.id || !player) return;
        race.dnf.add(from);
        player.status = 'dnf';
        if (!self) this.bridge.removePuppet(from);
        if (this.isHost) { this.checkRaceProgress(); this.broadcastLobby(); }
        this.changed();
        return;
      }
      case 'results': {
        if ((!fromHost && !self) || !race || m.race !== race.id) return;
        if (m.finishes && typeof m.finishes === 'object') {
          for (const [id, ms] of Object.entries(m.finishes)) if (V.id(id) && V.int(ms, 0, 36e5)) race.finishes[id] = ms;
        }
        if (Array.isArray(m.dnf)) for (const id of m.dnf) if (V.id(id)) race.dnf.add(id);
        this.phase = 'results';
        for (const p of this.players.values()) {
          if (race.finishes[p.id] != null) { p.status = 'finished'; p.finishMs = race.finishes[p.id]; }
          else if (race.participants.includes(p.id)) p.status = 'dnf';
        }
        this.changed();
        return;
      }
      case 'voteSkip': {
        if (!this.isHost || !race || m.race !== race.id || !player || this.phase === 'results') return;
        race.skipVotes.add(from);
        this.toast(`${player.name} wants to skip this level (${race.skipVotes.size}/${this.skipVotesNeeded()})`);
        this.broadcastLobby();
        this.changed();
        if (race.skipVotes.size >= this.skipVotesNeeded()) this.skipLevel().catch((e) => this.toast(e.message, 'error'));
        return;
      }
      case 'notice': {
        if (!fromHost || !V.str(m.text, 200)) return;
        this.toast(cleanText(m.text, 120));
        return;
      }
      case 'backToLobby': {
        if (!fromHost && !self) return;
        this.resetRace(true);
        this.phase = 'lobby';
        for (const p of this.players.values()) { p.status = 'lobby'; p.finishMs = null; }
        this.changed();
        return;
      }
      default:
    }
  }

  applyLobbySnapshot(m) {
    if (m.settings && typeof m.settings === 'object') {
      const s = m.settings;
      this.settings = {
        level: s.level && V.int(s.level.id, 1, 2e9) ? { id: s.level.id, name: cleanText(s.level.name, 80), character: V.int(s.level.character, 0, 11) ? s.level.character : 0, forceChar: !!s.level.forceChar } : null,
        collisions: !!s.collisions,
        forceCharacter: V.int(s.forceCharacter, 0, 11) ? s.forceCharacter : 0,
        graceSec: V.int(s.graceSec, 10, 600) ? s.graceSec : 45,
        name: cleanText(s.name, 64),
      };
    }
    if (Array.isArray(m.players)) {
      for (const sp of m.players.slice(0, 32)) {
        const p = sp && V.id(sp.id) ? this.players.get(sp.id) : null;
        if (!p) continue;
        if (sp.id !== this.self.id) {
          if (V.bool(sp.ready)) p.ready = sp.ready;
          if (V.int(sp.character, 1, 11)) p.character = sp.character;
        }
        if (V.str(sp.status, 16)) p.status = sp.status;
      }
    }
    const phases = ['lobby', 'loading', 'countdown', 'racing', 'results'];
    // Late joiner or host migration: adopt race bookkeeping so a future host can finish the race.
    if (m.race && this.race && m.race.id === this.race.id) {
      if (m.race.finishes && typeof m.race.finishes === 'object') {
        for (const [id, ms] of Object.entries(m.race.finishes)) if (V.id(id) && V.int(ms, 0, 36e5)) this.race.finishes[id] = ms;
      }
      if (Array.isArray(m.race.dnf)) for (const id of m.race.dnf) if (V.id(id)) this.race.dnf.add(id);
      if (V.num(m.race.deadline)) this.race.deadline = m.race.deadline;
      if (Array.isArray(m.race.skipVotes)) this.race.skipVotes = new Set(m.race.skipVotes.filter(V.id).slice(0, 32));
    } else if (!this.race && phases.includes(m.phase) && m.phase !== 'lobby') {
      this.phase = m.phase === 'results' ? 'lobby' : 'spectating';
    }
    if (!this.race && m.phase === 'lobby') this.phase = 'lobby';
    this.changed();
  }
}

export function fmtTime(ms) {
  if (ms == null) return '--';
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(2).padStart(5, '0');
  return m > 0 ? `${m}:${rest}` : `${s.toFixed(2)}s`;
}
