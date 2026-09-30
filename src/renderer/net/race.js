// Lobby + race state machine. The host (the Steam lobby owner, or the player it named, see
// hostTools.js) is authoritative for the lobby's settings and race control (load, start, results).
// Body state is streamed peer-to-peer by every player.
//
// Split across files: cups (cup.js), level votes (vote.js), host tools (hostTools.js), rankings
// and points (scoring.js), AI racers (bots.js).

import { log } from '../log.js';
import { T, encodeState, decodeState, encodeCtrl, decodeCtrl, encodePing, decodePing, V, cleanText, botId, isBotId, decodeBotState, MAX_BOTS } from './protocol.js';
import { BotDriver } from './bots.js';
import { DIFFICULTIES, DIFFICULTY_NAMES, mapInfo } from '../game/replays.js';
import { describeMap, summarizeTags } from '../game/mapTags.js';
import { Clock } from './clock.js';
import { sampleBodies, MAX_BODIES } from '../game/character.js';
import { rankRace, addRaceToTable } from './scoring.js';
import { recordRace, recordCupWin } from './stats.js';
import { cupMethods, newCup, sanitizeCup, cupWinner } from './cup.js';
import { voteMethods, sanitizeVote } from './vote.js';
import { hostToolMethods } from './hostTools.js';

const MAX_RACERS = 16;
const COUNTDOWN_S = 3.5;
const READY_TIMEOUT_MS = 30000;
const BOT_WAIT_MS = 6000;    // once the players are ready, AI racers get this long before GO anyway
const AUTO_START_MS = 5000;  // auto-start: this long after everyone is ready
const VOTE_AFTER_MS = 4000;  // vote after the race: this long after the results
const EMOTE_GAP_MS = 1000;
const PREF_KEY = 'hwmp.prefs';

/** Quick chat, keys 1-6 during races. */
export const EMOTES = ['GG!', 'Nice!', 'Oops…', 'Wait for me!', 'LOL', 'Go go go!'];

export const DEFAULT_PREFS = {
  character: 1, collisions: false, graceSec: 45, lobbyType: 'public',
  ghostOpacity: 45, nameTags: true, hudScale: 1, emoteKeys: true, markers: true, lastSeenVersion: '',
};

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch { return {}; }
}
function savePrefs(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch {} }

const RESTARTS = ['checkpoint', 'start', 'off'];

/** Race rules from the host's 'load' message, checked field by field. */
function sanitizeRules(r) {
  r = r && typeof r === 'object' ? r : {};
  const num = (v, lo, hi, d) => (V.num(v) && v >= lo && v <= hi ? v : d);
  return {
    mode: r.mode === 'survival' ? 'survival' : 'race',
    collisions: !!r.collisions,
    forceCharacter: V.int(r.forceCharacter, 0, 11) ? r.forceCharacter : 0,
    finishWindow: num(r.finishWindow, 5, 600, 45),
    timeLimit: num(r.timeLimit, 0, 3600, 0),
    countdown: num(r.countdown, 2, 15, COUNTDOWN_S),
    restart: RESTARTS.includes(r.restart) ? r.restart : 'checkpoint',
    ghosts: num(r.ghosts, 0, 95, 0),
    laps: V.int(r.laps, 0, 20) ? r.laps : 0,
    fromMap: !!r.fromMap,
  };
}

/** A map summary (see mapTags.summarizeTags) from the host's snapshot, checked field by field. */
function sanitizeMap(m) {
  if (!m || typeof m !== 'object') return null;
  const r = m.rules && typeof m.rules === 'object' ? m.rules : {};
  const rules = {};
  if (V.bool(r.collisions)) rules.collisions = r.collisions;
  if (V.int(r.character, 1, 11)) rules.character = r.character;
  for (const [k, lo, hi] of [['finishWindow', 5, 600], ['timeLimit', 10, 3600], ['countdown', 2, 15], ['ghosts', 5, 95], ['players', 1, 16], ['laps', 1, 20], ['aiMax', 0, 7]]) {
    if (V.int(r[k], lo, hi)) rules[k] = r[k];
  }
  if (V.bool(r.ai)) rules.ai = r.ai;
  if (RESTARTS.includes(r.restart)) rules.restart = r.restart;
  if (r.mode === 'race' || r.mode === 'survival') rules.mode = r.mode;
  const count = (v) => (V.int(v, 0, 999) ? v : 0);
  return {
    rules, spawns: count(m.spawns), checkpoints: count(m.checkpoints), finishes: count(m.finishes),
    warnings: Array.isArray(m.warnings) ? m.warnings.filter((w) => V.str(w, 300)).map((w) => cleanText(w, 160)).slice(0, 12) : [],
  };
}

/** A points table ({ id: { name, points, wins, podiums, races } }) from a snapshot. */
function sanitizeTable(t) {
  const out = {};
  if (!t || typeof t !== 'object') return out;
  for (const [id, row] of Object.entries(t).slice(0, 32)) {
    if (!V.id(id) || !row || typeof row !== 'object') continue;
    out[id] = {
      name: cleanText(row.name, 32) || 'Player',
      points: V.int(row.points, 0, 1e6) ? row.points : 0, wins: V.int(row.wins, 0, 1e5) ? row.wins : 0,
      podiums: V.int(row.podiums, 0, 1e5) ? row.podiums : 0, races: V.int(row.races, 0, 1e5) ? row.races : 0,
    };
  }
  return out;
}

const cleanLevel = (l) => (l && V.int(l.id, 1, 2e9)
  ? { id: l.id, name: cleanText(l.name || `Level ${l.id}`, 80), author: cleanText(l.author || '', 40), character: V.int(l.character, 0, 11) ? l.character : 0, forceChar: !!l.forceChar }
  : null);

export class Multiplayer {
  constructor(transport, bridge) {
    this.tx = transport;
    this.bridge = bridge;
    this.clock = new Clock();
    this.listeners = new Set();
    this.prefs = { ...DEFAULT_PREFS, ...loadPrefs() };
    this.self = null;          // { id, name }
    this.lobby = null;         // { id, owner, members, data }
    this.players = new Map();  // id -> player
    this.settings = this.defaultSettings();
    this.board = {};           // session leaderboard: { id: { name, points, wins, podiums, races } }
    this.phase = 'idle';       // idle | lobby | loading | countdown | racing | results
    this.race = null;          // see onLoad
    this.raceCounter = 0;
    this.chat = [];
    this.playedLevels = new Set(); // level ids raced in this lobby, for 'random unplayed level'
    this.everSeen = new Set();     // players seen in this lobby (a locked lobby still lets them back)
    this.pingId = 0;
    this.pendingPings = new Map();
    this.peerSerial = new Map(); // peer -> session serial of their current puppet
    this.samples = new Float64Array(MAX_BODIES * 6);
    this.localSerial = 0;
    this.finished = false;
    this.rejoining = false;   // next local spawn asks the others to describe their racers again
    this.localSpawn = null;   // our last spawn message this race (re-sent to rejoining players)
    this.goTimer = null;
    this.readyTimer = null;
    this.graceTimer = null;
    this.broadcastTimer = null;
    this.mapToken = 0;
    this.mapPromise = null;
    this.myVote = null;
    this.bots = new BotDriver(this); // host: plays the AI racers
    this.botHitAt = new Map();       // AI racer -> when we last reported hitting it
    this.solo = null;                // practice / map test (set by index.js)
  }

  defaultSettings() {
    return {
      level: null, collisions: !!this.prefs.collisions, forceCharacter: 0, graceSec: this.prefs.graceSec, name: '',
      mode: 'race', autoStart: false, autoStartAt: null, voteAfter: false,
      map: null, mapState: 'none', locked: false, banned: [], cup: newCup(), vote: null,
    };
  }

  // ---- plumbing ------------------------------------------------------------------------------
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { for (const fn of this.listeners) { try { fn(this); } catch (e) { log.error(e); } } }
  notify(evt) { for (const fn of this.listeners) { try { fn(this, evt); } catch {} } }
  lobbyChanged() { this.checkCupWin(); this.broadcastLobby(); this.changed(); }

  /** Career stats: count a cup we won outright (once per cup). */
  checkCupWin() {
    const cup = this.settings.cup;
    if (!cup.done || !this.self) return;
    const key = `${cup.levels.map((l) => l.id).join(',')}|${JSON.stringify(cup.table)}`;
    if (this.cupWinSeen === key) return;
    this.cupWinSeen = key;
    const w = cupWinner(cup);
    if (w && !w.tie && w.ids[0] === this.self.id) recordCupWin();
  }

  toast(text, kind = 'info') {
    (kind === 'error' ? log.warn : log.info)('toast:', text);
    for (const fn of this.listeners) { try { fn(this, { toast: text, kind }); } catch {} }
  }

  setPref(key, value) {
    if (!(key in DEFAULT_PREFS)) return;
    this.prefs[key] = value;
    savePrefs(this.prefs);
    if (key === 'ghostOpacity' && !(this.race && this.race.rules.ghosts)) this.bridge.ghostAlpha = value / 100;
    this.changed();
  }

  /** Who runs the races: the player the Steam lobby owner named, or the owner itself. */
  hostOf(lobby) {
    if (!lobby) return null;
    const named = lobby.data && lobby.data.host;
    return named && lobby.members.includes(named) ? named : lobby.owner;
  }
  get hostId() { return this.hostOf(this.lobby); }
  get isHost() { return !!(this.lobby && this.self && this.hostId === this.self.id); }
  peers() { return this.lobby ? this.lobby.members.filter((m) => m !== this.self.id) : []; }
  humans() { return [...this.players.values()].filter((p) => !p.bot); }

  send(targets, bytes, reliable) { if (targets.length) this.tx.net.send(targets, bytes, reliable); }
  sendAll(obj) { this.send(this.peers(), encodeCtrl(obj), true); }
  sendTo(id, obj) { if (id && id !== this.self.id) this.send([id], encodeCtrl(obj), true); }
  sendHost(obj) { if (this.isHost) this.onCtrl(this.self.id, obj); else this.sendTo(this.hostId, obj); }

  async start() {
    const me = await this.tx.self().catch(() => null);
    this.self = me ? { id: String(me.steamId), name: me.name } : null;
    this.bridge.ghostAlpha = this.prefs.ghostOpacity / 100;
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
    b.on('courseFinish', () => this.onLocalFinish());
    b.on('exitedToMenu', () => this.onLocalExit());
    b.on('puppetHit', (id, hit) => this.onPuppetHit(id, hit));
    b.on('progress', (info) => this.onLocalProgress(info));
    b.on('died', () => this.onLocalDied());
    b.on('checkpoint', (info) => this.onLocalCheckpoint(info));
    b.on('lap', (info) => { if (this.race && b.raceMode) this.toast(`Lap ${info.lap} of ${info.laps}`); });
    b.on('restartBlocked', () => { if (this.race) this.toast(this.race.rules.mode === 'survival' ? 'No restarts in survival' : 'Restarts are off on this map'); });
    setInterval(() => this.pingHost(), 500);
    // Handshake repair: keep greeting lobby members we haven't heard from (a dropped hello would
    // otherwise leave them missing from the player list).
    setInterval(() => {
      if (!this.lobby || !this.self) return;
      for (const m of this.peers()) if (!this.players.has(m) && !this.isBanned(m)) this.sendTo(m, this.helloMsg());
    }, 3000);
    // Host safety net: re-check race completion (covers finish windows inherited from a previous
    // host) and the auto-start countdown.
    setInterval(() => {
      if (!this.isHost) return;
      if (this.race && (this.phase === 'racing' || this.phase === 'countdown')) this.checkRaceProgress();
      this.checkAutoStart();
    }, 500);
    this.changed();
  }

  // ---- lobby management ----------------------------------------------------------------------
  async create() {
    const name = `${this.self?.name || 'Player'}'s race`;
    this.settings = this.defaultSettings();
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
    // Leaving from inside a race level goes back to the main menu, not on as single-player.
    const inRaceLevel = !!(this.race && this.bridge.raceMode && this.bridge.session && !(this.solo && this.solo.active));
    this.resetRace(true);
    await this.tx.lobby.leave().catch(() => {});
    this.lobby = null;
    this.players.clear();
    this.phase = 'idle';
    if (inRaceLevel) this.bridge.returnToMenu();
    this.changed();
  }

  list() { return this.tx.lobby.list(); }
  invite() { return this.tx.lobby.invite(); }

  enterLobby(info) {
    this.resetRace(true);
    this.lobby = info;
    this.phase = 'lobby';
    this.chat = [];
    this.board = {};
    this.playedLevels.clear();
    this.everSeen.clear();
    this.players.clear();
    if (!this.isHost) { const name = this.settings.name; this.settings = this.defaultSettings(); this.settings.name = name; }
    const me = this.newPlayer(this.self.id, this.self.name);
    me.character = this.prefs.character;
    this.players.set(this.self.id, me);
    this.everSeen.add(this.self.id);
    this.clock.reset(this.isHost);
    for (const m of info.members) if (m !== this.self.id) this.sendTo(m, this.helloMsg());
    this.changed();
  }

  newPlayer(id, name) {
    return { id, name: cleanText(name || 'Player', 32), ready: false, character: 1, status: 'lobby', finishMs: null, modVersion: '', gameVersion: id === this.self?.id ? this.bridge.gameVersion() : '' };
  }

  dropPlayer(id) {
    this.players.delete(id);
    this.bridge.removePuppet(id);
    this.peerSerial.delete(id);
  }

  helloMsg() {
    return { t: 'hello', name: this.self.name, character: this.prefs.character, ready: !!this.players.get(this.self.id)?.ready, ver: this.tx.modVersion || '', game: this.bridge.gameVersion() };
  }

  onLobbyUpdate(info) {
    if (!info) { if (this.lobby) { this.lobby = null; this.resetRace(true); this.phase = 'idle'; this.players.clear(); this.changed(); } return; }
    if (!this.lobby || info.id !== this.lobby.id) return;
    if (JSON.stringify(info) === JSON.stringify(this.lobby)) return;
    const prevHost = this.hostId;
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
        this.dropPlayer(id);
      }
    }
    if (prevHost !== this.hostId) this.onHostChanged(prevHost);
    if (this.isSteamOwner) this.tx.lobby.setJoinable(!this.settings.locked).catch(() => {});
    if (this.isHost) { this.checkRaceProgress(); this.broadcastLobby(); }
    this.changed();
  }

  /** The host changed (left, or handed the role over). AI racers ran on the old host's PC. */
  onHostChanged(prevHost) {
    this.clock.reset(this.isHost);
    if (prevHost === this.self.id) this.bots.stop();
    for (const p of this.botPlayers()) {
      this.bridge.removePuppet(p.id);
      this.peerSerial.delete(p.id);
      if (this.race && this.race.participants.includes(p.id) && this.race.finishes[p.id] == null) { this.race.dnf.add(p.id); p.status = 'dnf'; }
    }
    if (this.isHost) {
      this.toast('You are the host now');
      this.adoptHostRole();
    }
  }

  lobbySummary() {
    return {
      name: this.settings.name,
      level: this.settings.level ? this.settings.level.name : '',
      levelId: this.settings.level ? this.settings.level.id : 0,
      phase: this.phase === 'idle' ? 'lobby' : this.phase,
      collisions: this.settings.collisions ? 1 : 0,
      mode: this.settings.mode,
      game: this.bridge.gameVersion(),
    };
  }

  // Host: send the authoritative lobby snapshot (debounced).
  broadcastLobby() {
    if (!this.isHost) return;
    clearTimeout(this.broadcastTimer);
    this.broadcastTimer = setTimeout(() => {
      const r = this.race;
      const snap = {
        t: 'lobby',
        phase: this.phase,
        settings: this.settings,
        board: this.board,
        race: r ? {
          id: r.id, level: r.level, participants: r.participants, goAt: r.goAt, finishes: r.finishes, dnf: [...r.dnf], deadline: r.deadline,
          collisions: r.collisions, forceCharacter: r.forceCharacter, skipVotes: [...r.skipVotes], rules: r.rules, progress: r.progress, deaths: r.deaths, cupIndex: r.cupIndex,
        } : null,
        players: [...this.players.values()].map((p) => ({ id: p.id, ready: p.ready, status: p.status, character: p.character, ...(p.bot ? { bot: p.bot.difficulty, name: p.name, runBy: p.runBy || '', prep: p.prep || '' } : {}) })),
      };
      this.sendAll(snap);
      if (this.isSteamOwner) this.tx.lobby.setData(this.lobbySummary()).catch(() => {});
    }, 60);
  }

  adoptHostRole() {
    // Continue an in-flight race with the state we mirrored from the previous host.
    if (this.race && (this.phase === 'loading')) this.scheduleReadyTimeout();
    if (this.race && this.phase === 'racing') this.checkRaceProgress();
    if (this.settings.vote) { clearTimeout(this.voteTimer); this.voteTimer = setTimeout(() => this.voteFinish(), Math.max(0, this.settings.vote.endsAt - this.clock.now()) + 100); }
  }

  // ---- host actions ---------------------------------------------------------------------------
  setLevel(level) {
    if (!this.isHost) return;
    this.settings.level = cleanLevel(level);
    this.loadMapInfo(this.settings.level);
    setTimeout(() => this.schedulePrefetch(), 0);
    this.lobbyChanged();
  }
  setCollisions(on) { if (!this.isHost) return; this.settings.collisions = !!on; this.prefs.collisions = !!on; savePrefs(this.prefs); this.lobbyChanged(); }
  setForceCharacter(idx) { if (!this.isHost) return; this.settings.forceCharacter = V.int(idx, 0, 11) ? idx : 0; this.lobbyChanged(); }
  setGrace(sec) { if (!this.isHost) return; this.settings.graceSec = V.int(sec, 10, 600) ? sec : 45; this.prefs.graceSec = this.settings.graceSec; savePrefs(this.prefs); this.lobbyChanged(); }
  setMode(mode) { if (!this.isHost || (mode !== 'race' && mode !== 'survival')) return; this.settings.mode = mode; this.lobbyChanged(); }
  setAutoStart(on) { if (!this.isHost) return; this.settings.autoStart = !!on; this.settings.autoStartAt = null; this.lobbyChanged(); }
  setVoteAfter(on) { if (!this.isHost) return; this.settings.voteAfter = !!on; this.lobbyChanged(); }
  setLobbyType(type) { this.prefs.lobbyType = type; savePrefs(this.prefs); }

  /** Host: read the chosen level's #mp tags (the lobby shows them and races follow them). */
  loadMapInfo(level) {
    const id = level && level.id;
    const token = ++this.mapToken;
    this.settings.map = null;
    this.settings.mapState = id ? 'loading' : 'none';
    if (!id) { this.mapPromise = null; return; }
    this.mapPromise = mapInfo(id).then((info) => {
      if (token !== this.mapToken) return;
      this.settings.map = info;
      this.settings.mapState = info ? 'ready' : 'none';
      if (info && info.rules.players && this.humans().length > info.rules.players) this.toast(`This map is made for ${info.rules.players} racers`);
      this.lobbyChanged();
    }, (e) => {
      if (token !== this.mapToken) return;
      log.warn('could not read the map rules:', e && e.message);
      this.settings.mapState = 'error';
      this.lobbyChanged();
    });
  }

  /**
   * The rules a race will use: the lobby's settings, overridden by the map's own #mp rules.
   * AI racers can't play survival or maps with their own finish line (their runs follow the
   * level's own finish).
   */
  effectiveRules() {
    const s = this.settings;
    const map = s.map;
    const m = (map && map.rules) || {};
    const mode = m.mode || s.mode || 'race';
    const laps = m.laps || (map && map.finishes ? 1 : 0);
    let aiReason = '';
    if (mode === 'survival') aiReason = "AI racers don't play survival";
    else if (laps) aiReason = "AI racers can't race maps with their own finish line";
    else if (m.ai === false || m.aiMax === 0) aiReason = "this map doesn't allow AI racers";
    return {
      mode,
      collisions: m.collisions != null ? m.collisions : s.collisions,
      forceCharacter: m.character || s.forceCharacter || 0,
      finishWindow: m.finishWindow || s.graceSec,
      timeLimit: m.timeLimit || 0,
      countdown: m.countdown || COUNTDOWN_S,
      restart: mode === 'survival' ? 'off' : m.restart || 'checkpoint',
      ghosts: m.ghosts || 0,
      laps,
      aiReason,
      aiMax: m.aiMax != null ? m.aiMax : MAX_BOTS,
      fromMap: !!map,
    };
  }

  /** force: replace a race in progress (skip level). */
  startRace({ force = false } = {}) {
    if (!this.isHost || !this.settings.level) return;
    const idle = this.phase === 'lobby' || this.phase === 'results';
    const racing = this.racing();
    if (!idle && !(force && racing)) return;
    // The map's rules are still being read: start as soon as they're in.
    if (this.settings.mapState === 'loading' && this.mapPromise) {
      if (!this.startPending) {
        this.startPending = true;
        const p = this.mapPromise;
        p.then(() => {}, () => {}).then(() => { this.startPending = false; this.startRace({ force }); });
      }
      return;
    }
    this.settings.autoStartAt = null;
    if (this.settings.vote) { clearTimeout(this.voteTimer); this.settings.vote = null; }
    const rules = this.effectiveRules();
    let bots = this.botPlayers();
    if (bots.length && rules.aiReason) { this.toast(`AI racers sit this one out: ${rules.aiReason}`); bots = []; }
    const rank = { mine: -1, expert: 0, hard: 1, medium: 2, easy: 3 };
    bots = bots.sort((a, b) => rank[a.bot.difficulty] - rank[b.bot.difficulty]).slice(0, rules.aiMax);
    const participants = [...this.humans().map((p) => p.id), ...bots.map((p) => p.id)];
    this.raceCounter = ((this.race?.id || this.raceCounter) % 60000) + 1;
    const { aiReason, aiMax, ...raceRules } = rules;
    const cup = this.settings.cup;
    const msg = {
      t: 'load',
      race: this.raceCounter,
      level: this.settings.level,
      collisions: raceRules.collisions,
      forceCharacter: raceRules.forceCharacter,
      participants,
      rules: raceRules,
      cup: cup.active ? cup.index : -1,
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
    const alive = this.race.participants.filter((id) => this.players.has(id) && !this.players.get(id).bot);
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
    clearTimeout(this.botWaitTimer); this.botWaitTimer = null;
    const msg = { t: 'start', race: this.race.id, goAt: this.clock.now() + this.race.rules.countdown * 1000 };
    this.sendAll(msg);
    this.onCtrl(this.self.id, msg);
  }

  /** Host: the race ends at `at` (time limit, or the finish window after the first finish). */
  setDeadline(at) {
    const race = this.race;
    if (!race || (race.deadline && race.deadline <= at)) return;
    race.deadline = at;
    clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => this.checkRaceProgress(), Math.max(0, at - this.clock.now()) + 50);
    this.broadcastLobby();
  }

  checkRaceProgress() {
    if (!this.isHost || !this.race) return;
    const race = this.race;
    const alive = race.participants.filter((id) => this.players.has(id));
    if (this.phase === 'loading') {
      const ready = (id) => this.players.get(id).status === 'ready' || race.dnf.has(id);
      if (alive.length && alive.every(ready)) { this.hostGo(); return; }
      // Players are ready but an AI racer is still finding its run: give it a moment, then go (it
      // will start from the start line when ready, behind everyone).
      const people = alive.filter((id) => !this.players.get(id).bot);
      if (people.length && people.every(ready) && !this.botWaitTimer) {
        const id = race.id;
        this.botWaitTimer = setTimeout(() => {
          this.botWaitTimer = null;
          if (this.isHost && this.race && this.race.id === id && this.phase === 'loading') this.hostGo();
        }, BOT_WAIT_MS);
      }
      return;
    }
    if (this.phase !== 'racing' && this.phase !== 'countdown') return;
    const out = (id) => race.finishes[id] != null || race.dnf.has(id) || race.deaths[id] != null;
    let over = alive.every(out);
    if (!over && race.rules.mode === 'survival' && alive.length >= 2) {
      // Last one standing wins (unless someone already made it to the finish).
      const standing = alive.filter((id) => !out(id));
      const finishers = alive.filter((id) => race.finishes[id] != null);
      if (standing.length <= 1 && !finishers.length) over = true;
    }
    const expired = race.deadline && this.clock.now() >= race.deadline;
    if (over || expired) this.hostResults();
  }

  hostResults() {
    if (!this.isHost || !this.race || this.phase === 'results') return;
    clearTimeout(this.graceTimer);
    const r = this.race;
    const msg = { t: 'results', race: r.id, finishes: r.finishes, dnf: [...r.dnf], progress: r.progress, deaths: r.deaths };
    this.sendAll(msg);
    this.onCtrl(this.self.id, msg);
  }

  /** Host: after the results, update the session leaderboard and the cup, maybe start a vote. */
  hostAfterResults(race) {
    addRaceToTable(this.board, race, (id) => this.players.get(id)?.name);
    this.cupScore(race);
    const cup = this.settings.cup;
    if (this.settings.voteAfter && !cup.active && !cup.done) {
      const id = race.id;
      setTimeout(() => { if (this.isHost && this.phase === 'results' && this.race && this.race.id === id) this.voteStart().catch(() => {}); }, VOTE_AFTER_MS);
    }
    this.lobbyChanged();
  }

  /** Host: auto-start once every other player is ready (cups move on to their next race). */
  checkAutoStart() {
    const s = this.settings;
    const cup = s.cup;
    const guests = this.humans().filter((p) => p.id !== this.self.id);
    const canStart = s.autoStart && !this.racing() && !s.vote && !!s.level && guests.length > 0 && guests.every((p) => p.ready)
      && !(cup.active && this.phase === 'results' && cup.scored !== cup.index);
    if (!canStart) {
      if (s.autoStartAt) { s.autoStartAt = null; this.lobbyChanged(); }
      return;
    }
    if (!s.autoStartAt) { s.autoStartAt = this.clock.now() + AUTO_START_MS; this.lobbyChanged(); return; }
    if (this.clock.now() < s.autoStartAt) return;
    s.autoStartAt = null;
    if (cup.active && this.phase === 'results' && cup.index + 1 < cup.levels.length) this.cupNext();
    else this.startRace();
  }

  // ---- AI racers (host) -----------------------------------------------------------------------
  botPlayers() { return [...this.players.values()].filter((p) => p.bot); }

  addBot(difficulty = 'medium') {
    if (!this.isHost || !DIFFICULTIES.includes(difficulty)) return;
    if (this.phase !== 'lobby' && this.phase !== 'results') return;
    let slot = 0;
    while (slot < MAX_BOTS && this.players.has(botId(slot))) slot++;
    if (slot >= MAX_BOTS) return;
    const id = botId(slot);
    const p = this.newPlayer(id, `AI ${slot + 1} · ${DIFFICULTY_NAMES[difficulty]}`);
    p.bot = { difficulty };
    p.ready = true;
    p.runBy = '';
    p.prep = '';
    this.players.set(id, p);
    this.prefs.botDifficulty = difficulty; savePrefs(this.prefs);
    this.lobbyChanged();
    this.schedulePrefetch();
  }

  setBotDifficulty(id, difficulty) {
    const p = this.players.get(id);
    if (!this.isHost || !p || !p.bot || !DIFFICULTIES.includes(difficulty)) return;
    p.bot = { difficulty };
    p.name = `AI ${Number(id) - 100} · ${DIFFICULTY_NAMES[difficulty]}`;
    p.runBy = '';
    p.prep = '';
    this.lobbyChanged();
    this.schedulePrefetch();
  }

  removeBot(id) {
    const p = this.players.get(id);
    if (!this.isHost || !p || !p.bot) return;
    this.dropPlayer(id);
    this.lobbyChanged();
    this.schedulePrefetch();
  }

  /** Host: send a message on an AI racer's behalf (everyone treats it as coming from the racer). */
  botCtrl(id, msg) {
    this.sendAll({ ...msg, bot: id });
    this.onCtrl(id, msg);
  }

  /** Our position among the (human) racers: which #mp spawn point we get on maps that have them. */
  humanSlot(participants) {
    return participants.filter((id) => !isBotId(id)).indexOf(this.self.id);
  }

  /** A race is loading or running (not the lobby or the results screen). */
  racing() { return ['loading', 'countdown', 'racing'].includes(this.phase); }

  /** Host: in the lobby, get AI runs ready in the background (level or lineup changed). */
  schedulePrefetch() {
    clearTimeout(this.prefetchTimer);
    if (!this.isHost || !this.settings.level || !this.botPlayers().length) return;
    if (this.settings.mapState === 'loading') { this.prefetchTimer = setTimeout(() => this.schedulePrefetch(), 800); return; }
    if (this.effectiveRules().aiReason) return; // they won't race this map
    this.prefetchTimer = setTimeout(() => {
      if (this.isHost && this.settings.level && !this.racing()) this.bots.prefetch(this.settings.level.id);
    }, 1200);
  }

  /** Who drove an AI racer's run: the replay's uploader, or the host for "Your best". */
  runAuthor(run) { return String(run.replayId).startsWith('best:') ? this.self.name : run.author; }

  /** Host: progress of the background search, shown in the lobby. */
  botPrep(id, state, run) {
    const p = this.players.get(id);
    if (!p || !p.bot || this.racing()) return;
    p.prep = state;
    p.runBy = run ? this.runAuthor(run) : '';
    if (run) p.character = run.character;
    this.lobbyChanged();
  }

  botReady(id, run) {
    const p = this.players.get(id);
    if (!p || !this.race) return;
    p.character = run.character;
    p.runBy = this.runAuthor(run);
    this.botCtrl(id, this.bots.spawnMsg(id));
    this.broadcastLobby();
  }

  botFailed(id, reason = '') {
    const p = this.players.get(id);
    if (!p || !this.race) return;
    this.toast(reason ? `${p.name} sits this race out: ${reason}` : `${p.name} has no working run for this level and sits this race out`);
    this.botCtrl(id, { t: 'dnf', race: this.race.id });
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

  /** Quick chat: shows a bubble over our racer for everyone. */
  emote(i) {
    if (!this.lobby || !V.int(i, 0, EMOTES.length - 1)) return;
    const now = performance.now();
    if (now - (this.emoteAt || 0) < EMOTE_GAP_MS) return;
    this.emoteAt = now;
    this.sendAll({ t: 'emote', i });
    this.notify({ emote: { id: this.self.id, text: EMOTES[i] } });
  }

  /** Can we get into the race that is running now? Late joiners and players who left both can. */
  canJoinRace() {
    const r = this.race;
    if (!r || !this.self || this.bridge.raceMode || this.finished) return false;
    if (!this.racing() || r.finishes[this.self.id] != null) return false;
    if (r.rules.mode === 'survival' && r.deaths[this.self.id] != null) return false;
    // Not driving right now: we left (DNF), left the lobby and came back, or joined the lobby late.
    return r.participants.includes(this.self.id) || r.participants.length < MAX_RACERS;
  }

  /** Into the running race. The race clock still counts from everyone's GO. */
  joinRace() {
    if (!this.canJoinRace()) return;
    if (this.solo) this.solo.stop();
    const r = this.race;
    const late = !r.participants.includes(this.self.id);
    if (late) r.participants = [...r.participants, this.self.id];
    r.dnf.delete(this.self.id);
    const me = this.players.get(this.self.id);
    if (me) me.status = 'loading';
    this.sendHost({ t: 'joinRace', race: r.id });
    this.rejoining = true;
    this.playedLevels.add(r.level.id);
    this.bridge.resetMapProgress(this.humanSlot(r.participants), { restart: r.rules.restart });
    const b = this.bridge;
    b.raceMode = true;
    this.applyRaceLook(r.rules);
    b.setFrozen(true); // released at GO, or right away on spawn if GO has passed
    log.info(late ? 'joining the race in progress' : 'rejoining the race');
    b.loadLevel(r.level.id, { characterIndex: r.forceCharacter || this.prefs.character }).catch((e) => {
      if (e.message === 'superseded' || this.race !== r) return;
      this.toast(`Could not load the level: ${e.message}`, 'error');
      this.sendAll({ t: 'dnf', race: r.id });
      this.onCtrl(this.self.id, { t: 'dnf', race: r.id });
      b.raceMode = false; b.setFrozen(false);
    });
    this.changed();
  }

  /** Race state from the host's lobby snapshot (for players who join the lobby mid-race). */
  raceFromSnapshot(s) {
    if (!s || !V.int(s.id, 1, 65535) || !s.level || !V.int(s.level.id, 1, 2e9) || !Array.isArray(s.participants) || !s.participants.every(V.id)) return null;
    const ids = (a) => (Array.isArray(a) ? a.filter(V.id).slice(0, 32) : []);
    const race = {
      id: s.id,
      level: { id: s.level.id, name: cleanText(s.level.name, 80), forceChar: !!s.level.forceChar },
      participants: s.participants.slice(0, MAX_RACERS),
      goAt: V.num(s.goAt) ? s.goAt : null,
      finishes: {},
      dnf: new Set(ids(s.dnf)),
      deadline: V.num(s.deadline) ? s.deadline : null,
      collisions: !!s.collisions,
      forceCharacter: V.int(s.forceCharacter, 0, 11) ? s.forceCharacter : 0,
      skipVotes: new Set(ids(s.skipVotes)),
      rules: sanitizeRules(s.rules),
      progress: {},
      deaths: {},
      cupIndex: V.int(s.cupIndex, -1, 16) ? s.cupIndex : -1,
    };
    this.mergeRaceNumbers(race, s);
    return race;
  }

  /** Finish times, progress and deaths from a host message, into `race`. */
  mergeRaceNumbers(race, m) {
    if (m.finishes && typeof m.finishes === 'object') {
      for (const [id, ms] of Object.entries(m.finishes)) if (V.id(id) && V.int(ms, 0, 36e5)) race.finishes[id] = ms;
    }
    if (m.progress && typeof m.progress === 'object') {
      for (const [id, v] of Object.entries(m.progress)) if (V.id(id) && V.num(v) && v >= 0 && v <= 1e6) race.progress[id] = v;
    }
    if (m.deaths && typeof m.deaths === 'object') {
      for (const [id, ms] of Object.entries(m.deaths)) if (V.id(id) && V.int(ms, 0, 36e5)) race.deaths[id] = ms;
    }
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
    if (id !== this.self.id) for (const fn of this.listeners) { try { fn(this, { chat: { name: p ? p.name : 'Player', text } }); } catch {} }
    if (this.chat.length > 100) this.chat.shift();
    this.changed();
  }

  // ---- race flow (all clients) -----------------------------------------------------------------
  resetRace(clearPuppets) {
    this.bots.stop();
    clearTimeout(this.botWaitTimer); this.botWaitTimer = null;
    clearTimeout(this.goTimer); clearTimeout(this.readyTimer); clearTimeout(this.graceTimer);
    this.race = null;
    this.finished = false;
    this.rejoining = false;
    this.localSpawn = null;
    if (this.bridge.spectating) this.bridge.spectate(null);
    this.bridge.raceMode = !!(this.solo && this.solo.active);
    this.bridge.setFrozen(false);
    this.bridge.ghostAlpha = this.prefs.ghostOpacity / 100;
    if (clearPuppets) this.bridge.clearPuppets();
    this.peerSerial.clear();
  }

  /** How racers look and collide in this race. */
  applyRaceLook(rules) {
    const b = this.bridge;
    b.ghostAlpha = (rules.ghosts || this.prefs.ghostOpacity) / 100;
    b.setCollisions(!!rules.collisions);
  }

  onLoad(msg) {
    if (this.solo) this.solo.stop();
    this.resetRace(true);
    const rules = msg.rules;
    this.race = {
      id: msg.race, level: msg.level, participants: msg.participants, goAt: null,
      finishes: {}, dnf: new Set(), deadline: null, collisions: rules.collisions, forceCharacter: msg.forceCharacter | 0,
      skipVotes: new Set(), rules, progress: {}, deaths: {}, cupIndex: msg.cup, statsDone: false,
    };
    this.phase = 'loading';
    this.myVote = null;
    this.playedLevels.add(msg.level.id);
    const ai = msg.participants.filter(isBotId).length;
    log.info(`race ${msg.race}: ${msg.level.name || 'level'} (#${msg.level.id}), ${msg.participants.length - ai} player(s)${ai ? ` + ${ai} AI` : ''}, ${rules.mode === 'survival' ? 'survival, ' : ''}collisions ${rules.collisions ? 'on' : 'off'}${rules.fromMap ? ', map rules' : ''}`);
    for (const p of this.players.values()) { p.status = msg.participants.includes(p.id) ? 'loading' : 'spectating'; p.finishMs = null; p.ready = false; }
    const me = this.players.get(this.self.id);
    this.bridge.resetMapProgress(this.humanSlot(msg.participants), { restart: rules.restart });
    this.mapNoticeShown = false;
    this.changed();
    if (this.isHost) this.bots.prepare(this.race);
    if (!msg.participants.includes(this.self.id)) return;
    const b = this.bridge;
    b.raceMode = true;
    this.applyRaceLook(rules);
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
    if (this.isHost && this.race.rules.timeLimit) this.setDeadline(msg.goAt + this.race.rules.timeLimit * 1000);
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
    if (!this.race || !this.self || !this.bridge.raceMode) return;
    const tags = this.bridge.mapTags();
    // The host couldn't read the map in the lobby: follow the map's own rules we just read.
    if (tags && !this.race.rules.fromMap) {
      if (tags.rules.collisions != null && tags.rules.collisions !== this.bridge.collisions) {
        this.bridge.setCollisions(tags.rules.collisions);
        this.race.collisions = tags.rules.collisions;
      }
      if (tags.rules.restart) this.bridge.restartMode = tags.rules.restart;
    }
    if (tags && !this.mapNoticeShown) {
      this.mapNoticeShown = true;
      const bits = describeMap(summarizeTags(tags), (i) => this.characterName(i));
      if (bits.length) this.toast(`Multiplayer map: ${bits.join(', ')}`);
    }
    this.localSerial = serial;
    const info = this.bridge.localCharacterInfo();
    if (Number(info.levelId) !== Number(this.race.level.id)) return;
    // If we (re)started after GO there is nothing to wait for.
    if (this.race.goAt != null && this.clock.now() >= this.race.goAt) this.bridge.setFrozen(false);
    const msg = { t: 'spawn', race: this.race.id, serial: serial & 0xffff, character: info.characterIndex, hideVehicle: info.hideVehicle, layout: info.layout };
    this.localSpawn = msg;
    this.sendAll(this.rejoining ? { ...msg, rejoin: true } : msg);
    this.rejoining = false;
    this.onCtrl(this.self.id, msg);
  }

  characterName(i) {
    const names = this.bridge.characterNames();
    return names[i - 1] || `character ${i}`;
  }

  onLocalStep() {
    if (!this.race || !this.self || !this.bridge.raceMode || this.bridge.frozen) return;
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
    if (!this.race || !this.bridge.raceMode) return;
    this.sendAll({ t: 'event', race: this.race.id, serial: this.localSerial & 0xffff, path, method, args: args.map((a) => (a === undefined ? null : a)) });
  }

  onLocalFinish() {
    if (!this.race || !this.bridge.raceMode || this.finished || this.race.goAt == null) return;
    if (!this.race.participants.includes(this.self.id)) return;
    if (this.race.rules.mode === 'survival' && this.race.deaths[this.self.id] != null) return;
    this.finished = true;
    const ms = Math.max(0, Math.round(this.clock.now() - this.race.goAt));
    const msg = { t: 'finish', race: this.race.id, ms };
    this.sendAll(msg);
    this.onCtrl(this.self.id, msg);
  }

  /** How far we are on a map with checkpoints/laps (ranks unfinished racers). */
  onLocalProgress(info) {
    const r = this.race;
    if (!r || !this.bridge.raceMode || !r.participants.includes(this.self.id) || this.phase === 'results') return;
    if (r.progress[this.self.id] === info.progress) return;
    const msg = { t: 'progress', race: r.id, p: info.progress };
    this.sendAll(msg);
    this.onCtrl(this.self.id, msg);
  }

  onLocalCheckpoint(info) {
    if (!this.race || !this.bridge.raceMode) return;
    const where = info.ordered && info.total ? ` ${info.cp} of ${info.total}` : '';
    const r = this.race.rules.restart;
    this.toast(`Checkpoint${where}!${r === 'checkpoint' ? ' R brings you back here.' : ''}`);
  }

  /** Survival: our character died. */
  onLocalDied() {
    const r = this.race;
    if (!r || r.rules.mode !== 'survival' || !this.bridge.raceMode || this.phase !== 'racing') return;
    if (!r.participants.includes(this.self.id) || r.finishes[this.self.id] != null || r.deaths[this.self.id] != null) return;
    const ms = Math.max(0, Math.round(this.clock.now() - r.goAt));
    const msg = { t: 'died', race: r.id, ms };
    this.sendAll(msg);
    this.onCtrl(this.self.id, msg);
  }

  /** We hit a racer hard (collisions on). AI racers get knocked; the host decides and shows everyone. */
  onPuppetHit(id, hit) {
    const p = this.players.get(id);
    if (!p || !p.bot || !this.race || this.phase !== 'racing' || !this.bridge.raceMode) return;
    if (this.isHost) { this.bots.knock(id, { ...hit, local: true }); return; }
    const now = performance.now();
    if (now - (this.botHitAt.get(id) || 0) < 500) return;
    this.botHitAt.set(id, now);
    this.sendHost({ t: 'botHit', race: this.race.id, target: id, impulse: Math.round(hit.impulse), nx: hit.nx, ny: hit.ny });
  }

  onLocalExit() {
    if (!this.race || this.bridge.pendingLoad) return;
    if (this.phase === 'results' || this.finished) return;
    if (!this.race.participants.includes(this.self.id) || this.race.dnf.has(this.self.id)) return;
    log.info('left the race (returned to the main menu)');
    const msg = { t: 'dnf', race: this.race.id };
    this.sendAll(msg);
    this.onCtrl(this.self.id, msg);
    this.bridge.raceMode = false;
    this.bridge.setFrozen(false);
    this.bridge.clearPuppets();
    this.toast(this.race.rules.mode === 'survival' ? 'You left the race.' : 'You left the race. Open MULTIPLAYER (F2) to get back in.');
  }

  /** Everyone: the race is over. Local stats; the host also scores the session and the cup. */
  onResults(race) {
    if (race.statsDone) return;
    race.statsDone = true;
    const rows = rankRace(race);
    const nameOf = (id) => (this.players.get(id) || {}).name || (isBotId(id) ? `AI ${Number(id) - 100}` : 'Player');
    log.info(`results for race ${race.id} (${race.level.name || race.level.id}): ${rows.map((r) => `${r.place || '-'}. ${nameOf(r.id)} ${r.ms != null ? fmtTime(r.ms) : r.dead ? 'out' : 'DNF'}`).join(', ')}`);
    const mine = rows.find((r) => r.id === this.self.id);
    if (mine) {
      const myIndex = rows.indexOf(mine);
      recordRace({
        place: mine.place, racers: rows.length, finished: mine.ms != null, left: mine.dnf && !mine.dead,
        survival: race.rules.mode === 'survival',
        // AI racers you actually finished (or placed) ahead of; not every AI when nobody got anywhere.
        aiBehind: mine.place ? rows.slice(myIndex + 1).filter((r) => isBotId(r.id) && !r.dnf).length : 0,
      });
      if (mine.place === 1 && rows.length > 1) this.notify({ won: true });
    }
    if (this.isHost) this.hostAfterResults(race);
  }

  // ---- inbound ---------------------------------------------------------------------------------
  onPacket(from, bytes) {
    if (!this.lobby || !this.self || !(bytes instanceof Uint8Array) || !bytes.length) return;
    if (this.isBanned(from)) { if (this.isHost) this.rekick(from); return; }
    switch (bytes[0]) {
      case T.STATE: {
        const st = decodeState(bytes);
        if (!st || !this.race || st.race !== this.race.id) return;
        if (this.peerSerial.get(from) !== st.serial) return;
        this.bridge.puppetState(from, st.time, st.data);
        return;
      }
      case T.BOTSTATE: {
        if (from !== this.hostId || this.isHost) return;
        const b = decodeBotState(bytes);
        if (!b || !this.race || b.state.race !== this.race.id) return;
        const id = botId(b.slot);
        if (!this.players.get(id)?.bot || this.peerSerial.get(id) !== b.state.serial) return;
        this.bridge.puppetState(id, b.state.time, b.state.data);
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
    if (m.bot !== undefined) {
      if (from !== this.hostId || !isBotId(m.bot) || !this.players.get(m.bot)?.bot) return;
      from = m.bot;
    }
    if (this.hostToolCtrl(from, m)) return;
    const fromHost = from === this.hostId;
    const self = from === this.self.id;
    const player = this.players.get(from);
    const race = this.race;
    switch (m.t) {
      case 'hello': {
        if (!V.str(m.name, 64)) return;
        if (this.isHost && !self) {
          if (this.settings.locked && !this.everSeen.has(from)) { this.sendTo(from, { t: 'kick', target: from, reason: 'locked' }); return; }
        }
        if (this.isBanned(from)) return;
        this.everSeen.add(from);
        const p = player || this.newPlayer(from, m.name);
        p.name = cleanText(m.name, 32) || 'Player';
        p.modVersion = cleanText(m.ver, 20);
        p.gameVersion = cleanText(m.game, 20);
        if (V.int(m.character, 1, 11)) p.character = m.character;
        if (V.bool(m.ready)) p.ready = m.ready;
        const isNew = !player;
        if (isNew && this.race && this.racing()) p.status = 'spectating';
        this.players.set(from, p);
        if (isNew) log.info(`hello from ${p.name} (${from}), mod ${p.modVersion || '?'}, game ${p.gameVersion || '?'}`);
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
        this.lobbyChanged();
        return;
      }
      case 'chat': {
        if (!player || self || !V.str(m.text, 400)) return;
        this.addChat(from, cleanText(m.text, 200));
        return;
      }
      case 'emote': {
        if (!player || self || !V.int(m.i, 0, EMOTES.length - 1)) return;
        const now = performance.now();
        if (now - (player.emoteAt || 0) < EMOTE_GAP_MS / 2) return;
        player.emoteAt = now;
        this.notify({ emote: { id: from, text: EMOTES[m.i] } });
        return;
      }
      case 'load': {
        if (!fromHost && !self) return;
        if (!V.int(m.race, 1, 65535) || !m.level || !V.int(m.level.id, 1, 2e9) || !Array.isArray(m.participants) || !m.participants.every(V.id)) return;
        const rules = sanitizeRules(m.rules || { collisions: m.collisions, forceCharacter: m.forceCharacter });
        this.onLoad({
          race: m.race, level: { id: m.level.id, name: cleanText(m.level.name, 80), forceChar: !!m.level.forceChar },
          forceCharacter: rules.forceCharacter, participants: m.participants.slice(0, MAX_RACERS), rules,
          cup: V.int(m.cup, -1, 16) ? m.cup : -1,
        });
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
          if (m.rejoin && this.localSpawn && this.localSpawn.race === race.id && this.bridge.session) this.sendTo(from, this.localSpawn);
          if (m.rejoin && this.isHost && !this.players.get(from)?.bot) this.bots.resendTo(from);
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
      case 'progress': {
        if (!race || m.race !== race.id || !player || !V.num(m.p) || m.p < 0 || m.p > 1e6) return;
        race.progress[from] = m.p;
        this.changed();
        return;
      }
      case 'died': {
        if (!race || m.race !== race.id || !player || race.rules.mode !== 'survival' || !V.int(m.ms, 0, 36e5)) return;
        if (race.deaths[from] != null || race.finishes[from] != null) return;
        race.deaths[from] = m.ms;
        player.status = 'dead';
        if (!self) this.toast(`${player.name} is out (${fmtTime(m.ms)})`);
        else this.toast(`You're out after ${fmtTime(m.ms)}`);
        if (this.isHost) { this.checkRaceProgress(); this.broadcastLobby(); }
        this.changed();
        return;
      }
      case 'finish': {
        if (!race || m.race !== race.id || !player || !V.int(m.ms, 0, 36e5)) return;
        if (race.finishes[from] != null) return;
        race.finishes[from] = m.ms;
        player.status = 'finished';
        if (player.bot) this.bridge.setPuppetGhost(from, true);
        player.finishMs = m.ms;
        if (!self) this.toast(`${player.name} finished — ${fmtTime(m.ms)}`);
        if (this.isHost) {
          if (!race.graceSet) { race.graceSet = true; this.setDeadline(this.clock.now() + race.rules.finishWindow * 1000); }
          this.checkRaceProgress();
          this.broadcastLobby();
        }
        this.changed();
        return;
      }
      case 'dnf': {
        if (!race || m.race !== race.id || !player) return;
        race.dnf.add(from);
        if (player.status !== 'dead') player.status = 'dnf';
        if (!self) this.bridge.removePuppet(from);
        if (this.isHost) { this.checkRaceProgress(); this.broadcastLobby(); }
        this.changed();
        return;
      }
      case 'results': {
        if ((!fromHost && !self) || !race || m.race !== race.id) return;
        this.mergeRaceNumbers(race, m);
        if (Array.isArray(m.dnf)) for (const id of m.dnf) if (V.id(id)) race.dnf.add(id);
        this.phase = 'results';
        if (!(this.bridge.session && this.bridge.raceMode)) {
          const top = rankRace(race)[0];
          const wp = top && top.place === 1 && this.players.get(top.id);
          this.toast(wp ? `Race over: ${wp.name} won` : 'Race over: nobody finished');
        }
        for (const p of this.players.values()) {
          if (race.finishes[p.id] != null) { p.status = 'finished'; p.finishMs = race.finishes[p.id]; } else if (race.deaths[p.id] != null) p.status = 'dead';
          else if (race.participants.includes(p.id)) p.status = 'dnf';
        }
        this.onResults(race);
        this.changed();
        return;
      }
      case 'joinRace': {
        if (!this.isHost || !race || m.race !== race.id || !player || race.finishes[from] != null) return;
        if (!this.racing()) return;
        if (race.rules.mode === 'survival' && race.deaths[from] != null) return;
        const late = !race.participants.includes(from);
        if (late) {
          if (race.participants.length >= MAX_RACERS) return;
          race.participants = [...race.participants, from];
        }
        race.dnf.delete(from);
        player.status = 'loading';
        if (!self) this.toast(late ? `${player.name} joined the race` : `${player.name} is rejoining the race`);
        this.lobbyChanged();
        return;
      }
      case 'botHit': {
        if (!this.isHost || !race || m.race !== race.id || !player || player.bot || this.phase !== 'racing') return;
        if (!isBotId(m.target) || !this.players.get(m.target)?.bot) return;
        if (!V.num(m.impulse) || !V.num(m.nx) || !V.num(m.ny)) return;
        const len = Math.hypot(m.nx, m.ny) || 1;
        this.bots.knock(m.target, { impulse: Math.min(500, Math.max(0, m.impulse)), nx: m.nx / len, ny: m.ny / len, local: false });
        return;
      }
      case 'voteSkip': {
        if (!this.isHost || !race || m.race !== race.id || !player || this.phase === 'results') return;
        race.skipVotes.add(from);
        this.toast(`${player.name} wants to skip this level (${race.skipVotes.size}/${this.skipVotesNeeded()})`);
        this.lobbyChanged();
        if (race.skipVotes.size >= this.skipVotesNeeded()) this.skipLevel().catch((e) => this.toast(e.message, 'error'));
        return;
      }
      case 'voteLevel': {
        this.voteReceived(from, m);
        return;
      }
      case 'notice': {
        if (!fromHost || !V.str(m.text, 200)) return;
        this.toast(cleanText(m.text, 120));
        return;
      }
      case 'backToLobby': {
        if (!fromHost && !self) return;
        const inRaceLevel = this.bridge.raceMode && this.bridge.session && !(this.solo && this.solo.active);
        this.resetRace(true);
        this.phase = 'lobby';
        for (const p of this.players.values()) { p.status = 'lobby'; p.finishMs = null; }
        if (inRaceLevel) this.bridge.returnToMenu();
        this.changed();
        this.notify({ openPanel: true });
        return;
      }
      default:
    }
  }

  applyLobbySnapshot(m) {
    if (m.settings && typeof m.settings === 'object') {
      const s = m.settings;
      this.settings = {
        level: cleanLevel(s.level),
        collisions: !!s.collisions,
        forceCharacter: V.int(s.forceCharacter, 0, 11) ? s.forceCharacter : 0,
        graceSec: V.int(s.graceSec, 10, 600) ? s.graceSec : 45,
        name: cleanText(s.name, 64),
        mode: s.mode === 'survival' ? 'survival' : 'race',
        autoStart: !!s.autoStart,
        autoStartAt: V.num(s.autoStartAt) ? s.autoStartAt : null,
        voteAfter: !!s.voteAfter,
        map: sanitizeMap(s.map),
        mapState: ['none', 'loading', 'ready', 'error'].includes(s.mapState) ? s.mapState : 'none',
        locked: !!s.locked,
        banned: Array.isArray(s.banned) ? s.banned.filter(V.id).slice(0, 64) : [],
        cup: sanitizeCup(s.cup),
        vote: sanitizeVote(s.vote),
      };
      for (const id of this.settings.banned) if (this.players.has(id)) this.dropPlayer(id);
      if (this.myVote && (!this.settings.vote || this.settings.vote.id !== this.myVote.id)) this.myVote = null;
    }
    if (m.board) this.board = sanitizeTable(m.board);
    if (Array.isArray(m.players)) {
      // AI racers exist only in the host's snapshot.
      const bots = new Set();
      for (const sp of m.players.slice(0, 32)) {
        if (!sp || !isBotId(sp.id) || !DIFFICULTIES.includes(sp.bot)) continue;
        bots.add(sp.id);
        let b = this.players.get(sp.id);
        if (!b) { b = this.newPlayer(sp.id, 'AI'); this.players.set(sp.id, b); }
        b.bot = { difficulty: sp.bot };
        b.name = cleanText(sp.name, 32) || 'AI';
        b.runBy = cleanText(sp.runBy, 32);
        b.prep = ['searching', 'ready', 'none'].includes(sp.prep) ? sp.prep : '';
        b.ready = true;
      }
      for (const p of this.botPlayers()) if (!bots.has(p.id)) this.dropPlayer(p.id);
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
      this.mergeRaceNumbers(this.race, m.race);
      if (Array.isArray(m.race.dnf)) this.race.dnf = new Set(m.race.dnf.filter(V.id).slice(0, 32));
      if (Array.isArray(m.race.participants) && m.race.participants.every(V.id)) this.race.participants = m.race.participants.slice(0, MAX_RACERS);
      if (this.bridge.raceMode) {
        // We're racing: a snapshot sent before the host saw our join must not undo it.
        if (!this.race.participants.includes(this.self.id)) this.race.participants = [...this.race.participants, this.self.id];
        this.race.dnf.delete(this.self.id);
      }
      if (V.num(m.race.deadline)) this.race.deadline = m.race.deadline;
      if (Array.isArray(m.race.skipVotes)) this.race.skipVotes = new Set(m.race.skipVotes.filter(V.id).slice(0, 32));
    } else if (!this.race && m.race && ['loading', 'countdown', 'racing'].includes(m.phase) && this.raceFromSnapshot(m.race)) {
      this.race = this.raceFromSnapshot(m.race);
      this.phase = m.phase;
      if (this.race.goAt != null) this.onStart({ race: this.race.id, goAt: this.race.goAt });
      this.toast('A race is in progress. Press Join race to jump in.');
    } else if (!this.race && phases.includes(m.phase) && m.phase !== 'lobby') {
      this.phase = m.phase === 'results' ? 'lobby' : 'spectating';
    }
    if (!this.race && m.phase === 'lobby') this.phase = 'lobby';
    this.checkCupWin();
    // The Steam lobby owner keeps the lobby list entry and the lock in step with the host.
    if (this.isSteamOwner && !this.isHost) {
      this.tx.lobby.setData(this.lobbySummary()).catch(() => {});
      this.tx.lobby.setJoinable(!this.settings.locked).catch(() => {});
    }
    this.changed();
  }
}

for (const methods of [cupMethods, voteMethods, hostToolMethods]) {
  Object.defineProperties(Multiplayer.prototype, Object.getOwnPropertyDescriptors(methods));
}

export function fmtTime(ms) {
  if (ms == null) return '--';
  const s = ms / 1000;
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(2).padStart(5, '0');
  return m > 0 ? `${m}:${rest}` : `${s.toFixed(2)}s`;
}
