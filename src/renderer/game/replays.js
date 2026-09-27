// AI racers drive real players' runs, taken from the replays people upload to the Happy Wheels
// server. A replay is only key presses, and old ones can drift in this game version (and crash
// halfway), so every candidate is simulated off-screen first; only a run that reaches the finish is
// used. The result is a recorded body track that the host streams like a player's.

import { Game } from './locate.js';
import { computeLayout, sampleBodies, hookCharacterEvents, MAX_BODIES } from './character.js';
import { log } from '../log.js';

export const STEP_MS = 1000 / 30;     // the game steps its physics 30 times a second
const MAX_STEPS = 30 * 60 * 4;        // skip runs longer than 4 minutes
const COAST_STEPS = 45;               // keep recording briefly after the finish
const CHUNK_STEPS = 60;               // physics steps per slice, so the game stays responsive
const MAX_TRIES = 4;                  // candidate replays simulated per AI racer at most
// The game's server (Cloudflare) blocks a whole connection for 24 hours, level loading included,
// after a burst (about 90 requests in 30 s did it; 45 in 10 s did not). AI racers stay far below that
// and stop completely if the server ever pushes back.
const REQUEST_GAP_MS = 500;
const LIMITS = [[60 * 1000, 15], [10 * 60 * 1000, 40]]; // [window, max requests]
const BUSY_COOLDOWN_MS = 10 * 60 * 1000;

export const DIFFICULTIES = ['easy', 'medium', 'hard', 'expert'];
export const DIFFICULTY_NAMES = { easy: 'Easy', medium: 'Medium', hard: 'Hard', expert: 'Expert' };

const siteURL = () => (Game.Settings && Game.Settings.siteURL) || 'https://totaljerkface.com/';

class ServerBusy extends Error {}

const BUSY_TEXT = 'the Happy Wheels server is refusing requests from this connection right now';
let requests = Promise.resolve();
const recent = []; // start times of requests in the longest window
let busyUntil = 0;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function post(file, body, bytes = false) {
  const run = requests.then(async () => {
    if (performance.now() < busyUntil) throw new ServerBusy(BUSY_TEXT);
    for (;;) {
      const now = performance.now();
      while (recent.length && now - recent[0] > LIMITS[LIMITS.length - 1][0]) recent.shift();
      let wait = recent.length ? recent[recent.length - 1] + REQUEST_GAP_MS - now : 0;
      for (const [span, max] of LIMITS) {
        const inWindow = recent.filter((t) => now - t < span);
        if (inWindow.length >= max) wait = Math.max(wait, inWindow[inWindow.length - max] + span - now);
      }
      if (wait <= 0) break;
      await pause(wait);
    }
    recent.push(performance.now());
    const res = await fetch(siteURL() + file, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (res.status === 429) {
      const retry = Number(res.headers.get('Retry-After'));
      busyUntil = performance.now() + (Number.isFinite(retry) && retry > 0 ? retry * 1000 : BUSY_COOLDOWN_MS);
      throw new ServerBusy(BUSY_TEXT);
    }
    if (!res.ok) throw new Error(`The replay server answered ${res.status}`);
    return bytes ? new Uint8Array(await res.arrayBuffer()) : res.text();
  });
  requests = run.catch(() => {});
  return run;
}

/** Replays uploaded for a level: { id, steps, character, version, author }. */
async function listReplays(levelId, sort) {
  const text = await post('replay.hw', `action=get_all_by_level&level_id=${levelId | 0}&page=1&sortby=${sort}`);
  if (text.slice(0, 8).includes('failure')) return [];
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  return [...doc.getElementsByTagName('rp')].map((e) => ({
    id: Number(e.getAttribute('id')),
    steps: Number(e.getAttribute('ct')),
    character: Number(e.getAttribute('pc')),
    version: Number(e.getAttribute('vr')) || 0,
    author: String(e.getAttribute('un') || '').slice(0, 32),
  })).filter((r) => r.id > 0 && r.steps > 0 && r.steps < MAX_STEPS && Number.isInteger(r.character) && r.character >= 1 && r.character <= 11);
}

/** The game's level record (with the author id its loader needs). */
async function levelRecord(levelId) {
  const text = await post('get_level.hw', `action=get_level&level_id=${levelId | 0}`);
  const n = new DOMParser().parseFromString(text, 'text/xml').getElementsByTagName('lv')[0];
  if (!n) throw new Error('Level not found');
  const a = (k) => n.getAttribute(k);
  return new Game.LevelData(a('id'), a('ln'), a('ui'), a('un'), a('rg'), a('vs'), a('ps'), a('dp'), '', a('pc'), 1, 1, 1, a('dp'));
}

/** A replay's key presses, parsed by the game. */
async function downloadReplay(replayId, levelId) {
  const blob = await post('replay.hw', `action=get_cmb_records&replay_id=${replayId | 0}&level_id=${levelId | 0}`, true);
  if (blob.length < 8) throw new Error('Empty replay');
  const len = new DataView(blob.buffer, blob.byteOffset, blob.byteLength).getInt32(0);
  if (len <= 0 || len > blob.length - 4) throw new Error('Unexpected replay data');
  const { ByteArray, Buffer, ReplayData } = Game;
  const all = new ByteArray(Buffer.from(blob));
  all.readInt();
  const keys = new ByteArray();
  all.readBytes(keys, 0, len);
  const data = new ReplayData();
  data.byteArray = keys;
  return data;
}

/** Level and character art through the game's own loader (no play is counted). */
function loadLevel(record) {
  const S = Game.Settings;
  const hide = S.hideVehicle;
  return new Promise((resolve, reject) => {
    const loader = new Game.ContentLoader(record, 1, -1, false);
    const timer = setTimeout(() => reject(new Error('Timed out loading the level')), 30000);
    loader.addEventListener('complete', () => { clearTimeout(timer); resolve(loader); });
    loader.addEventListener('ioError', () => { clearTimeout(timer); reject(new Error('Could not download the level')); });
    loader.addEventListener('error', () => { clearTimeout(timer); reject(new Error(loader.errorString || 'Could not load the level')); });
    loader.load();
  }).then((loader) => {
    loader.__hwmpHideVehicle = !!S.hideVehicle;
    return loader;
  }).finally(() => { S.hideVehicle = hide; });
}

/** A simulation consumes the level's display objects: rebuild them from the downloaded data. */
function rebuildLevel(loader) {
  const S = Game.Settings;
  const hide = S.hideVehicle;
  return new Promise((resolve, reject) => {
    const done = () => { loader.removeEventListener('complete', done); resolve(); };
    loader.addEventListener('complete', done);
    try { loader.dataLoaded(); } catch (e) { loader.removeEventListener('complete', done); reject(e); }
  }).finally(() => { S.hideVehicle = hide; });
}

// ---- off-screen simulation ------------------------------------------------------------------------

// Stands in for sound handles while simulating: callers fade/stop the sounds they started.
const SILENT = new Proxy({}, {
  get: (_t, k) => (typeof k === 'symbol' || k === 'then' || k === 'soundChannel' ? undefined : () => SILENT),
  set: () => true,
});
const SOUND_METHODS = ['playSoundItem', 'playMusicItem', 'playSoundInstance', 'playPointSoundInstance', 'playAreaSoundInstance', 'playAreaSoundLoop', 'playAreaSoundLoopStatic', 'stopAllSounds', 'stopAreaSounds', 'systemMute', 'systemUnMute', 'step'];

/**
 * Runs `fn` with the hidden session as the game's current session (level objects look it up
 * globally) and every sound call silenced. The finish is detected through the "Victory" sound,
 * which the game plays for every way of completing a level, replays included.
 */
function inHiddenSession(sim, fn) {
  const S = Game.Settings;
  const sound = Game.SoundController && Game.SoundController.instance;
  const saved = { session: S.currentSession, character: S.characterIndex, hide: S.hideVehicle, level: S.levelIndex };
  const had = {};
  if (sound) {
    for (const n of SOUND_METHODS) {
      had[n] = Object.prototype.hasOwnProperty.call(sound, n) ? sound[n] : undefined;
      sound[n] = n === 'playSoundItem'
        ? (name) => { if (name === 'Victory' && sim.finishStep < 0) sim.finishStep = sim.step; return SILENT; }
        : () => SILENT;
    }
  }
  try {
    if (sim.session) S.currentSession = sim.session;
    return fn();
  } finally {
    S.currentSession = saved.session;
    S.characterIndex = saved.character;
    S.hideVehicle = saved.hide;
    S.levelIndex = saved.level;
    if (sound) for (const n of SOUND_METHODS) { if (had[n] === undefined) delete sound[n]; else sound[n] = had[n]; }
  }
}

/** Session.die without its global side effects (menu input mode, stopping every sound). */
function disposeHidden(sess) {
  const tryRun = (f) => { try { f(); } catch {} };
  tryRun(() => sess.removeEventListener('enterFrame', sess.runBind));
  const ch = sess._character;
  const lvl = sess._level;
  if (ch) { tryRun(() => ch.removeKeyListeners()); tryRun(() => ch.die()); }
  if (lvl) { tryRun(() => lvl.destroyRefs()); tryRun(() => lvl.die()); }
  tryRun(() => sess._particleController && sess._particleController.die());
  tryRun(() => sess._contactListener && sess._contactListener.die());
  tryRun(() => sess.m_world && sess.m_world.Destroy(true));
  tryRun(() => sess.replayProgressBar && sess.replayProgressBar.die());
  tryRun(() => sess._containerSprite && sess._containerSprite.destroy());
  tryRun(() => sess.destroy());
  sess._character = null; sess._level = null; sess.m_world = null; sess._replayData = null;
}

const nextSlice = () => new Promise((r) => setTimeout(r, 0));

let queue = Promise.resolve();
function exclusive(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

/**
 * Plays a replay off-screen. Returns the recorded run, or null if it doesn't reach the finish
 * (drifted, died, or never finished).
 */
async function simulate(loader, levelId, rp, replayData, cancelled) {
  const S = Game.Settings;
  const sim = { session: null, step: 0, finishStep: -1 }; // step: frame index being simulated
  let ch, layout, n, unhook, frames, samples, hideVehicle;
  const events = [];
  if (loader.__hwmpUsed) await rebuildLevel(loader);
  loader.__hwmpUsed = true;
  inHiddenSession(sim, () => {
    S.characterIndex = rp.character;
    S.hideVehicle = loader.__hwmpHideVehicle;
    S.levelIndex = levelId; // Session.setupLevel picks the built-in level 1 class from this
    loader.characterIndex = rp.character;
    loader.loadCharacterData();
    sim.session = new Game.ReplaySession(rp.version, loader.characterData, loader.levelData, loader.levelVersion, replayData, false);
    S.currentSession = sim.session;
    sim.session.create();
    sim.session.removeEventListener('enterFrame', sim.session.runBind);
    ch = sim.session.character;
    try { ch.removeKeyListeners(); } catch {}
    hideVehicle = !!loader.__hwmpHideVehicle;
    layout = computeLayout(ch).slice(0, MAX_BODIES);
    n = layout.length;
    unhook = hookCharacterEvents(ch, (path, method, args) => {
      if (events.length < 400) events.push({ step: sim.step, path, method, args: args.map((a) => (a === undefined ? null : a)) });
    });
  });
  const total = Math.min(sim.session.totalIterations, MAX_STEPS);
  const stride = n * 6;
  frames = new Float32Array((total + COAST_STEPS + 2) * stride);
  samples = new Float64Array(stride);
  sampleBodies(ch, layout, samples);
  frames.set(samples, 0);
  let steps = 0;
  let outcome = null;
  try {
    while (!outcome) {
      outcome = inHiddenSession(sim, () => {
        for (let i = 0; i < CHUNK_STEPS; i++) {
          sim.step = steps + 1;
          sim.session.update30fps();
          steps++;
          sampleBodies(ch, layout, samples);
          frames.set(samples, steps * stride);
          if (sim.finishStep >= 0) { if (steps >= sim.finishStep + COAST_STEPS) return 'finished'; }
          else if (ch.dead) return 'died';
          if (steps >= total + (sim.finishStep >= 0 ? COAST_STEPS : 1)) return sim.finishStep >= 0 ? 'finished' : 'ended';
        }
        return null;
      });
      if (!outcome && cancelled()) outcome = 'cancelled';
      if (!outcome) await nextSlice();
    }
  } finally {
    inHiddenSession(sim, () => { try { unhook(); } catch {} disposeHidden(sim.session); });
  }
  if (outcome !== 'finished') return { outcome };
  return {
    outcome,
    run: {
      replayId: rp.id, author: rp.author, character: rp.character, hideVehicle, layout, n,
      frames: frames.slice(0, (steps + 1) * stride), count: steps + 1,
      finishStep: sim.finishStep, events,
    },
  };
}

// ---- cache (IndexedDB) -----------------------------------------------------------------------------
// Verified runs, replays known not to work, and replay lists survive restarts, so levels raced
// before cost the server nothing. Keyed by game version: an update can change the physics.

const LIST_TTL_MS = 12 * 3600 * 1000;
const MAX_CACHED = 200;
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open('hwmp-ai', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('kv', { keyPath: 'key' }).createIndex('at', 'at');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return dbPromise;
}

const cacheKey = (k) => `${(Game.Settings && Game.Settings.CURRENT_VERSION_STRING) || '?'}|${k}`;

async function cacheGet(k) {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const r = d.transaction('kv').objectStore('kv').get(cacheKey(k));
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function cachePut(k, value) {
  const d = await db();
  if (!d) return;
  try {
    const st = d.transaction('kv', 'readwrite').objectStore('kv');
    st.put({ key: cacheKey(k), at: Date.now(), value });
    const count = st.count();
    count.onsuccess = () => {
      let extra = count.result - MAX_CACHED;
      if (extra <= 0) return;
      st.index('at').openCursor().onsuccess = (e) => {
        const c = e.target.result;
        if (!c || extra-- <= 0) return;
        c.delete();
        c.continue();
      };
    };
  } catch {}
}

// ---- choosing runs --------------------------------------------------------------------------------

const levels = new Map(); // levelId -> Promise<{ loader, newest, fastest, runs: Map(replayId -> run|null) }>

function levelEntry(levelId) {
  let p = levels.get(levelId);
  if (!p) {
    p = (async () => {
      const stored = await cacheGet(`lists:${levelId}`);
      let lists = stored && Date.now() - stored.at < LIST_TTL_MS ? stored.value : null;
      if (!lists) {
        const [newest, fastest] = await Promise.all([listReplays(levelId, 'newest'), listReplays(levelId, 'completion_time')]);
        lists = { newest, fastest };
        cachePut(`lists:${levelId}`, lists);
      }
      const entry = { loader: null, newest: lists.newest, fastest: lists.fastest, runs: new Map(), errors: new Set() };
      entry.getLoader = () => (entry.loader ||= levelRecord(levelId).then(loadLevel).catch((e) => { entry.loader = null; throw e; }));
      return entry;
    })();
    levels.set(levelId, p);
    p.catch(() => levels.delete(levelId));
    while (levels.size > 6) levels.delete(levels.keys().next().value);
  }
  return p;
}

/**
 * Candidate replays for a difficulty, best first. Targets come from the level's own replays:
 * Medium runs about like a typical uploaded run, Easy slower, Hard like the quick ones, Expert is
 * the fastest run that still works.
 */
function candidates(entry, difficulty) {
  const byId = new Map();
  for (const r of [...entry.fastest, ...entry.newest]) byId.set(r.id, r);
  const pool = [...byId.values()];
  if (!pool.length) return [];
  // Replays recorded in older game versions drift more often in this one: try newer ones first.
  const oldPenalty = (r) => (r.version && r.version < 1.9 ? 0.35 : 0);
  if (difficulty === 'expert') return pool.sort((a, b) => a.steps * (1 + oldPenalty(a)) - b.steps * (1 + oldPenalty(b)));
  const sample = (entry.newest.length >= 10 ? entry.newest : pool).map((r) => r.steps).sort((a, b) => a - b);
  const at = (q) => sample[Math.min(sample.length - 1, Math.floor(q * (sample.length - 1)))];
  const fastest = Math.min(...pool.map((r) => r.steps));
  const target = difficulty === 'easy' ? at(0.5) * 1.8
    : difficulty === 'hard' ? Math.max(fastest * 1.1, at(0.2))
      : at(0.5);
  const score = (r) => Math.abs(Math.log(r.steps / target)) + oldPenalty(r);
  return pool.sort((a, b) => score(a) - score(b));
}

/**
 * Finds a working run for an AI racer. `exclude` holds replay ids other racers already use.
 * Returns null if this level has no replay that works in this game version.
 */
export async function findRun(levelId, difficulty, { exclude = new Set(), cancelled = () => false, timeoutMs = 20000 } = {}) {
  const deadline = performance.now() + timeoutMs;
  const entry = await levelEntry(levelId);
  let tries = 0;
  for (const rp of candidates(entry, difficulty)) {
    if (cancelled()) return null;
    if (exclude.has(rp.id) || entry.errors.has(rp.id)) continue;
    if (!entry.runs.has(rp.id)) {
      const stored = await cacheGet(`run:${levelId}:${rp.id}`);
      if (stored) entry.runs.set(rp.id, stored.value);
    }
    if (entry.runs.has(rp.id)) {
      const known = entry.runs.get(rp.id);
      if (known) return known;
      continue;
    }
    if (tries >= MAX_TRIES || performance.now() > deadline) break;
    tries++;
    let result = null;
    try {
      const [data, loader] = await Promise.all([downloadReplay(rp.id, levelId), entry.getLoader()]);
      result = await exclusive(() => simulate(loader, levelId, rp, data, () => cancelled() || performance.now() > deadline + 5000));
    } catch (e) {
      if (e instanceof ServerBusy) { log.warn('AI: the replay server is rate limiting; giving up for now'); throw e; }
      entry.errors.add(rp.id);
      log.warn(`AI: replay ${rp.id} could not be simulated:`, e && e.message, String((e && e.stack) || '').split('\n').slice(1, 7).join(' | '));
    }
    if (result && result.outcome === 'cancelled') return null;
    const run = result && result.run;
    log.info(`AI: replay ${rp.id} v${rp.version} by ${rp.author} (${difficulty}) ${run ? `finishes in ${(run.finishStep * STEP_MS / 1000).toFixed(2)}s` : `rejected (${result ? result.outcome : 'error'})`}`);
    // Remember the verdict unless something went wrong along the way (network, cancelled).
    if (result && (run || result.outcome === 'died' || result.outcome === 'ended')) {
      entry.runs.set(rp.id, run || null);
      cachePut(`run:${levelId}:${rp.id}`, run || null);
    }
    if (run) return run;
  }
  return null;
}
