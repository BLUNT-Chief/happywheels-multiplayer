// Host side of AI racers. When a race loads, finds a working replay run for every AI racer in it
// (see game/replays.js), then plays the recorded runs on the race clock and streams them to
// everyone, exactly like a player's own updates. Other players just see more puppets.
//
// With collisions on, a hard hit knocks an AI racer out of its run: it pauses its route, tumbles
// under real physics in the host's game, gets itself back upright onto its route where it was hit,
// and carries on. The time that took is added to its race.

import { findRun, STEP_MS } from '../game/replays.js';
import { sampleBodies } from '../game/character.js';
import { encodeBotState, botSlot } from './protocol.js';
import { log } from '../log.js';

export const BOT_SERIAL = 1;
const IDLE_RESEND_MS = 250; // pose updates while an AI racer isn't moving (before GO, after its run)
const TUMBLE_MS = 1100;     // knocked about by physics
const RECOVER_MS = 650;     // getting back upright onto its route
const IMMUNE_MS = 1200;     // after recovering, before it can be knocked again

function lerpAngle(a, b, t) {
  let d = b - a;
  d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
  return a + d * t;
}
const ease = (t) => t * t * (3 - 2 * t);

export class BotDriver {
  constructor(mp) {
    this.mp = mp;
    this.token = 0;
    this.active = new Map(); // bot id -> { run, frame, sentAt, nextEvent, finished, offset, knock, immuneUntil }
    this.timer = null;
  }

  /** Host: a race is loading. Finds a run for each AI racer; each one reports ready or DNF. */
  prepare(race) {
    this.stop();
    const token = this.token;
    const bots = race.participants.map((id) => this.mp.players.get(id)).filter((p) => p && p.bot);
    if (!bots.length) return;
    this.timer = setInterval(() => this.tick(), STEP_MS);
    const used = new Set();
    const cancelled = () => token !== this.token;
    (async () => {
      for (const p of bots) {
        if (cancelled()) return;
        let run = null;
        let reason = '';
        try {
          run = await findRun(race.level.id, p.bot.difficulty, { exclude: used, cancelled });
        } catch (e) {
          log.warn('AI: could not look up runs for this level:', e && e.message);
          reason = (e && e.message) || '';
        }
        if (cancelled() || this.mp.race !== race) return;
        if (!this.mp.players.has(p.id)) continue;
        if (run) {
          used.add(run.replayId);
          this.active.set(p.id, { run, frame: -1, sentAt: 0, nextEvent: 0, finished: false, offset: 0, knock: null, immuneUntil: 0, pose: new Float64Array(run.n * 6) });
          this.mp.botReady(p.id, run);
        } else {
          this.mp.botFailed(p.id, reason);
        }
      }
    })();
  }

  stop() {
    this.token++;
    clearInterval(this.timer);
    this.timer = null;
    this.active.clear();
  }

  spawnMsg(id) {
    const st = this.active.get(id);
    const race = this.mp.race;
    if (!st || !race) return null;
    const r = st.run;
    return { t: 'spawn', race: race.id, serial: BOT_SERIAL, character: r.character, hideVehicle: r.hideVehicle, layout: r.layout };
  }

  /**
   * An AI racer was hit hard (collisions on). `hit.local`: the collision happened in the host's own
   * game, so physics already pushed it; otherwise apply the push reported by the player who hit it.
   */
  knock(id, hit) {
    const st = this.active.get(id);
    const race = this.mp.race;
    if (!st || !race || race.goAt == null || st.knock || st.finished) return;
    const now = this.mp.clock.now();
    if (now < st.immuneUntil || now < race.goAt) return;
    const frame = this.frameAt(st, now);
    if (frame <= 0 || frame >= st.run.count - 1) return;
    st.knock = { phase: 'tumble', t0: now, frame, from: null };
    const push = hit.local ? null : hit;
    const physical = !!this.mp.bridge.setPuppetFree(id, true, push);
    st.knock.physical = physical;
    log.info(`AI: ${id} knocked (impulse ${Math.round(hit.impulse)}${hit.local ? '' : ', reported by a player'})`);
  }

  frameAt(st, now) {
    const race = this.mp.race;
    return Math.max(0, Math.min(st.run.count - 1, Math.floor((now - race.goAt - st.offset) / STEP_MS)));
  }

  /** Streams one pose for an AI racer to everyone and to the host's own view. */
  sendPose(id, time, data, n) {
    const mp = this.mp;
    mp.bridge.puppetState(id, time, data);
    const peers = mp.peers();
    if (peers.length) mp.send(peers, encodeBotState(botSlot(id), mp.race.id, BOT_SERIAL, time, data, n), false);
  }

  /** Knocked: tumble under physics, then blend back upright onto the route where it was hit. */
  tickKnock(id, st, now) {
    const k = st.knock;
    const run = st.run;
    const n = run.n;
    const target = run.frames.subarray(k.frame * n * 6, (k.frame + 1) * n * 6);
    if (k.phase === 'tumble') {
      const p = k.physical && this.mp.bridge.puppets.get(id);
      if (p && p.character) sampleBodies(p.character, run.layout, st.pose);
      else st.pose.set(target); // host isn't in the level: it just stops for a moment
      this.sendPose(id, now, st.pose, n);
      if (now - k.t0 >= TUMBLE_MS) {
        k.phase = 'recover';
        k.t1 = now;
        k.from = Float64Array.from(st.pose);
        if (k.physical) this.mp.bridge.setPuppetFree(id, false);
      }
      return;
    }
    const t = ease(Math.min(1, (now - k.t1) / RECOVER_MS));
    const out = st.pose;
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      if (!Number.isFinite(k.from[o]) || !Number.isFinite(target[o])) { for (let j = 0; j < 6; j++) out[o + j] = target[o + j]; continue; }
      out[o] = k.from[o] + (target[o] - k.from[o]) * t;
      out[o + 1] = k.from[o + 1] + (target[o + 1] - k.from[o + 1]) * t;
      out[o + 2] = lerpAngle(k.from[o + 2], target[o + 2], t);
      out[o + 3] = target[o + 3] * t; out[o + 4] = target[o + 4] * t; out[o + 5] = target[o + 5] * t;
    }
    this.sendPose(id, now, out, n);
    if (t >= 1) {
      // Resume the route from where it was hit: everything after shifts by the time lost.
      st.offset = now - this.mp.race.goAt - k.frame * STEP_MS;
      st.knock = null;
      st.frame = -1;
      st.immuneUntil = now + IMMUNE_MS;
    }
  }

  /** A player (re)joined mid-race: describe every AI racer to them, damage included. */
  resendTo(peer) {
    for (const [id, st] of this.active) {
      const spawn = this.spawnMsg(id);
      if (!spawn) continue;
      this.mp.sendTo(peer, { ...spawn, bot: id });
      for (let i = 0; i < st.nextEvent; i++) {
        const ev = st.run.events[i];
        this.mp.sendTo(peer, { t: 'event', race: this.mp.race.id, serial: BOT_SERIAL, path: ev.path, method: ev.method, args: ev.args, bot: id });
      }
    }
  }

  tick() {
    const mp = this.mp;
    const race = mp.race;
    if (!race || !mp.isHost) return;
    const now = mp.clock.now();
    const started = race.goAt != null && now >= race.goAt;
    for (const [id, st] of this.active) {
      if (!mp.players.has(id)) { this.active.delete(id); continue; }
      if (st.knock) { this.tickKnock(id, st, now); continue; }
      const { run } = st;
      const frame = started ? this.frameAt(st, now) : 0;
      if (frame === st.frame && now - st.sentAt < IDLE_RESEND_MS) continue;
      // Timestamps must keep increasing: race time while the run plays, the clock when idle.
      const moving = started && frame < run.count - 1;
      const time = moving ? race.goAt + st.offset + frame * STEP_MS : now;
      st.frame = frame;
      st.sentAt = now;
      const data = run.frames.subarray(frame * run.n * 6, (frame + 1) * run.n * 6);
      this.sendPose(id, time, data, run.n);
      while (st.nextEvent < run.events.length && run.events[st.nextEvent].step <= frame && started) {
        const ev = run.events[st.nextEvent++];
        mp.botCtrl(id, { t: 'event', race: race.id, serial: BOT_SERIAL, path: ev.path, method: ev.method, args: ev.args });
      }
      if (!st.finished && started && run.finishStep >= 0 && frame >= run.finishStep) {
        st.finished = true;
        mp.botCtrl(id, { t: 'finish', race: race.id, ms: Math.round(run.finishStep * STEP_MS + st.offset) });
      }
    }
  }
}
