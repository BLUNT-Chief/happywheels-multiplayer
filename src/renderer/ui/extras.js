// Lobby cards and panel views added in 0.2: race rules with map overrides, cups, level votes, the
// session leaderboard, host tools, level details extras, settings, stats, map making help and
// "What's new". Each takes the overlay's context `c` (see createOverlay).

import { h } from './dom.js';
import { describeMap, TAG_REFERENCE } from '../game/mapTags.js';
import { mapInfo } from '../game/replays.js';
import { bestTime, listBests } from '../game/runs.js';
import { readStats, resetStats } from '../net/stats.js';
import { cupRows, cupWinnerText } from '../net/cup.js';
import { voteCounts } from '../net/vote.js';
import { tableRows } from '../net/scoring.js';
import { MAX_CUP_LEVELS } from '../net/cup.js';

export const GUIDE_URL = 'https://github.com/BLUNT-Chief/happywheels-multiplayer/blob/main/docs/MAP_MAKING.md';
const ISSUE_URL = 'https://github.com/BLUNT-Chief/happywheels-multiplayer/issues/new';

const secs = (s) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : `${s}s`);
const byMap = () => h('span', { class: 'badge map', title: 'Set by the map' }, 'map');

// ---- lobby: race rules -------------------------------------------------------------------------
/** The lobby's race rules. Settings the map decides are locked and marked "map". */
export function rulesCard(c, hostMode, inRace) {
  const { mp } = c;
  const s = mp.settings;
  const m = (s.map && s.map.rules) || {};
  const lvl = s.level;
  const edit = hostMode && !inRace;
  const mode = m.mode || s.mode;
  const collisions = m.collisions != null ? m.collisions : s.collisions;
  const grace = m.finishWindow || s.graceSec;
  const forced = m.character || (lvl && lvl.forceChar && lvl.character) || s.forceCharacter;

  const modeRow = h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Mode:'),
    edit && !m.mode
      ? h('select', { onChange: (e) => mp.setMode(e.target.value) },
        h('option', { value: 'race', selected: s.mode === 'race' }, 'Race: fastest to the finish'),
        h('option', { value: 'survival', selected: s.mode === 'survival' }, 'Survival: last one alive wins'))
      : h('span', null, mode === 'survival' ? 'Survival: last one alive wins' : 'Race', m.mode ? byMap() : null));

  const collisionRow = h('label', { class: 'toggle' },
    h('input', { type: 'checkbox', checked: collisions, disabled: !edit || m.collisions != null, onChange: (e) => mp.setCollisions(e.target.checked) }),
    h('span', null, 'Collisions between players'), m.collisions != null ? byMap() : null);

  const charRow = h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Character:'),
    edit && !m.character && !(lvl && lvl.forceChar)
      ? h('select', { onChange: (e) => mp.setForceCharacter(Number(e.target.value)) },
        [0, ...c.charNames().map((_, i) => i + 1)].map((i) => h('option', { value: i, selected: s.forceCharacter === i }, i ? `Everyone: ${c.charName(i)}` : 'Players choose')))
      : h('span', null, forced ? c.charName(forced) : 'Players choose', m.character ? byMap() : lvl && lvl.forceChar ? h('span', { class: 'badge' }, 'level') : null));

  const graceRow = h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'After the first finish, others get'),
    edit && !m.finishWindow
      ? h('select', { onChange: (e) => mp.setGrace(Number(e.target.value)) },
        [15, 30, 45, 60, 90, 120, 300].map((x) => h('option', { value: x, selected: s.graceSec === x }, `${x}s`)))
      : h('span', null, secs(grace), m.finishWindow ? byMap() : null),
    h('span', { class: 'small muted' }, 'to finish.'));

  const extras = [];
  if (m.timeLimit) extras.push(`time limit ${secs(m.timeLimit)}`);
  if (m.laps) extras.push(`${m.laps} lap${m.laps === 1 ? '' : 's'}`);
  if (mode === 'survival' || m.restart === 'off') extras.push('no restarts');
  else if (m.restart === 'start') extras.push('R always goes back to the start');
  if (m.countdown) extras.push(`${m.countdown}s countdown`);
  if (m.ghosts) extras.push(`ghosts ${m.ghosts}% visible`);

  const hostToggles = hostMode ? h('div', { class: 'stack', style: 'gap:6px' },
    h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: s.autoStart, onChange: (e) => mp.setAutoStart(e.target.checked) }),
      h('span', null, 'Start automatically when everyone is ready')),
    h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: s.voteAfter, disabled: s.cup.active, onChange: (e) => mp.setVoteAfter(e.target.checked) }),
      h('span', null, 'Vote for the next level after each race'))) : null;

  return h('div', { class: 'card stack' },
    h('div', { class: 'label' }, 'Race rules'),
    modeRow,
    collisionRow,
    h('div', { class: 'small muted' }, collisions ? 'Racers can bump into each other.' : 'Other racers are see-through ghosts you pass through.'),
    charRow,
    graceRow,
    extras.length ? h('div', { class: 'small' }, h('span', { class: 'muted' }, 'This map: '), extras.join(', '), byMap()) : null,
    hostToggles,
    s.autoStartAt ? h('div', { class: 'autostart' }, `Starting in ${Math.max(0, Math.ceil((s.autoStartAt - mp.clock.now()) / 1000))}s…`) : null);
}

/** What the chosen map sets up (its #mp tags). */
export function mapCard(c) {
  const { mp } = c;
  const s = mp.settings;
  if (!s.level || s.mapState === 'none') return null;
  if (s.mapState === 'loading') return h('div', { class: 'card small muted' }, 'Reading the map…');
  if (s.mapState === 'error') return h('div', { class: 'card small muted' }, "Couldn't read this map's multiplayer rules; the lobby's settings apply.");
  const map = s.map;
  const lines = describeMap(map, (i) => c.charName(i));
  const tooMany = map.rules.players && mp.humans().length > map.rules.players;
  return h('div', { class: 'card stack mapcard' },
    h('div', { class: 'row between' }, h('div', { class: 'label' }, 'Multiplayer map'), h('span', { class: 'badge map' }, 'HWMP')),
    h('div', { class: 'small' }, lines.length ? lines.join(' · ') : 'Made for multiplayer.'),
    tooMany ? h('div', { class: 'small warn' }, `Made for up to ${map.rules.players} racers; this lobby has ${mp.humans().length}.`) : null,
    mp.isHost && map.warnings.length ? h('details', { class: 'small' }, h('summary', null, `${map.warnings.length} note${map.warnings.length === 1 ? '' : 's'} for the map maker`),
      h('ul', null, map.warnings.map((w) => h('li', null, w)))) : null);
}

/** Shown at the top of the panel while practicing or testing a map. */
export function soloCard(c) {
  const { solo, bridge } = c;
  if (!solo || !solo.active) return null;
  return h('div', { class: 'card row between solocard' },
    h('div', null, h('b', null, solo.test ? 'Testing a map' : 'Practicing'), h('span', { class: 'small muted' }, `  ${solo.level.name}`)),
    h('div', { class: 'row' },
      bridge.session ? h('button', { class: 'btn ghost', onClick: () => { c.toggle(false); bridge.restart(); } }, 'Restart') : null,
      h('button', { class: 'btn ghost', onClick: () => { solo.stop(true); c.toggle(false); } }, solo.test ? 'Exit test' : 'Exit practice')));
}

// ---- lobby: cups, votes, leaderboard -----------------------------------------------------------
export function cupCard(c) {
  const { mp, ui } = c;
  const cup = mp.settings.cup;
  const host = mp.isHost;
  if (!cup.levels.length && !host) return null;
  if (!cup.levels.length) {
    return h('div', { class: 'card stack' },
      h('div', { class: 'label' }, 'Cup'),
      h('div', { class: 'small muted' }, 'Race several levels in a row for points. In Choose level…, pick levels and click ', h('b', null, 'Add to cup'), '.'));
  }
  const editable = mp.cupEditable();
  const done = (i) => (cup.active || cup.done) && (i < cup.index || (i === cup.index && cup.scored === cup.index));
  const levels = h('ol', { class: 'cuplist' }, cup.levels.map((l, i) => h('li', { class: `${cup.active && i === cup.index ? 'now' : ''} ${done(i) ? 'done' : ''}` },
    h('span', { class: 'n' }, l.name),
    done(i) ? h('span', { class: 'small muted' }, '✓') : cup.active && i === cup.index ? h('span', { class: 'small' }, 'now') : null,
    editable ? h('button', { class: 'btn ghost small-btn', title: 'Remove from the cup', onClick: () => mp.cupRemove(i) }, '×') : null)));
  const rows = cupRows(cup);
  const table = rows.length ? h('div', { class: 'board' }, rows.map((r) => h('div', { class: `b ${r.id === mp.self.id ? 'me' : ''}` },
    h('span', { class: 'p' }, String(r.place)), h('span', null, r.name), h('span', { class: 'pts' }, `${r.points} pts`)))) : null;
  const title = cup.active ? `Cup · race ${cup.index + 1} of ${cup.levels.length}` : cup.done ? 'Cup finished' : `Cup · ${cup.levels.length} level${cup.levels.length === 1 ? '' : 's'}`;
  const buttons = host ? h('div', { class: 'row' },
    !cup.active && !cup.done ? h('button', { class: 'btn green', disabled: cup.levels.length < 2 || mp.racing(), title: cup.levels.length < 2 ? 'Add at least two levels' : '', onClick: () => { mp.cupStart(); c.toggle(false); } }, 'Start cup') : null,
    cup.active && mp.phase === 'results' && cup.scored === cup.index && cup.index + 1 < cup.levels.length
      ? h('button', { class: 'btn green', onClick: () => { mp.cupNext(); c.toggle(false); } }, `Next race (${cup.index + 2}/${cup.levels.length})`) : null,
    cup.active ? h('button', { class: 'btn ghost', onClick: () => mp.cupEnd() }, 'End cup') : null,
    !cup.active ? h('button', { class: 'btn ghost', disabled: mp.racing(), onClick: () => { if (ui.confirmClearCup) { ui.confirmClearCup = false; mp.cupClear(); } else { ui.confirmClearCup = true; c.render(); } } }, ui.confirmClearCup ? 'Sure? Clear it' : cup.done ? 'New cup' : 'Clear') : null) : null;
  return h('div', { class: 'card stack' },
    h('div', { class: 'row between' }, h('div', { class: 'label' }, title), cup.levels.length < MAX_CUP_LEVELS && editable ? h('span', { class: 'small muted' }, `up to ${MAX_CUP_LEVELS}`) : null),
    levels,
    table,
    cup.done && rows[0] ? h('div', { class: 'winner' }, `🏆 ${cupWinnerText(cup)}`) : null,
    buttons);
}

export function voteCard(c) {
  const { mp } = c;
  const v = mp.settings.vote;
  if (!v) return null;
  const counts = voteCounts(v);
  const mine = mp.myVote && mp.myVote.id === v.id ? mp.myVote.i : v.votes[mp.self.id];
  const left = Math.max(0, Math.ceil((v.endsAt - mp.clock.now()) / 1000));
  return h('div', { class: 'card stack vote' },
    h('div', { class: 'row between' }, h('div', { class: 'label' }, 'Vote for the next level'), h('span', { class: 'small muted' }, `${left}s`)),
    v.options.map((l, i) => h('button', { class: `voteopt ${mine === i ? 'on' : ''}`, onClick: () => mp.voteCast(i) },
      h('span', { class: 'n' }, l.name),
      h('span', { class: 'small muted' }, [l.author, l.forceChar ? c.charName(l.character) : null].filter(Boolean).join(' · ')),
      h('span', { class: 'cnt' }, counts[i] ? `${counts[i]} vote${counts[i] === 1 ? '' : 's'}` : ''))),
    mp.isHost ? h('div', { class: 'row' },
      h('button', { class: 'btn ghost', onClick: () => mp.voteFinish() }, 'End vote now'),
      h('button', { class: 'btn ghost', onClick: () => mp.voteCancel() }, 'Cancel')) : null);
}

export function boardCard(c) {
  const rows = tableRows(c.mp.board);
  if (!rows.length) return null;
  return h('div', { class: 'card stack' },
    h('div', { class: 'label' }, 'Session standings'),
    h('div', { class: 'board' },
      h('div', { class: 'b head' }, h('span', null, ''), h('span', null, ''), h('span', { class: 'pts' }, 'Points'), h('span', { class: 'w' }, 'Wins'), h('span', { class: 'w' }, 'Races')),
      rows.map((r) => h('div', { class: `b ${r.id === c.mp.self.id ? 'me' : ''}` },
        h('span', { class: 'p' }, String(r.place)), h('span', null, r.name), h('span', { class: 'pts' }, String(r.points)), h('span', { class: 'w' }, String(r.wins)), h('span', { class: 'w' }, String(r.races))))));
}

/** Host: actions for another player's row. */
export function hostActions(c, p) {
  const { mp, ui } = c;
  if (!mp.isHost || p.bot || p.id === mp.self.id) return null;
  if (ui.menuFor !== p.id) return h('button', { class: 'btn ghost small-btn', title: 'Host options', onClick: () => { ui.menuFor = p.id; c.render(); } }, '⋯');
  return h('div', { class: 'row', style: 'gap:6px' },
    h('button', { class: 'btn ghost small-btn', title: 'Give them the host role (level choice, race controls, AI racers)', onClick: () => { ui.menuFor = null; mp.makeHost(p.id); } }, 'Make host'),
    h('button', { class: 'btn ghost small-btn danger', title: "Remove them from the lobby; they can't come back while you're the host", onClick: () => { ui.menuFor = null; mp.kick(p.id); } }, 'Remove'),
    h('button', { class: 'btn ghost small-btn', onClick: () => { ui.menuFor = null; c.render(); } }, '×'));
}

export function lockToggle(c) {
  const { mp } = c;
  if (!mp.isHost) return mp.settings.locked ? h('span', { class: 'badge' }, 'locked') : null;
  return h('label', { class: 'toggle small', title: 'Nobody new can join; players who were here can come back' },
    h('input', { type: 'checkbox', checked: mp.settings.locked, onChange: (e) => mp.setLocked(e.target.checked) }),
    h('span', null, 'Lock lobby'));
}

// ---- level details ---------------------------------------------------------------------------------
/** Map rules, your best time, and Practice / Test / Add to cup for the level browser. */
export function detailsExtras(c, l) {
  const { mp, solo } = c;
  const info = mapInfoFor(c, l.id);
  const best = bestTime(l.id);
  const idle = !mp.racing();
  const cupOk = mp.lobby && mp.isHost && mp.cupEditable() && !mp.settings.cup.levels.some((x) => x.id === l.id) && mp.settings.cup.levels.length < MAX_CUP_LEVELS;
  const lines = info.state === 'ready' && info.map ? describeMap(info.map, (i) => c.charName(i)) : [];
  return [
    info.state === 'loading' ? h('div', { class: 'small muted' }, 'Checking for multiplayer rules…') : null,
    info.map ? h('div', { class: 'small mapline' }, h('span', { class: 'badge map' }, 'HWMP'), ' ', lines.join(' · ') || 'Made for multiplayer.') : null,
    best != null ? h('div', { class: 'small' }, h('span', { class: 'muted' }, 'Your best: '), h('b', null, c.fmtTime(best))) : null,
    h('div', { class: 'row' },
      idle ? h('button', { class: 'btn ghost', title: best != null ? 'Race a ghost of your best run, on your own' : 'Play it on your own; your best run is saved as a ghost', onClick: () => c.act(async () => { c.toggle(false); await solo.start(l); }, 'solo') }, 'Practice') : null,
      idle ? h('button', { class: 'btn ghost', title: 'For map makers: play it with its multiplayer markers and rules shown', onClick: () => c.act(async () => { c.toggle(false); await solo.start(l, { test: true }); }, 'solo') }, 'Test map') : null,
      cupOk ? h('button', { class: 'btn ghost', onClick: () => { if (mp.cupAdd(l)) c.toast(`Added to the cup: ${l.name}`); } }, 'Add to cup') : null),
    !idle ? h('div', { class: 'small muted' }, 'Practice and map tests are available between races.') : null,
  ];
}

/** Cached map info for the level browser; fetched a moment after a level is selected. */
function mapInfoFor(c, id) {
  const { ui } = c;
  ui.mapInfos ||= new Map();
  const cached = ui.mapInfos.get(id);
  if (cached) return cached;
  const entry = { state: 'waiting', map: null };
  ui.mapInfos.set(id, entry);
  setTimeout(() => {
    if (!ui.selected || ui.selected.id !== id) { ui.mapInfos.delete(id); return; }
    entry.state = 'loading';
    c.render();
    mapInfo(id).then((m) => { entry.state = 'ready'; entry.map = m; }, () => { entry.state = 'error'; }).then(() => c.render());
  }, 700);
  return entry;
}

// ---- panel views -------------------------------------------------------------------------------------
export function settingsView(c) {
  const { mp, tx, ui } = c;
  const p = mp.prefs;
  const back = () => { ui.view = 'main'; c.render(); };
  const bug = () => {
    const body = [
      'What happened?', '', '', 'What did you expect?', '', '', '---',
      `Mod version: ${tx.modVersion || '?'}`, `Game version: ${c.bridge.gameVersion() || '?'}`,
      'Please attach hwmp.log from the folder that just opened (it has no personal data besides your Steam name).',
    ].join('\n');
    tx.openLogs?.();
    tx.openExternal(`${ISSUE_URL}?title=${encodeURIComponent('Bug: ')}&body=${encodeURIComponent(body)}`);
    c.toast('Your browser opens a bug report; the log folder opened too');
  };
  return [
    c.header('Settings', back),
    h('div', { class: 'body stack' },
      h('div', { class: 'card stack' },
        h('div', { class: 'label' }, 'Other racers'),
        h('div', { class: 'row' }, h('span', { class: 'small muted', style: 'min-width:170px' }, 'Ghost visibility (collisions off)'),
          h('input', { type: 'range', min: 10, max: 90, step: 5, value: p.ghostOpacity, onInput: (e) => mp.setPref('ghostOpacity', Number(e.target.value)) }),
          h('span', { class: 'small' }, `${p.ghostOpacity}%`)),
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: p.nameTags, onChange: (e) => mp.setPref('nameTags', e.target.checked) }), h('span', null, 'Show name tags above racers')),
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: p.markers, onChange: (e) => mp.setPref('markers', e.target.checked) }), h('span', null, 'Show checkpoints and finish lines on multiplayer maps'))),
      h('div', { class: 'card stack' },
        h('div', { class: 'label' }, 'Race screen'),
        h('div', { class: 'row' }, h('span', { class: 'small muted', style: 'min-width:170px' }, 'Timer and standings size'),
          h('select', { onChange: (e) => mp.setPref('hudScale', Number(e.target.value)) },
            [[0.85, 'Small'], [1, 'Normal'], [1.2, 'Large'], [1.4, 'Extra large']].map(([v, t]) => h('option', { value: v, selected: p.hudScale === v }, t)))),
        h('label', { class: 'toggle' }, h('input', { type: 'checkbox', checked: p.emoteKeys, onChange: (e) => mp.setPref('emoteKeys', e.target.checked) }),
          h('span', null, 'Quick chat on keys 1 to 6 during races (GG, Nice!, Oops… and more)'))),
      h('div', { class: 'card stack' },
        h('div', { class: 'label' }, 'Help'),
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost', onClick: () => { ui.whatsNew = true; c.render(); } }, "What's new"),
          h('button', { class: 'btn ghost', onClick: () => { ui.view = 'maphelp'; c.render(); } }, 'Making multiplayer maps'),
          h('button', { class: 'btn ghost', title: 'Opens a bug report on GitHub and the folder with the log to attach', onClick: bug }, 'Report a bug'))),
      h('div', { class: 'small muted' }, `Happy Wheels Multiplayer v${tx.modVersion || '?'} · open source: github.com/BLUNT-Chief/happywheels-multiplayer`)),
  ];
}

export function statsView(c) {
  const { ui } = c;
  const s = readStats();
  const bests = listBests();
  const back = () => { ui.view = 'main'; c.render(); };
  const stat = (label, value) => h('div', { class: 'statbox' }, h('div', { class: 'v' }, String(value)), h('div', { class: 'l' }, label));
  return [
    c.header('Your stats', back),
    h('div', { class: 'body stack' },
      h('div', { class: 'stats' },
        stat('Races', s.races), stat('Wins', s.wins), stat('Podiums', s.podiums), stat('Finishes', s.finishes),
        stat('Best place', s.bestPlace ? `#${s.bestPlace}` : '–'), stat('Survival wins', s.survivalWins), stat('Cups won', s.cupsWon), stat('AI racers beaten', s.aiBeaten)),
      h('div', { class: 'card stack' },
        h('div', { class: 'label' }, `Personal bests (${bests.length})`),
        bests.length
          ? h('div', { class: 'pblist' }, bests.slice(0, 50).map((b) => h('div', { class: 'pb' },
            h('span', { class: 'n' }, b.name),
            h('b', null, c.fmtTime(b.ms)),
            h('span', { class: 'small muted' }, new Date(b.at).toLocaleDateString()),
            h('button', { class: 'btn ghost small-btn', disabled: c.mp.racing(), title: 'Race a ghost of this run', onClick: () => c.act(async () => { c.toggle(false); await c.solo.start({ id: b.levelId, name: b.name, character: b.character, forceChar: false }); }, 'solo') }, 'Practice'))))
          : h('div', { class: 'small muted' }, 'Finish a level (in a race, in practice or in normal play) and your best time and run are saved here.')),
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost', onClick: () => { if (ui.confirmReset) { ui.confirmReset = false; resetStats(); c.toast('Stats reset'); } else ui.confirmReset = true; c.render(); } },
          ui.confirmReset ? 'Sure? Reset career stats' : 'Reset career stats'),
        h('span', { class: 'small muted' }, 'Personal bests are kept.'))),
  ];
}

export function mapHelpView(c) {
  const { ui, tx } = c;
  const back = () => { ui.view = 'main'; c.render(); };
  const test = () => {
    const id = Number((ui.inputs.testid || '').trim());
    if (!Number.isInteger(id) || id < 2) { c.toast('Enter the level ID of your map', 'error'); return; }
    c.act(async () => { c.toggle(false); await c.solo.start({ id, name: `Level ${id}`, character: 0, forceChar: false }, { test: true }); }, 'solo');
  };
  return [
    c.header('Making multiplayer maps', back),
    h('div', { class: 'body stack' },
      h('div', { class: 'small' }, 'Build your map in the normal Happy Wheels level editor, then add ', h('b', null, 'text boxes'), ' with these tags. In races the tag text is hidden; give the text boxes 0% opacity to hide them in single-player too. Put ', h('b', null, 'HWMP'), ' in the level name so it shows up under Multiplayer maps.'),
      h('div', { class: 'tagref' }, TAG_REFERENCE.map(([tag, what]) => h('div', { class: 't' }, h('code', null, tag), h('span', null, what)))),
      h('div', { class: 'card stack' },
        h('div', { class: 'label' }, 'Test your map'),
        h('div', { class: 'small muted' }, 'Publish it (or use its level ID), then play it with every marker shown and any mistakes listed.'),
        h('div', { class: 'row' }, c.textBox('testid', { placeholder: 'Level ID', maxlength: 12, onEnter: test }), h('button', { class: 'btn', onClick: test }, 'Test map'))),
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost', onClick: () => tx.openExternal(GUIDE_URL) }, 'Full guide with examples'),
        h('span', { class: 'small muted' }, 'AI racers drive uploaded replays: upload a replay or two of your map (or race it once and add a "Your best" AI racer).'))),
  ];
}

/** "What's new" dialog after an update. */
export function whatsNewModal(c, notes, onClose) {
  return h('div', { class: 'modalwrap' },
    h('div', { class: 'scrim', onClick: onClose }),
    h('div', { class: 'modal' },
      h('h1', null, "What's new"),
      notes.map((n) => h('div', { class: 'stack', style: 'gap:6px' },
        h('div', { class: 'label' }, `Version ${n.version} · ${n.title}`),
        h('div', { class: 'news' }, n.items.map(([title, text]) => h('div', { class: 'item' }, h('b', null, title), h('span', null, text)))))),
      h('div', { class: 'row', style: 'justify-content:flex-end; margin-top:12px' }, h('button', { class: 'btn green', onClick: onClose }, 'Got it'))));
}
