// Solo modes, without a lobby:
//   Practice  - race a level against a ghost of your personal best (see game/runs.js).
//   Map test  - for map makers: play your level with its multiplayer markers and rules shown.
// Both use the race machinery (spawn points, checkpoints, laps, the map's own finish line).

import { bestRun, bestTime } from '../game/runs.js';
import { STEP_MS, mapInfo } from '../game/replays.js';

export const GHOST_ID = 'ghost';
const INTERP_DELAY_MS = 100; // puppets show snapshots this far behind; the ghost is sent ahead by it

export class Solo {
  constructor(mp, bridge, personal) {
    this.mp = mp;
    this.bridge = bridge;
    this.level = null;
    this.test = false;
    this.t0 = null;          // performance.now() at the first step of this run
    this.finishedMs = null;
    this.best = null;        // best time in ms
    this.ghostRun = null;
    this.nextEvent = 0;
    this.lastResult = null;  // { ms, improved, previousMs }
    bridge.on('sessionStart', (s) => this.onSessionStart(s));
    bridge.on('step', () => this.onStep());
    bridge.on('levelComplete', () => this.onFinish());
    bridge.on('courseFinish', () => this.onFinish());
    bridge.on('exitedToMenu', () => { if (this.active && !bridge.pendingLoad) this.stop(false); });
    personal.onResult((r) => { if (this.active && this.level.id === r.levelId) this.onRecord(r); });
  }

  get active() { return !!this.level; }

  /** level: { id, name, character, forceChar }. */
  async start(level, { test = false } = {}) {
    if (this.mp.racing()) throw new Error('Finish or leave the race first');
    // The map's own rules apply here too, so it plays the way it will in a race.
    const map = await mapInfo(level.id).catch(() => null);
    const rules = (map && map.rules) || {};
    if (this.mp.racing()) throw new Error('Finish or leave the race first');
    this.stop(false);
    const b = this.bridge;
    this.level = level;
    this.test = test;
    this.t0 = null;
    this.finishedMs = null;
    this.lastResult = null;
    this.best = bestTime(level.id);
    this.ghostRun = test ? null : await bestRun(level.id).catch(() => null);
    b.raceMode = true;
    // On your own R always works (a map without restarts would leave you stuck); "start" still applies.
    b.resetMapProgress(0, { restart: rules.mode === 'survival' || rules.restart === 'off' || rules.restart === 'start' ? 'start' : 'checkpoint' });
    b.setCollisions(false);
    b.setFrozen(false);
    b.clearPuppets();
    this.mp.changed();
    const character = level.forceChar && level.character ? level.character : rules.character || this.mp.prefs.character;
    try {
      await b.loadLevel(level.id, { characterIndex: character });
    } catch (e) {
      if (e.message !== 'superseded') { this.stop(false); throw e; }
    }
  }

  /** End the solo run (optionally going back to the main menu). */
  stop(toMenu = true) {
    if (!this.level) return;
    const b = this.bridge;
    this.level = null;
    this.ghostRun = null;
    b.removePuppet(GHOST_ID);
    if (!this.mp.race) {
      b.raceMode = false;
      b.resetMapProgress(null);
    }
    if (toMenu && b.session) b.returnToMenu();
    this.mp.changed();
  }

  onSessionStart() {
    if (!this.active) return;
    const b = this.bridge;
    // A respawn at a checkpoint keeps the clock running; a restart from the start begins again.
    const respawned = b.checkpoint && b.restartMode === 'checkpoint';
    if (!respawned) { this.t0 = null; this.finishedMs = null; this.nextEvent = 0; }
    const run = this.ghostRun;
    if (run) b.setPuppet(GHOST_ID, { characterIndex: run.character, hideVehicle: run.hideVehicle, layout: run.layout });
    this.mp.changed();
  }

  onStep() {
    if (!this.active || !this.bridge.session) return;
    const now = performance.now();
    if (this.t0 == null) this.t0 = now;
    this.driveGhost(now);
  }

  driveGhost(now) {
    const run = this.ghostRun;
    if (!run) return;
    const b = this.bridge;
    const frame = Math.max(0, Math.min(run.count - 1, Math.floor((now - this.t0 + INTERP_DELAY_MS) / STEP_MS)));
    const data = run.frames.subarray(frame * run.n * 6, (frame + 1) * run.n * 6);
    b.puppetState(GHOST_ID, b.now(), data);
    while (this.nextEvent < run.events.length && run.events[this.nextEvent].step <= frame) {
      const ev = run.events[this.nextEvent++];
      b.puppetEvent(GHOST_ID, ev.path, ev.method, ev.args.map((a) => (a === null ? undefined : a)));
    }
  }

  onFinish() {
    if (!this.active || this.finishedMs != null || this.t0 == null) return;
    this.finishedMs = performance.now() - this.t0;
    this.mp.changed();
  }

  /** The finished run was recorded (see PersonalRecords). */
  async onRecord(r) {
    this.lastResult = r;
    if (r.improved) {
      this.best = r.ms;
      const prev = r.previousMs;
      this.mp.toast(prev ? `New personal best! ${(r.ms / 1000).toFixed(2)}s (was ${(prev / 1000).toFixed(2)}s)` : `Personal best set: ${(r.ms / 1000).toFixed(2)}s`);
      // Race the new best next time.
      if (!this.test) this.ghostRun = await bestRun(r.levelId).catch(() => this.ghostRun);
    }
    this.mp.changed();
  }

  /** Current run time in ms (frozen once finished), or null before the first step. */
  elapsed() {
    if (this.finishedMs != null) return this.finishedMs;
    return this.t0 == null ? null : performance.now() - this.t0;
  }
}
