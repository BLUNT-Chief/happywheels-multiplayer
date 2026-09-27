// Personal bests. The local player's runs are recorded body by body, the same way AI racers' runs
// are, so a best run can be raced as a ghost in practice or driven by an AI racer ("Your best").
// Runs are saved per level in IndexedDB; a small list of best times lives in localStorage.

import { sampleBodies, MAX_BODIES } from './character.js';
import { log } from '../log.js';

const STEP_MS = 1000 / 30;
const MAX_STEPS = 30 * 60 * 6;  // runs longer than 6 minutes aren't kept
const COAST_STEPS = 45;         // keep recording briefly after the finish (like AI runs)
const BESTS_KEY = 'hwmp.bests';

// ---- storage ----------------------------------------------------------------------------------------
let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open('hwmp-runs', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('best', { keyPath: 'levelId' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return dbPromise;
}

function readBests() {
  try { return JSON.parse(localStorage.getItem(BESTS_KEY) || '{}') || {}; } catch { return {}; }
}
function writeBests(b) { try { localStorage.setItem(BESTS_KEY, JSON.stringify(b)); } catch {} }

/** Best times: [{ levelId, name, ms, at, character }], most recent first. */
export function listBests() {
  return Object.values(readBests()).sort((a, b) => b.at - a.at);
}

/** The best time for a level in ms, or null. */
export function bestTime(levelId) {
  const b = readBests()[levelId];
  return b ? b.ms : null;
}

/** The best recorded run for a level (the AI racer / ghost format), or null. */
export async function bestRun(levelId) {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const r = d.transaction('best').objectStore('best').get(Number(levelId));
      r.onsuccess = () => resolve((r.result && r.result.run) || null);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function saveRun(levelId, run) {
  const d = await db();
  if (!d) return;
  try { d.transaction('best', 'readwrite').objectStore('best').put({ levelId: Number(levelId), run }); } catch {}
}

// ---- recording --------------------------------------------------------------------------------------
/**
 * Records every run of the local player (races, practice and normal play) and keeps the best per
 * level. Emits { levelId, name, ms, previousMs, improved } through onResult.
 */
export class PersonalRecords {
  constructor(bridge) {
    this.bridge = bridge;
    this.rec = null;
    this.listeners = new Set();
    bridge.on('sessionStart', (s) => this.begin(s));
    bridge.on('step', (s) => this.step(s));
    bridge.on('localEvent', (path, method, args) => this.event(path, method, args));
    bridge.on('sessionEnd', () => { this.rec = null; });
    bridge.on('levelComplete', () => this.finish());
    bridge.on('courseFinish', () => this.finish());
  }

  onResult(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  begin(session) {
    const b = this.bridge;
    const info = b.localCharacterInfo();
    const layout = b.layout.slice(0, MAX_BODIES);
    // A respawn at a checkpoint isn't a whole run.
    const partial = b.raceMode && b.restartMode === 'checkpoint' && !!b.checkpoint;
    this.rec = partial || !layout.length || !info.levelId ? null : {
      levelId: Number(info.levelId),
      name: b.levelName() || `Level ${info.levelId}`,
      character: info.characterIndex,
      hideVehicle: !!info.hideVehicle,
      layout,
      n: layout.length,
      frames: new Float32Array(Math.min(MAX_STEPS, 30 * 60) * layout.length * 6),
      samples: new Float64Array(layout.length * 6),
      steps: 0,
      events: [],
      finishStep: -1,
      session,
    };
  }

  step(session) {
    const r = this.rec;
    if (!r || r.session !== session || this.bridge.frozen || !session.character) return;
    if (r.steps >= MAX_STEPS) { this.rec = null; return; }
    const stride = r.n * 6;
    if ((r.steps + 1) * stride > r.frames.length) {
      const bigger = new Float32Array(Math.min(MAX_STEPS * stride, r.frames.length * 2));
      bigger.set(r.frames);
      r.frames = bigger;
    }
    sampleBodies(session.character, r.layout, r.samples);
    r.frames.set(r.samples, r.steps * stride);
    r.steps++;
    if (r.finishStep >= 0 && r.steps >= r.finishStep + COAST_STEPS) this.complete();
  }

  event(path, method, args) {
    const r = this.rec;
    if (r && r.events.length < 400) r.events.push({ step: r.steps, path, method, args: args.map((a) => (a === undefined ? null : a)) });
  }

  /** The local player just finished (the level's finish, or the map's own finish line). */
  finish() {
    const r = this.rec;
    if (r && r.finishStep < 0 && r.steps > 0) r.finishStep = r.steps;
  }

  async complete() {
    const r = this.rec;
    this.rec = null;
    if (!r || r.finishStep < 0) return;
    const ms = Math.round(r.finishStep * STEP_MS);
    const run = {
      replayId: `best:${r.levelId}`, author: 'your best run', character: r.character, hideVehicle: r.hideVehicle,
      layout: r.layout, n: r.n, frames: r.frames.slice(0, r.steps * r.n * 6), count: r.steps, finishStep: r.finishStep, events: r.events,
    };
    const bests = readBests();
    const prev = bests[r.levelId];
    const improved = !prev || ms < prev.ms;
    if (improved) {
      bests[r.levelId] = { levelId: r.levelId, name: r.name, ms, at: Date.now(), character: r.character };
      writeBests(bests);
      await saveRun(r.levelId, run);
      log.info(`personal best on ${r.name}: ${ms} ms`);
    }
    for (const fn of this.listeners) { try { fn({ levelId: r.levelId, name: r.name, ms, previousMs: prev ? prev.ms : null, improved }); } catch {} }
  }
}

export { STEP_MS };
