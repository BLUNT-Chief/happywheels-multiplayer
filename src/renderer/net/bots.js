// Host side of AI racers. When a race loads, finds a working replay run for every AI racer in it
// (see game/replays.js), then plays the recorded runs on the race clock and streams them to
// everyone, exactly like a player's own updates. Other players just see more puppets.

import { findRun, STEP_MS } from '../game/replays.js';
import { encodeBotState, botSlot } from './protocol.js';
import { log } from '../log.js';

export const BOT_SERIAL = 1;
const IDLE_RESEND_MS = 250; // pose updates while an AI racer isn't moving (before GO, after its run)

export class BotDriver {
  constructor(mp) {
    this.mp = mp;
    this.token = 0;
    this.active = new Map(); // bot id -> { run, frame, sentAt, nextEvent, finished }
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
          this.active.set(p.id, { run, frame: -1, sentAt: 0, nextEvent: 0, finished: false });
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
    const peers = mp.peers();
    for (const [id, st] of this.active) {
      if (!mp.players.has(id)) { this.active.delete(id); continue; }
      const { run } = st;
      const frame = started ? Math.min(run.count - 1, Math.floor((now - race.goAt) / STEP_MS)) : 0;
      if (frame === st.frame && now - st.sentAt < IDLE_RESEND_MS) continue;
      // Timestamps must keep increasing: race time while the run plays, the clock when idle.
      const moving = started && frame < run.count - 1;
      const time = moving ? race.goAt + frame * STEP_MS : now;
      st.frame = frame;
      st.sentAt = now;
      const data = run.frames.subarray(frame * run.n * 6, (frame + 1) * run.n * 6);
      mp.bridge.puppetState(id, time, data);
      if (peers.length) mp.send(peers, encodeBotState(botSlot(id), race.id, BOT_SERIAL, time, data, run.n), false);
      while (st.nextEvent < run.events.length && run.events[st.nextEvent].step <= frame && started) {
        const ev = run.events[st.nextEvent++];
        mp.botCtrl(id, { t: 'event', race: race.id, serial: BOT_SERIAL, path: ev.path, method: ev.method, args: ev.args });
      }
      if (!st.finished && started && run.finishStep >= 0 && frame >= run.finishStep) {
        st.finished = true;
        mp.botCtrl(id, { t: 'finish', race: race.id, ms: Math.round(run.finishStep * STEP_MS) });
      }
    }
  }
}
