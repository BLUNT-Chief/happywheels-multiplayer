// In-level HUD extras: course progress (checkpoints/laps), time limits, survival, spectating,
// the solo practice/test HUD, and markers drawn at checkpoints, finish lines and spawn points.

import { h } from './dom.js';
import { describeMap, summarizeTags } from '../game/mapTags.js';

const secs = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`;
};

/** "Lap 2 of 3 · Checkpoint 1 of 4" for maps with a course. */
export function courseLine(bridge) {
  const info = bridge.courseInfo();
  const bits = [];
  if (info.laps > 1) bits.push(`Lap ${Math.min(info.lap, info.laps)} of ${info.laps}`);
  if (info.total && info.ordered) bits.push(`Checkpoint ${info.cp} of ${info.total}`);
  else if (info.total) bits.push(`${info.cp} of ${info.total} checkpoints`);
  if (info.done) return 'Finished!';
  return bits.join('  ·  ');
}

/** Race HUD additions (under the timer). */
export function raceExtras(c, race) {
  const { mp, bridge } = c;
  const now = mp.clock.now();
  const out = [];
  const line = courseLine(bridge);
  if (line) out.push(h('div', { class: 'course' }, line));
  if (race.rules.mode === 'survival' && race.goAt != null && now >= race.goAt) {
    const standing = race.participants.filter((id) => mp.players.has(id) && race.deaths[id] == null && !race.dnf.has(id) && race.finishes[id] == null).length;
    const me = race.deaths[mp.self.id];
    out.push(h('div', { class: `survival ${me != null ? 'out' : ''}` }, me != null ? `You're out · ${standing} still standing` : `Survival · ${standing} standing`));
  }
  if (bridge.spectating) {
    const p = mp.players.get(bridge.spectating);
    out.push(h('div', { class: 'spectate' }, `Watching ${p ? p.name : 'a racer'}`, h('span', { class: 'small' }, '  Tab: next · Backspace: back to you')));
  }
  return out;
}

/** Time left in races with a time limit or finish window. */
export function deadlineHint(c, race) {
  if (!race.deadline || c.mp.phase !== 'racing') return null;
  const left = race.deadline - c.mp.clock.now();
  const label = race.graceSet || race.finishes && Object.keys(race.finishes).length ? 'Race ends in' : 'Time left';
  return h('div', { class: `hint ${left < 10000 ? 'urgent' : ''}`, style: 'bottom: 34px' }, `${label} ${secs(left)}`);
}

/** Solo practice / map test HUD. */
export function soloHud(c) {
  const { solo, bridge, fmtTime } = c;
  const out = [];
  const t = solo.elapsed();
  out.push(h('div', { class: 'timer' }, t == null ? fmtTime(0) : fmtTime(t)));
  const bits = [];
  if (solo.best != null) bits.push(`Best ${fmtTime(solo.best)}`);
  if (solo.ghostRun) bits.push('racing your best run');
  if (!solo.test && solo.best == null) bits.push('finish to set a personal best');
  const line = courseLine(bridge);
  if (line) out.push(h('div', { class: 'course' }, line));
  if (bits.length) out.push(h('div', { class: 'subtimer' }, bits.join('  ·  ')));
  if (solo.finishedMs != null) {
    const r = solo.lastResult;
    out.push(h('div', { class: 'countdown wait finishtext' }, r && r.improved ? 'New personal best!' : 'Finished!'));
  }
  out.push(h('div', { class: 'hint' }, `${bridge.checkpoint ? 'R: back to checkpoint' : 'R: restart'}  ·  F2: exit ${solo.test ? 'the map test' : 'practice'}`));
  return out;
}

/** Map test side panel: the map's rules and anything that looks wrong. */
export function testPanel(c) {
  const { bridge, solo } = c;
  const tags = bridge.mapTags();
  const sum = summarizeTags(tags);
  const lines = sum ? describeMap(sum, (i) => c.charName(i)) : [];
  return h('div', { class: 'testpanel' },
    h('div', { class: 'row between' }, h('b', null, 'Map test'), h('button', { class: 'btn ghost small-btn', onClick: () => solo.stop(true) }, 'Exit')),
    h('div', { class: 'small muted' }, solo.level ? `${solo.level.name} · #${solo.level.id}` : ''),
    !tags ? h('div', { class: 'small' }, 'No #mp tags found. Add text boxes like "#mp spawn 1" or "#mp checkpoint 1" (see Settings → Making multiplayer maps).')
      : h('div', { class: 'stack', style: 'gap:6px' },
        h('div', { class: 'small' }, lines.join(' · ') || 'Tags found.'),
        tags.warnings.length
          ? h('div', { class: 'warnlist' }, tags.warnings.map((w) => h('div', { class: 'small warn' }, `⚠ ${w.text}`)))
          : h('div', { class: 'small ok' }, '✓ No problems found'),
        h('div', { class: 'small muted' }, 'Markers show spawn points (S), checkpoints (numbered, with the area that counts) and finish lines.')));
}

// ---- markers in the level ---------------------------------------------------------------------------
const CHECKPOINT_RADIUS_M = 3;

/**
 * Draws map markers into `layer`. `project(x, y)` maps level pixels to screen pixels; `pxPerMeter`
 * sizes the checkpoint areas. all: map test (spawns, warnings, areas); otherwise just checkpoints
 * and finish lines for racers.
 */
export function drawMarkers(layer, pool, project, pxPerMeter, tags, course, all) {
  const seen = new Set();
  const put = (key, x, y, cls, text, size, pin) => {
    const p = project(x, y);
    if (!p) return;
    // The next place to go stays on screen, pinned to the edge, so racers know which way to head.
    const off = pin && (p.x < 20 || p.y < 20 || p.x > innerWidth - 20 || p.y > innerHeight - 20);
    if (off) { p.x = Math.max(24, Math.min(innerWidth - 24, p.x)); p.y = Math.max(24, Math.min(innerHeight - 24, p.y)); cls += ' edge'; }
    let el = pool.get(key);
    if (!el) { el = h('div', { class: 'mk' }); pool.set(key, el); layer.append(el); }
    if (el.className !== `mk ${cls}`) el.className = `mk ${cls}`;
    if (el.textContent !== text) el.textContent = text;
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    if (size) { el.style.width = `${size}px`; el.style.height = `${size}px`; } else if (el.style.width) { el.style.width = ''; el.style.height = ''; }
    seen.add(key);
  };
  if (tags) {
    const ordered = course.ordered;
    tags.checkpoints.forEach((cp, i) => {
      const reached = ordered ? i < course.cp || course.done : course.reachedSet && course.reachedSet.has(cp);
      const next = ordered && i === course.cp && !course.done;
      const label = ordered ? String(i + 1) : '✓';
      put(`cp${i}`, cp.x, cp.y, `cp ${reached ? 'reached' : ''} ${next ? 'next' : ''}`, reached && !all ? '✓' : label, 0, next && !all);
      if (all) put(`cpr${i}`, cp.x, cp.y, 'area', '', CHECKPOINT_RADIUS_M * 2 * pxPerMeter);
    });
    tags.finishes.forEach((f, i) => {
      const finNext = course.laps && ordered && course.cp >= tags.checkpoints.length && !course.done;
      put(`fin${i}`, f.x, f.y, 'finish', 'FINISH', 0, finNext && !all && i === 0);
      if (all) put(`finr${i}`, f.x, f.y, 'area fin', '', CHECKPOINT_RADIUS_M * 2 * pxPerMeter);
    });
    if (all) {
      tags.spawns.forEach((s, i) => put(`sp${i}`, s.x, s.y, 'spawn', `S${i + 1}`));
      tags.warnings.forEach((w, i) => { if (w.x || w.y) put(`w${i}`, w.x, w.y, 'warnmk', '⚠'); });
    }
  }
  for (const [key, el] of pool) if (!seen.has(key)) { el.remove(); pool.delete(key); }
}
