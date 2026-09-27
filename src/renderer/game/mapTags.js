// Multiplayer map tags. Map makers build levels in the normal Happy Wheels editor and add text
// boxes whose text starts with "#mp" (see docs/MAP_MAKING.md for the full guide):
//
//   Places                        Rules (override the lobby's settings on this map)
//   #mp spawn [n]                 #mp collisions on|off        #mp character <name or 1-11>
//   #mp checkpoint [n]            #mp finish window <time>     #mp time limit <time>
//   #mp finish                    #mp ai on|off / ai max <n>   #mp restart on|off|start|checkpoint
//                                 #mp countdown <seconds>      #mp ghosts <percent>
//                                 #mp players <n>              #mp laps <n>
//                                 #mp mode race|survival
//
// Times can be written as 90, 90s, 1:30 or 2m. In races the tags are read before the level is
// built and their text is blanked, so they never show. (Map makers can also give the text boxes
// 0% opacity to hide them in normal single-player play.)

export const CHARACTER_NAMES = ['wheelchair guy', 'segway guy', 'irresponsible dad', 'effective shopper', 'moped couple',
  'lawnmower man', 'explorer guy', 'santa claus', 'pogostick man', 'irresponsible mom', 'helicopter man'];

/** Tag reference for the in-game help and the guide: [syntax, what it does]. */
export const TAG_REFERENCE = [
  ['#mp spawn 1', 'A start position. Add several (numbered) and racers are spread across them.'],
  ['#mp checkpoint 1', 'A checkpoint. After passing it, R respawns you there. Numbered ones must be passed in order.'],
  ['#mp finish', 'A custom finish line: touching it (after all checkpoints, in order) finishes the race or a lap.'],
  ['#mp laps 3', 'Circuit race: pass every checkpoint and then the #mp finish this many times.'],
  ['#mp collisions on', 'Racers collide on this map (or "off": they pass through each other).'],
  ['#mp character segway', 'Everyone races as this character (a name or a number from 1 to 11).'],
  ['#mp finish window 60', 'How long everyone else gets after the first racer finishes.'],
  ['#mp time limit 3:00', 'The race ends after this long; unfinished racers are ranked by progress.'],
  ['#mp ai off', 'No AI racers on this map. Or "#mp ai max 3" to allow at most three.'],
  ['#mp restart checkpoint', 'What R does: "checkpoint" (default), "start" (always the start line) or "off".'],
  ['#mp countdown 5', 'Length of the start countdown in seconds (2 to 15).'],
  ['#mp ghosts 30', 'How visible other racers are when collisions are off, in percent.'],
  ['#mp players 4', 'The number of racers the map is made for; bigger lobbies get a warning.'],
  ['#mp mode survival', 'Last racer alive wins (no restarts). "#mp mode race" is the normal race.'],
];

const RULE_LIMITS = {
  finishWindow: [5, 600], timeLimit: [10, 3600], countdown: [2, 15], ghosts: [5, 95], players: [1, 16], laps: [1, 20], aiMax: [0, 7],
};

/** "90", "90s", "1:30", "2m", "1m30s" -> seconds, or null. */
export function parseDuration(text) {
  const t = String(text || '').trim().toLowerCase();
  let m;
  if ((m = /^(\d+):(\d{1,2})$/.exec(t))) return Number(m[1]) * 60 + Number(m[2]);
  if ((m = /^(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s(?:ec)?)?$/.exec(t)) && (m[1] || m[2])) return Number(m[1] || 0) * 60 + Number(m[2] || 0);
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t));
  return null;
}

/** A character by name (or part of one) or number 1-11, or 0 if unknown. */
export function characterFromText(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^\d+$/.test(t)) { const n = Number(t); return n >= 1 && n <= 11 ? n : 0; }
  if (!t) return 0;
  const exact = CHARACTER_NAMES.indexOf(t);
  if (exact >= 0) return exact + 1;
  const words = t.split(/\s+/);
  const i = CHARACTER_NAMES.findIndex((n) => words.every((w) => n.includes(w)));
  return i >= 0 ? i + 1 : 0;
}

const inRange = (key, v) => Number.isFinite(v) && v >= RULE_LIMITS[key][0] && v <= RULE_LIMITS[key][1];

/**
 * Reads one tag. Returns { place: 'spawn'|'checkpoint'|'finish', order } or { rule: key, value }
 * or { warning }.
 */
function readTag(body) {
  const t = body.trim().toLowerCase().replace(/\s+/g, ' ');
  let m;
  const num = (s) => { const n = Number.parseFloat(s); return Number.isFinite(n) ? n : null; };
  if ((m = /^spawn(?: (\S+))?$/.exec(t))) return { place: 'spawn', order: m[1] == null ? null : num(m[1]) };
  if ((m = /^checkpoint(?: (\S+))?$/.exec(t))) return { place: 'checkpoint', order: m[1] == null ? null : num(m[1]) };
  if (/^finish(?: line)?$/.test(t)) return { place: 'finish' };
  if ((m = /^collisions? (on|off)$/.exec(t))) return { rule: 'collisions', value: m[1] === 'on' };
  if ((m = /^character (.+)$/.exec(t))) {
    const c = characterFromText(m[1]);
    return c ? { rule: 'character', value: c } : { warning: `Unknown character "${m[1]}" (use a name like "segway" or a number from 1 to 11)` };
  }
  if ((m = /^finish ?window (.+)$/.exec(t))) {
    const s = parseDuration(m[1]);
    return inRange('finishWindow', s) ? { rule: 'finishWindow', value: s } : { warning: 'Finish window must be between 5 seconds and 10 minutes' };
  }
  if ((m = /^time ?limit (.+)$/.exec(t))) {
    const s = parseDuration(m[1]);
    return inRange('timeLimit', s) ? { rule: 'timeLimit', value: s } : { warning: 'Time limit must be between 10 seconds and 60 minutes' };
  }
  if ((m = /^ai (on|off)$/.exec(t))) return { rule: 'ai', value: m[1] === 'on' };
  if ((m = /^ai max (\d+)$/.exec(t))) {
    const n = Number(m[1]);
    return inRange('aiMax', n) ? { rule: 'aiMax', value: n } : { warning: 'AI max must be between 0 and 7' };
  }
  if ((m = /^restarts? (on|off|start|checkpoints?)$/.exec(t))) {
    const v = m[1] === 'on' ? 'checkpoint' : m[1].replace(/s$/, '');
    return { rule: 'restart', value: v };
  }
  if ((m = /^countdown (\S+)$/.exec(t))) {
    const s = parseDuration(m[1]);
    return inRange('countdown', s) ? { rule: 'countdown', value: s } : { warning: 'Countdown must be between 2 and 15 seconds' };
  }
  if ((m = /^ghosts? (\d+)%?$/.exec(t))) {
    const n = Number(m[1]);
    return inRange('ghosts', n) ? { rule: 'ghosts', value: n } : { warning: 'Ghosts must be between 5 and 95 percent' };
  }
  if ((m = /^players (\d+)$/.exec(t))) {
    const n = Number(m[1]);
    return inRange('players', n) ? { rule: 'players', value: n } : { warning: 'Players must be between 1 and 16' };
  }
  if ((m = /^laps? (\d+)$/.exec(t))) {
    const n = Number(m[1]);
    return inRange('laps', n) ? { rule: 'laps', value: n } : { warning: 'Laps must be between 1 and 20' };
  }
  if ((m = /^mode (race|survival)$/.exec(t))) return { rule: 'mode', value: m[1] };
  return { warning: `Unknown tag "#mp ${body.trim()}"` };
}

function specialContainer(root) {
  const kids = root && root.children;
  return kids ? kids.find((c) => c && c.name === 'special') || null : null;
}

const TAG = /^\s*#mp\b(.*)$/is;

/* global __DEV__ */
/**
 * Dev tests only (compiled out of releases): globalThis.__hwmpFakeTags = { level, captions: [...],
 * extra: [{ caption, x, y }] } replaces that level's text box captions in order and adds pretend
 * text boxes, so map features can be tested on levels that have no tags.
 */
function devTextBoxes(special, levelId) {
  const fake = typeof __DEV__ !== 'undefined' && __DEV__ ? globalThis.__hwmpFakeTags : null;
  if (!fake || (fake.level && Number(fake.level) !== Number(levelId))) return [];
  const boxes = special.children.filter((c) => c && c._type === 'TextBoxRef');
  (fake.captions || []).forEach((cap, i) => { if (boxes[i] && cap != null) boxes[i]._caption = cap; });
  return (fake.extra || []).map((e) => ({ _type: 'TextBoxRef', _caption: String(e.caption), x: Number(e.x) || 0, y: Number(e.y) || 0 }));
}

/**
 * Reads the tags from a level's editor tree (a Level's shapeGuide, or the source a level is built
 * from). Doesn't change anything. Positions are in level pixels (the editor's units).
 * Returns null for levels without any #mp text.
 */
export function readMapTags(root, levelId) {
  const special = specialContainer(root);
  if (!special || !special.children) return null;
  const tags = { spawns: [], checkpoints: [], finishes: [], rules: {}, warnings: [], items: [] };
  for (const item of [...special.children, ...devTextBoxes(special, levelId)]) {
    if (!item || item._type !== 'TextBoxRef' || typeof item._caption !== 'string') continue;
    const m = TAG.exec(item._caption);
    if (!m) continue;
    tags.items.push(item);
    const at = { x: Number(item.x) || 0, y: Number(item.y) || 0 };
    const firstLine = m[1].split(/[\r\n]/)[0];
    const r = readTag(firstLine);
    if (r.warning) { tags.warnings.push({ text: r.warning, ...at }); continue; }
    if (r.place) {
      const point = { ...at, order: Number.isFinite(r.order) ? r.order : null };
      (r.place === 'spawn' ? tags.spawns : r.place === 'checkpoint' ? tags.checkpoints : tags.finishes).push(point);
      continue;
    }
    if (r.rule in tags.rules) tags.warnings.push({ text: `"#mp ${firstLine.trim()}" repeats a rule that's already set; the first one is used`, ...at });
    else tags.rules[r.rule] = r.value;
  }
  if (!tags.items.length) return null;
  // Numbered places in their order, unnumbered ones after them in the order they were placed.
  const byOrder = (a, b) => (a.order ?? Infinity) - (b.order ?? Infinity);
  tags.spawns.sort(byOrder);
  tags.checkpoints.sort(byOrder);
  addWarnings(tags);
  return tags;
}

function addWarnings(tags) {
  const warn = (text, p) => tags.warnings.push({ text, x: p ? p.x : 0, y: p ? p.y : 0 });
  const r = tags.rules;
  if (r.laps && !tags.finishes.length) warn('Laps need a "#mp finish" to count a lap');
  if (r.laps > 1 && !tags.checkpoints.length) warn('A lap race needs at least one checkpoint, or racers could just sit on the finish');
  if (r.mode === 'survival' && r.restart && r.restart !== 'off') warn('Survival maps never allow restarts; the restart rule is ignored');
  const close = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 60; // pixels: about one character apart
  tags.spawns.forEach((s, i) => { if (tags.spawns.slice(i + 1).some((o) => close(s, o))) warn('Two spawn points are almost on top of each other', s); });
  const orders = tags.checkpoints.map((c) => c.order).filter((o) => o != null);
  if (new Set(orders).size !== orders.length) warn('Two checkpoints have the same number');
}

/**
 * Reads the tags of a player-made level that hasn't been built yet (at its first start-point
 * request) and blanks the tag text so it never shows in races.
 */
export function takeMapTags(level, levelId) {
  const tags = readMapTags(level && level.shapeGuide, levelId);
  if (!tags) return null;
  // Blank the text rather than removing the box: triggers and groups may refer to it.
  for (const item of tags.items) item._caption = '';
  delete tags.items;
  return tags;
}

/** Plain, network-safe summary of a map's tags, for the lobby and the race. */
export function summarizeTags(tags) {
  if (!tags) return null;
  return {
    rules: { ...tags.rules },
    spawns: tags.spawns.length,
    checkpoints: tags.checkpoints.length,
    finishes: tags.finishes.length,
    warnings: tags.warnings.map((w) => w.text).slice(0, 12),
  };
}

/** Human-readable lines describing a map summary (for the lobby and level details). */
export function describeMap(summary, characterName = (i) => CHARACTER_NAMES[i - 1] || `character ${i}`) {
  if (!summary) return [];
  const r = summary.rules || {};
  const out = [];
  const t = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`);
  if (r.mode === 'survival') out.push('Survival: last racer alive wins');
  if (r.laps) out.push(`${r.laps} lap${r.laps === 1 ? '' : 's'}`);
  if (summary.spawns) out.push(`${summary.spawns} start position${summary.spawns === 1 ? '' : 's'}`);
  if (summary.checkpoints) out.push(`${summary.checkpoints} checkpoint${summary.checkpoints === 1 ? '' : 's'}`);
  if (summary.finishes && !r.laps) out.push('custom finish line');
  if (r.collisions != null) out.push(`collisions ${r.collisions ? 'on' : 'off'}`);
  if (r.character) out.push(`everyone as ${characterName(r.character)}`);
  if (r.timeLimit) out.push(`time limit ${t(r.timeLimit)}`);
  if (r.finishWindow) out.push(`${t(r.finishWindow)} finish window`);
  if (r.ai === false || r.aiMax === 0) out.push('no AI racers');
  else if (r.aiMax) out.push(`at most ${r.aiMax} AI racer${r.aiMax === 1 ? '' : 's'}`);
  if (r.restart === 'off') out.push('no restarts');
  else if (r.restart === 'start') out.push('R always restarts from the start');
  if (r.countdown) out.push(`${r.countdown}s countdown`);
  if (r.ghosts) out.push(`ghosts ${r.ghosts}% visible`);
  if (r.players) out.push(`made for ${r.players} racer${r.players === 1 ? '' : 's'}`);
  return out;
}
