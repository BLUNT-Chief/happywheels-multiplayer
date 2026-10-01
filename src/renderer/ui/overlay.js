// DOM overlay (inside a shadow root) for the lobby browser, lobby room, level browser and race HUD.
// All player-supplied text is inserted as text nodes, never as HTML.

import css from './styles.css';
import { fmtTime, EMOTES } from '../net/race.js';
import { DIFFICULTIES, DIFFICULTY_NAMES } from '../game/replays.js';
import { MAX_BOTS } from '../net/protocol.js';
import { log } from '../log.js';
import { h, patch, lobbyCode, parseCode, stars, fmtNum } from './dom.js';
import { rankRace } from '../net/scoring.js';
import { GHOST_ID } from '../net/solo.js';
import { cupWinnerText } from '../net/cup.js';
import { notesSince, CHANGELOG } from './changelog.js';
import { soloCard, rulesCard, mapCard, cupCard, voteCard, boardCard, hostActions, lockToggle, detailsExtras, settingsView, statsView, mapHelpView, whatsNewModal, GUIDE_URL } from './extras.js';
import { raceExtras, deadlineHint, soloHud, testPanel, drawMarkers } from './hud.js';

export function createOverlay(mp, bridge, tx, { solo = null } = {}) {
  const host = h('div', { id: 'hwmp-overlay' });
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.append(h('style', null, css));
  const root = h('div', { class: 'root' });
  const scaled = h('div', { class: 'scaled' });
  shadow.append(root);
  // Scale the UI with the window like the game does (tags stay unscaled; they track world coords).
  const applyScale = () => {
    const z = Math.max(0.85, Math.min(1.6, innerHeight / 800));
    scaled.style.zoom = String(z);
    scaled.style.setProperty('--z', String(z));
  };
  addEventListener('resize', applyScale);
  applyScale();
  const hud = h('div', { class: 'hudroot' });
  const tags = h('div');
  const markers = h('div');
  const modalLayer = h('div');
  const panelLayer = h('div');
  const resultsLayer = h('div');
  const raceMenuLayer = h('div');
  const toasts = h('div', { class: 'toasts' });
  const updateBox = h('div');
  const tipLayer = h('div');
  const pill = h('button', { class: 'pill', title: 'Multiplayer (F2)', onClick: () => toggle() });
  scaled.append(hud, resultsLayer, raceMenuLayer, panelLayer, toasts, updateBox, tipLayer, pill, modalLayer);
  root.append(markers, tags, scaled);
  (document.body || document.documentElement).append(host);

  const ui = {
    open: false,
    view: 'main', // main | levels | settings | stats | maphelp
    inputs: {},   // text typed into boxes, by key (survives redraws)
    busy: false,
    lobbies: null, lobbiesErr: null, loadingLobbies: false,
    featured: null, featuredErr: null,
    levelTab: 'featured', featuredChar: 0,
    player: { mode: 'all', sort: 'rating', uploaded: 'anytime', page: 1, pages: 1, results: null, loading: false, error: null },
    idLookup: { loading: false, error: null },
    mpmaps: { sort: 'rating', page: 1, pages: 1, results: null, loading: false, error: null },
    selected: null,
    resultsHidden: false,
    shortcut: null,
    menuFor: null,      // host options open for this player
    whatsNew: false,    // show the What's new dialog
    bubbles: new Map(), // racer id -> { text, until } (quick chat)
  };
  const avatars = new Map();
  const charNames = () => { const n = bridge.characterNames(); return n.length ? n : Array.from({ length: 11 }, (_, i) => `Character ${i + 1}`); };
  const charName = (i) => (i ? (charNames()[i - 1] || `Character ${i}`) : 'Players choose');
  const activeInput = () => { const a = shadow.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA') ? a : null; };

  // Keys typed into our boxes must not drive the game, but the boxes themselves still need them:
  // this listener runs first (capture on window), handles Enter/Escape for the focused box, and
  // stops the event before the game's listeners. Typing itself is the browser's default action.
  window.addEventListener('keydown', (e) => {
    const a = activeInput();
    if (a) {
      if (e.key === 'Enter' && a.__onEnter) { e.preventDefault(); a.__onEnter(); }
      else if (e.key === 'Escape') a.blur();
      e.stopImmediatePropagation();
      return;
    }
    if (e.key === 'F2') { e.preventDefault(); e.stopImmediatePropagation(); toggle(); return; }
    if (ui.whatsNew && e.key === 'Escape') { e.stopImmediatePropagation(); closeWhatsNew(); return; }
    if (ui.open && e.key === 'Escape') { e.stopImmediatePropagation(); if (ui.view !== 'main') { ui.view = 'main'; render(); } else toggle(false); return; }
    const inRaceLevel = bridge.session && bridge.raceMode && !bridge.frozen;
    const racingNow = mp.race && (mp.phase === 'racing' || mp.phase === 'results');
    if ((e.key === 'r' || e.key === 'R') && !e.repeat && inRaceLevel && (racingNow || (solo && solo.active))) {
      e.stopImmediatePropagation();
      bridge.restart();
      return;
    }
    // Spectate: Tab cycles through the other racers once you're done (finished, out, or results).
    if (e.key === 'Tab' && inRaceLevel && mp.race && canSpectate()) {
      e.preventDefault(); e.stopImmediatePropagation();
      cycleSpectate(e.shiftKey ? -1 : 1);
      return;
    }
    if (e.key === 'Backspace' && bridge.spectating) { e.preventDefault(); e.stopImmediatePropagation(); bridge.spectate(null); return; }
    // Quick chat: keys 1-6 during races.
    if (mp.prefs.emoteKeys && inRaceLevel && mp.race && !e.repeat && e.key >= '1' && e.key <= String(EMOTES.length)) {
      e.stopImmediatePropagation();
      mp.emote(Number(e.key) - 1);
    }
  }, true);
  for (const type of ['keyup', 'keypress']) window.addEventListener(type, (e) => { if (activeInput()) e.stopImmediatePropagation(); }, true);

  // Clicking our buttons must not take keyboard focus from the game: a focused button would be
  // 'clicked' again by Space/Enter, which are Happy Wheels controls.
  shadow.addEventListener('mousedown', (e) => {
    const t = e.target;
    if (t instanceof Element && t.closest('button, .lvrow, .level')) e.preventDefault();
  }, true);

  // First-run pointer at the MULTIPLAYER button, shown until the player has opened the panel once.
  const TIP_KEY = 'hwmp.tipSeen';
  let tipSeen = false;
  try { tipSeen = localStorage.getItem(TIP_KEY) === '1'; } catch {}
  function markTipSeen() {
    if (tipSeen) return;
    tipSeen = true;
    try { localStorage.setItem(TIP_KEY, '1'); } catch {}
    tipLayer.replaceChildren();
  }
  function renderTip() {
    const show = !(tipSeen || ui.open || mp.lobby || bridge.session);
    patch(tipLayer, show ? h('div', { class: 'tip', onClick: () => toggle(true) }, h('b', null, 'Race your friends!'), h('br'), 'Click MULTIPLAYER (or press F2) to create or join a lobby.') : null);
  }

  function toggle(v = !ui.open) {
    if (v !== ui.open) log.info(`panel ${v ? 'opened' : 'closed'}`);
    ui.open = v;
    if (v) markTipSeen();
    if (!v) { ui.view = 'main'; if (shadow.activeElement) shadow.activeElement.blur(); }
    if (ui.open && !mp.lobby) refreshLobbies();
    if (ui.open && ui.shortcut === null) tx.desktopShortcut?.(false).then((x) => { ui.shortcut = x; render(); }).catch(() => {});
    render();
  }

  function toast(text, kind) {
    // Errors from the main process arrive as "Error invoking remote method 'x': Error: ...".
    text = String(text).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
    if (kind === 'error') log.warn(`error shown: ${text}`);
    // Long messages (mostly errors that explain what to do) stay up long enough to read.
    const ms = Math.min(12000, Math.max(4000, text.length * 55));
    const t = h('div', { class: `toast ${kind || ''}`, style: `animation-duration: ${ms}ms` }, text);
    toasts.append(t);
    setTimeout(() => t.remove(), ms + 200);
    while (toasts.children.length > 4) toasts.firstChild.remove();
  }

  function copy(text, what) {
    try { tx.copyText(text); toast(`${what} copied`); } catch { toast('Could not copy', 'error'); }
  }

  // One action of each kind at a time (no double lobby creation), but a slow one, like a level
  // loading for practice, never blocks the rest of the panel. A click that has to wait says so
  // instead of silently doing nothing.
  const busyKeys = new Set();
  async function act(fn, key = 'main') {
    if (busyKeys.has(key)) { toast('Still working on that…'); return; }
    busyKeys.add(key); ui.busy = busyKeys.has('main'); render();
    try { await fn(); } catch (e) { toast(e.message || String(e), 'error'); } finally { busyKeys.delete(key); ui.busy = busyKeys.has('main'); render(); }
  }

  /** Leave the lobby. Never waits on other actions; with other players here it asks for a second click. */
  function leaveLobby() {
    if (!mp.lobby) return;
    if (mp.humans().length > 1 && !(ui.confirmLeaveUntil > performance.now())) {
      ui.confirmLeaveUntil = performance.now() + 4000;
      render();
      setTimeout(render, 4100);
      return;
    }
    ui.confirmLeaveUntil = 0;
    ui.view = 'main';
    mp.leave().then(() => toast('You left the lobby'), (e) => toast(e.message || String(e), 'error'));
  }

  function leaveButton() {
    const confirming = ui.confirmLeaveUntil > performance.now();
    return h('button', { class: 'btn ghost danger', title: 'Leave this lobby (the race carries on for everyone else)', onClick: leaveLobby }, confirming ? 'Click again to leave' : 'Leave lobby');
  }

  async function refreshLobbies() {
    ui.loadingLobbies = true; ui.lobbiesErr = null; render();
    try { ui.lobbies = await mp.list(); } catch (e) { ui.lobbiesErr = e.message; ui.lobbies = []; }
    ui.loadingLobbies = false; render();
  }

  async function loadFeatured() {
    if (ui.featured || ui.featuredErr === 'loading') return;
    ui.featuredErr = 'loading';
    try { ui.featured = await bridge.featuredLevels(); ui.featuredErr = null; } catch (e) { ui.featuredErr = e.message; }
    render();
  }

  async function loadPlayerLevels(page = 1) {
    const p = ui.player;
    const term = (ui.inputs.psearch || '').trim();
    if (p.mode !== 'all' && !term) { p.error = p.mode === 'name' ? 'Type part of a level name' : 'Type an author name'; render(); return; }
    p.loading = true; p.error = null; p.page = page; render();
    try {
      const r = await bridge.playerLevels({ mode: p.mode, sort: p.sort, uploaded: p.uploaded, page, term });
      p.results = r.levels; p.pages = r.pages;
      if (!r.levels.length) p.error = 'No levels found';
    } catch (e) { p.error = e.message; p.results = []; }
    p.loading = false;
    render();
  }

  // Maps made for multiplayer: their makers put HWMP in the level name (see the README).
  const MAP_GUIDE_URL = GUIDE_URL;
  async function loadMpMaps(page = 1) {
    const m = ui.mpmaps;
    m.loading = true; m.error = null; m.page = page; render();
    try {
      const r = await bridge.playerLevels({ mode: 'name', term: 'HWMP', sort: m.sort, uploaded: 'anytime', page });
      m.results = r.levels; m.pages = r.levels.length ? r.pages : 1;
      if (!r.levels.length) m.error = 'No multiplayer maps yet. Make the first one!';
    } catch (e) { m.error = e.message; m.results = []; }
    m.loading = false;
    render();
  }

  async function lookupId() {
    const id = Number((ui.inputs.lvid || '').trim());
    if (!Number.isInteger(id) || id < 1) { toast('Enter a numeric level ID', 'error'); return; }
    ui.idLookup = { loading: true, error: null }; render();
    try {
      const l = await bridge.levelById(id);
      ui.idLookup = { loading: false, error: l ? null : 'No level with that ID' };
      if (l) ui.selected = l;
    } catch (e) { ui.idLookup = { loading: false, error: e.message }; }
    render();
  }

  function avatarImg(id) {
    const img = h('img', { class: 'avatar', alt: '' });
    const cached = avatars.get(id);
    const apply = (a) => {
      if (!a) return;
      const c = document.createElement('canvas');
      c.width = a.width; c.height = a.height;
      const bytes = Uint8ClampedArray.from(atob(a.rgba), (ch) => ch.charCodeAt(0));
      c.getContext('2d').putImageData(new ImageData(bytes, a.width, a.height), 0, 0);
      const url = c.toDataURL();
      avatars.set(id, url);
      img.src = url;
      render();
    };
    if (typeof cached === 'string') img.src = cached;
    else if (!avatars.has(id)) { avatars.set(id, null); tx.avatar(id).then(apply).catch(() => {}); }
    return img;
  }

  /** Text box whose contents survive redraws. */
  function textBox(key, props = {}) {
    return h('input', {
      type: 'text', key, value: ui.inputs[key] || '', ...props,
      onInput: (e) => { ui.inputs[key] = e.target.value; if (props.onInput) props.onInput(e); },
    });
  }

  // Context for the views in extras.js / hud.js.
  const c = { mp, bridge, tx, ui, solo, h, render, toast, toggle, act, charName, charNames, textBox, header, fmtTime };

  function canSpectate() {
    const r = mp.race;
    if (!r) return false;
    return mp.phase === 'results' || r.finishes[mp.self.id] != null || r.deaths[mp.self.id] != null || !!bridge.spectating;
  }

  function cycleSpectate(dir) {
    const ids = [...bridge.puppets.keys()].filter((id) => id !== GHOST_ID);
    if (!ids.length) { toast('Nobody else to watch'); return; }
    const order = [null, ...ids];
    const i = order.indexOf(bridge.spectating);
    const next = order[(i + dir + order.length) % order.length];
    bridge.spectate(next);
  }

  function closeWhatsNew() {
    ui.whatsNew = false;
    mp.setPref('lastSeenVersion', tx.modVersion || '');
    render();
  }

  // ---- views ------------------------------------------------------------------------------------
  function header(title, back) {
    return h('header', null,
      back ? h('button', { class: 'btn ghost', onClick: back }, '← Back') : null,
      h('h1', null, title),
      h('div', { class: 'grow' }),
      !back && mp.lobby ? leaveButton() : null,
      back ? null : h('button', { class: 'icon', title: 'Your stats and personal bests', onClick: () => { ui.view = 'stats'; render(); } }, '📊'),
      back ? null : h('button', { class: 'icon', title: 'Settings and help', onClick: () => { ui.view = 'settings'; render(); } }, '⚙'),
      h('span', { class: 'ver', title: tx.edition === 'nexus' ? 'Nexus Mods edition: new versions are on the Nexus Mods page' : '' }, `v${tx.modVersion || '?'}${tx.edition === 'nexus' ? ' · Nexus' : ''}`),
      h('button', { class: 'close', title: 'Close (Esc)', onClick: () => toggle(false) }, '×'));
  }

  function browserView() {
    const joinByCode = () => {
      const id = parseCode(ui.inputs.code || '');
      if (!id) return toast('That lobby code does not look right', 'error');
      act(() => mp.join(id));
    };
    const type = h('select', { onChange: (e) => mp.setLobbyType(e.target.value) },
      h('option', { value: 'public', selected: mp.prefs.lobbyType === 'public' }, 'Listed (anyone can join)'),
      h('option', { value: 'friends', selected: mp.prefs.lobbyType === 'friends' }, 'Friends only (not listed)'),
      h('option', { value: 'private', selected: mp.prefs.lobbyType === 'private' }, 'Private (Steam invite only)'));
    const list = h('div', { class: 'list' });
    if (ui.loadingLobbies && !ui.lobbies) list.append(h('div', { class: 'empty' }, 'Looking for lobbies…'));
    else if (ui.lobbiesErr) list.append(h('div', { class: 'empty error' }, ui.lobbiesErr));
    else if (!ui.lobbies || !ui.lobbies.length) list.append(h('div', { class: 'empty' }, 'No open lobbies right now. Create one and invite your friends!'));
    else {
      for (const l of ui.lobbies) {
        const d = l.data || {};
        list.append(h('div', { class: 'lobby-item' },
          h('div', null,
            h('div', { class: 'name' }, d.name || 'Race lobby'),
            h('div', { class: 'small muted' }, `${d.level ? d.level : 'No level picked'} · ${d.phase === 'lobby' || !d.phase ? 'waiting' : 'racing, join in anytime'} · collisions ${d.collisions === '1' ? 'on' : 'off'}${d.game && d.game !== bridge.gameVersion() ? ` · game v${d.game}` : ''}`)),
          h('div', { class: 'small muted' }, `${l.members.length}${l.limit ? `/${l.limit}` : ''} players`),
          l.compatible
            ? h('button', { class: 'btn', disabled: ui.busy, onClick: () => act(() => mp.join(l.id)) }, 'Join')
            : tx.edition === 'nexus' && tx.nexusUrl
              ? h('div', { class: 'row', style: 'gap:6px' },
                h('span', { class: 'small error', title: `Lobby runs mod ${d.modVersion || '?'}` }, 'Other version'),
                h('button', { class: 'btn ghost small-btn', title: 'Players need the same version. New versions are on the Nexus Mods page.', onClick: () => tx.openExternal(tx.nexusUrl) }, 'Get update'))
              : h('span', { class: 'small error', title: `Lobby runs mod ${d.modVersion || '?'}` }, 'Other version')));
      }
    }
    return [
      header('Multiplayer'),
      h('div', { class: 'body stack' },
        soloCard(c),
        mp.self ? h('div', { class: 'muted' }, 'Signed in to Steam as ', h('b', null, mp.self.name)) : h('div', { class: 'error' }, 'Steam is not running. Start Steam, then restart Happy Wheels Multiplayer.'),
        h('div', { class: 'card stack' },
          h('h2', null, 'Host a race'),
          h('div', { class: 'row' },
            h('button', { class: 'btn pink big', disabled: ui.busy || !mp.self, onClick: () => act(() => mp.create()) }, 'Create lobby'),
            type)),
        h('div', { class: 'card stack' },
          h('div', { class: 'row between' }, h('h2', null, 'Join a race'),
            h('button', { class: 'btn ghost', disabled: ui.loadingLobbies, onClick: refreshLobbies }, ui.loadingLobbies ? 'Refreshing…' : 'Refresh')),
          h('div', { class: 'row' }, textBox('code', { placeholder: 'Lobby code', maxlength: 24, onEnter: joinByCode }),
            h('button', { class: 'btn', disabled: ui.busy, onClick: joinByCode }, 'Join by code')),
          list),
        h('div', { class: 'card stack' },
          h('h2', null, 'On your own'),
          h('div', { class: 'small muted' }, 'Practice any level against a ghost of your best run, or test a multiplayer map you are making.'),
          h('div', { class: 'row' },
            h('button', { class: 'btn', onClick: () => { ui.view = 'levels'; render(); } }, 'Practice a level…'),
            h('button', { class: 'btn ghost', onClick: () => { ui.view = 'maphelp'; render(); } }, 'Making multiplayer maps'))),
        h('div', { class: 'card stack' },
          h('h2', null, 'Starting the game'),
          h('div', { class: 'small muted' }, "Pressing Play on Happy Wheels in Steam opens Multiplayer once the launcher has set it up (it asks the first time). You can also start it from a desktop shortcut."),
          h('div', { class: 'row' },
            ui.shortcut
              ? h('span', { class: 'small muted' }, '✓ Desktop shortcut is set up')
              : h('button', { class: 'btn ghost', onClick: async () => { ui.shortcut = await tx.desktopShortcut(true).catch(() => false); toast(ui.shortcut ? 'Desktop shortcut created' : 'Could not create the shortcut', ui.shortcut ? 'info' : 'error'); render(); } }, 'Create desktop shortcut'),
            h('button', { class: 'btn ghost', title: 'For setting it up by hand: Steam → Happy Wheels → Properties → Launch Options', onClick: async () => {
              const opt = await tx.steamLaunchOption().catch(() => null);
              if (opt) copy(opt, 'Steam launch option');
            } }, 'Copy Steam launch option'))),
        h('div', { class: 'small muted' }, 'Unofficial fan-made mod. Not affiliated with Fancy Force or Total Jerkface.')),
    ];
  }

  /** Skip / end / vote controls for a race in progress. */
  function raceControls() {
    const race = mp.race;
    if (!race || !['loading', 'countdown', 'racing'].includes(mp.phase)) return null;
    if (mp.isHost) {
      return [
        h('button', { class: 'btn', onClick: () => act(async () => { const p = await mp.skipLevel(); if (p) { toast(`Next up: ${p.name}`); toggle(false); } }) }, 'Skip to a random level'),
        h('button', { class: 'btn ghost', onClick: () => { mp.endRaceNow(); toggle(false); } }, 'End race now'),
        h('button', { class: 'btn ghost', title: 'Everyone leaves the level and goes back to the lobby', onClick: () => mp.backToLobby() }, 'Back to lobby (everyone)'),
      ];
    }
    const voted = race.skipVotes.has(mp.self.id);
    return [h('button', { class: 'btn', disabled: voted, onClick: () => mp.voteSkip() },
      voted ? `Voted to skip (${race.skipVotes.size}/${mp.skipVotesNeeded()})` : `Vote to skip level (${race.skipVotes.size}/${mp.skipVotesNeeded()})`)];
  }

  function botRow(p) {
    const statusText = {
      lobby: '', loading: 'finding a run…', ready: 'at the start line', racing: 'racing',
      finished: `finished ${fmtTime(p.finishMs)}`, dnf: 'did not finish', spectating: 'watching',
    }[p.status] ?? p.status;
    const editable = mp.isHost && (mp.phase === 'lobby' || mp.phase === 'results');
    const d = p.bot.difficulty;
    return h('div', { class: 'player bot' },
      h('div', { class: 'avatar ai' }, 'AI'),
      h('div', null,
        h('div', null, p.name, h('span', { class: 'badge ai' }, 'AI')),
        h('div', { class: 'status', title: d === 'mine' ? "Drives the host's best run on this level" : 'AI racers drive real runs other players uploaded for this level' },
          p.runBy && d === 'mine' ? `${charName(p.character)} · ${mp.isHost ? 'your' : `${p.runBy}'s`} best run`
            : p.runBy ? `${charName(p.character)} · run by ${p.runBy}`
            : p.prep === 'searching' ? 'finding a run…'
              : p.prep === 'none' ? (d === 'mine' ? (mp.isHost ? "you haven't finished this level yet" : 'the host has no run on this level') : 'no run for this level')
                : `${DIFFICULTY_NAMES[d]} difficulty`)),
      editable
        ? h('div', { class: 'row' },
          h('select', { title: 'Difficulty', onChange: (e) => mp.setBotDifficulty(p.id, e.target.value) },
            DIFFICULTIES.map((x) => h('option', { value: x, selected: x === d }, DIFFICULTY_NAMES[x]))),
          h('button', { class: 'btn ghost small-btn', title: 'Remove this AI racer', onClick: () => mp.removeBot(p.id) }, '×'))
        : h('div', { class: 'status' }, statusText));
  }

  /** Host: add AI racers (they race real uploaded runs of the level). */
  function botAdder() {
    if (!mp.isHost) return null;
    const count = mp.botPlayers().length;
    const idle = mp.phase === 'lobby' || mp.phase === 'results';
    const pick = DIFFICULTIES.includes(ui.botDifficulty) ? ui.botDifficulty : (mp.prefs.botDifficulty || 'medium');
    return h('div', { class: 'row', title: 'AI racers drive real runs other players uploaded for the level, checked to reach the finish' },
      h('button', { class: 'btn', disabled: !idle || count >= MAX_BOTS, onClick: () => mp.addBot(pick) }, 'Add AI racer'),
      h('select', { onChange: (e) => { ui.botDifficulty = e.target.value; } },
        DIFFICULTIES.map((x) => h('option', { value: x, selected: x === pick }, DIFFICULTY_NAMES[x]))),
      !idle ? h('span', { class: 'small muted' }, 'after this race') : null);
  }

  function playerRow(p) {
    if (p.bot) return botRow(p);
    const isHost = p.id === mp.hostId;
    const statusText = {
      lobby: p.ready || isHost ? '' : 'not ready', loading: 'loading…', ready: 'at the start line', racing: 'racing',
      finished: `finished ${fmtTime(p.finishMs)}`, dnf: 'did not finish', spectating: 'watching', dead: 'out',
    }[p.status] ?? p.status;
    const actions = hostActions(c, p);
    return h('div', { class: 'player' },
      avatarImg(p.id),
      h('div', null,
        h('div', null, p.name, isHost ? h('span', { class: 'badge host' }, 'HOST') : null,
          p.status === 'lobby' && p.ready && !isHost ? h('span', { class: 'badge ready' }, 'READY') : null,
          p.id === mp.self.id ? h('span', { class: 'badge' }, 'you') : null,
          p.gameVersion && p.gameVersion !== bridge.gameVersion() ? h('span', { class: 'badge', title: 'Their Happy Wheels version differs from yours; physics may not match. Update the game in Steam.' }, `game v${p.gameVersion}`) : null),
        h('div', { class: 'status' }, charName(p.character))),
      actions && ui.menuFor === p.id ? actions : h('div', { class: 'row', style: 'gap:6px' }, h('div', { class: 'status' }, statusText), actions));
  }

  /** Lobby members we haven't heard from yet (still connecting). */
  function pendingRow(id) {
    return h('div', { class: 'player pending', title: 'Waiting for their game to answer. This usually takes a few seconds.' },
      avatarImg(id),
      h('div', null, h('div', null, `Player …${id.slice(-4)}`, id === mp.hostId ? h('span', { class: 'badge host' }, 'HOST') : null), h('div', { class: 'status' }, 'connecting…')),
      h('div', { class: 'status' }, ''));
  }

  function levelSummary(lvl, editable) {
    if (!lvl) {
      return h('div', { class: 'card stack' }, h('div', { class: 'label' }, 'Level'),
        h('div', { class: 'muted' }, editable ? 'No level picked yet.' : 'The host has not picked a level yet.'),
        editable ? h('div', { class: 'row' },
          h('button', { class: 'btn', onClick: () => { ui.view = 'levels'; render(); } }, 'Choose level…'),
          h('button', { class: 'btn ghost', onClick: () => act(async () => { const p = await mp.randomLevel(); if (p) toast(`Picked ${p.name}`); }) }, 'Random')) : null);
    }
    return h('div', { class: 'card stack' },
      h('div', { class: 'label' }, 'Level'),
      h('div', null, h('b', null, lvl.name), h('span', { class: 'small muted' }, `  #${lvl.id}`)),
      h('div', { class: 'small muted' }, [lvl.author ? `by ${lvl.author}` : null, lvl.forceChar ? charName(lvl.character) : 'any character'].filter(Boolean).join(' · ')),
      editable ? h('div', { class: 'row' },
        h('button', { class: 'btn', onClick: () => { ui.view = 'levels'; render(); } }, 'Change level…'),
        h('button', { class: 'btn ghost', title: 'A featured level this lobby has not raced yet', onClick: () => act(async () => { const p = await mp.randomLevel(); if (p) toast(`Picked ${p.name}`); }) }, 'Random')) : null);
  }

  function lobbyView() {
    const me = mp.players.get(mp.self.id);
    const hostMode = mp.isHost;
    const lvl = mp.settings.level;
    const inRace = ['loading', 'countdown', 'racing'].includes(mp.phase);
    const charLocked = (lvl && lvl.forceChar) || mp.settings.forceCharacter;

    const pending = mp.lobby.members.filter((id) => !mp.players.has(id));
    const everyone = [...mp.players.values()];
    const players = h('div', { class: 'list' }, everyone.filter((p) => !p.bot).map(playerRow), pending.map(pendingRow), everyone.filter((p) => p.bot).map(playerRow));
    const sendChat = () => { mp.sendChat(ui.inputs.chat || ''); ui.inputs.chat = ''; render(); };
    const chatLog = h('div', { class: 'chat-log', key: 'chatlog' },
      mp.chat.length ? mp.chat.map((c) => h('div', null, h('span', { class: 'who' }, c.name), c.text)) : h('div', { class: 'muted small' }, 'No messages yet. Say hi!'));

    const charSel = h('select', { disabled: !!charLocked || inRace, onChange: (e) => mp.setCharacter(Number(e.target.value)) },
      charNames().map((n, i) => h('option', { value: i + 1, selected: mp.prefs.character === i + 1 }, n)));

    const settings = rulesCard(c, hostMode, inRace);
    let action;
    const joinButton = () => h('button', { class: 'btn green big', onClick: () => { mp.joinRace(); toggle(false); } },
      mp.race.participants.includes(mp.self.id) ? 'Rejoin race' : 'Join race in progress');
    if (mp.canJoinRace()) {
      action = joinButton();
    } else if (hostMode) {
      if (inRace) action = h('button', { class: 'btn big', disabled: true }, 'Race in progress');
      else {
        const guests = [...mp.players.values()].filter((p) => p.id !== mp.self.id && !p.bot);
        const ready = guests.filter((p) => p.ready).length;
        action = h('div', { class: 'stack', style: 'align-items:flex-end; gap:4px' },
          h('button', { class: 'btn green big', disabled: !lvl, onClick: () => { mp.startRace(); toggle(false); } }, mp.phase === 'results' ? 'Start next race' : 'Start race'),
          guests.length ? h('span', { class: 'small muted' }, `${ready} of ${guests.length} ready`) : null);
      }
    } else if (inRace || mp.phase === 'spectating') {
      action = h('button', { class: 'btn big', disabled: true }, mp.phase === 'spectating' ? 'Race in progress — next one soon' : 'Race in progress');
    } else {
      action = h('button', { class: `btn big ${me && me.ready ? 'ghost' : 'green'}`, onClick: () => mp.setReady(!(me && me.ready)) }, me && me.ready ? 'Not ready' : "I'm ready");
    }
    const controls = raceControls();

    return [
      header(mp.settings.name || 'Race lobby'),
      h('div', { class: 'body', key: 'lobbybody' },
        soloCard(c),
        h('div', { class: 'cols' },
          h('div', { class: 'stack' },
            h('div', { class: 'card stack' },
              h('div', { class: 'row between' }, h('div', { class: 'row', style: 'gap:8px' }, h('div', { class: 'label', style: 'margin:0' }, `Players (${mp.lobby.members.length}${mp.botPlayers().length ? ` + ${mp.botPlayers().length} AI` : ''})`), lockToggle(c)),
                h('div', { class: 'row' },
                  h('span', { class: 'small muted' }, 'Code'), h('span', { class: 'code' }, lobbyCode(mp.lobby.id)),
                  h('button', { class: 'btn ghost', onClick: () => copy(lobbyCode(mp.lobby.id), 'Lobby code') }, 'Copy'))),
              players,
              mp.botPlayers().length && mp.effectiveRules().aiReason ? h('div', { class: 'small warn' }, `AI racers sit this one out: ${mp.effectiveRules().aiReason}.`) : null,
              botAdder(),
              h('div', { class: 'row' },
                h('button', { class: 'btn', onClick: () => { mp.invite(); toast('If the Steam invite window does not open, send your friends the lobby code instead.'); } }, 'Invite Steam friends'))),
            h('div', { class: 'card stack' }, h('div', { class: 'label' }, 'Chat'), chatLog,
              h('div', { class: 'row' },
                textBox('chat', { placeholder: 'Say something… (Enter to send)', maxlength: 200, style: 'flex:1', onEnter: sendChat }),
                h('button', { class: 'btn', onClick: sendChat }, 'Send')))),
          h('div', { class: 'stack' },
            h('div', { class: 'card row between' },
              h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Your character'), charSel),
              action),
            controls ? h('div', { class: 'card row' }, h('span', { class: 'small muted' }, 'Tired of this level?'), controls) : null,
            voteCard(c),
            levelSummary(lvl, hostMode && !inRace),
            mapCard(c),
            settings,
            cupCard(c),
            boardCard(c),
            hostMode && mp.phase === 'results' ? h('button', { class: 'btn ghost', title: 'Everyone leaves the level and goes back to the lobby', onClick: () => mp.backToLobby() }, 'Back to lobby (everyone)') : null))),
    ];
  }

  // ---- level browser (host) -------------------------------------------------------------------
  function levelRow(l) {
    const raced = mp.playedLevels.has(l.id);
    return h('button', { class: `lvrow ${ui.selected && ui.selected.id === l.id ? 'sel' : ''}`, onClick: () => { ui.selected = l; render(); } },
      h('span', { class: 'n' }, l.name, raced ? h('span', { class: 'raced' }, '  ✓ raced') : null),
      h('span', { class: 'r' }, stars(l.rating)),
      h('span', { class: 'm' }, [l.author, l.forceChar ? charName(l.character) : 'any character'].filter(Boolean).join(' · ')),
      h('span', { class: 'm', style: 'text-align:right' }, l.plays ? `${fmtNum(l.plays)} plays` : ''));
  }

  function detailsPane() {
    const l = ui.selected;
    if (!l) return h('div', { class: 'card details' }, h('div', { class: 'muted' }, 'Pick a level from the list to see its details.'));
    const idle = mp.phase === 'lobby' || mp.phase === 'results' || mp.phase === 'idle';
    const use = (start) => {
      mp.setLevel(l);
      ui.view = 'main';
      if (start && idle) { mp.startRace(); toggle(false); } else render();
      toast(`Level set: ${l.name}`);
    };
    return h('div', { class: 'card details stack' },
      h('h3', null, l.name),
      h('div', { class: 'small muted' }, `by ${l.author || 'unknown'} · #${l.id}`),
      h('div', { class: 'stat' },
        l.rating ? h('span', null, h('b', null, l.rating.toFixed(1)), ` ★ (${fmtNum(l.votes)} votes)`) : null,
        l.plays ? h('span', null, h('b', null, fmtNum(l.plays)), ' plays') : null,
        h('span', null, l.forceChar ? `Character: ${charName(l.character)}` : 'Any character'),
        mp.playedLevels.has(l.id) ? h('span', { class: 'raced' }, '✓ raced in this lobby') : null),
      l.comments ? h('div', { class: 'desc' }, l.comments) : null,
      mp.lobby && mp.isHost ? h('div', { class: 'row' },
        h('button', { class: 'btn green', onClick: () => use(idle) }, idle ? 'Race it now' : 'Use this level'),
        idle ? h('button', { class: 'btn ghost', onClick: () => use(false) }, 'Set, start later') : null) : null,
      detailsExtras(c, l));
  }

  function levelsView() {
    const tabs = h('div', { class: 'tabs' },
      [['featured', 'Featured'], ['player', 'Player levels'], ['mpmaps', 'Multiplayer maps'], ['id', 'Level ID']].map(([id, label]) =>
        h('button', { class: `tab ${ui.levelTab === id ? 'on' : ''}`, onClick: () => {
          ui.levelTab = id; render();
          if (id === 'player' && !ui.player.results && !ui.player.loading) loadPlayerLevels(1);
          if (id === 'mpmaps' && !ui.mpmaps.results && !ui.mpmaps.loading) loadMpMaps(1);
        } }, label)));
    let content;
    if (ui.levelTab === 'featured') {
      loadFeatured();
      const f = (ui.inputs.fsearch || '').toLowerCase();
      const list = h('div', { class: 'lvlist', key: 'featuredlist' });
      if (ui.featuredErr === 'loading') list.append(h('div', { class: 'muted small' }, 'Loading featured levels…'));
      else if (ui.featuredErr) list.append(h('div', { class: 'error small' }, `Could not load featured levels: ${ui.featuredErr}`), h('button', { class: 'btn ghost', onClick: () => { ui.featuredErr = null; loadFeatured(); } }, 'Try again'));
      else {
        const items = (ui.featured || []).filter((l) => (!f || l.name.toLowerCase().includes(f) || l.author.toLowerCase().includes(f) || String(l.id) === f)
          && (!ui.featuredChar || (ui.featuredChar === -1 ? !l.forceChar : l.character === ui.featuredChar)));
        list.append(...items.map(levelRow));
        if (!items.length) list.append(h('div', { class: 'muted small' }, 'No matches'));
      }
      content = [
        h('div', { class: 'controls' },
          textBox('fsearch', { placeholder: 'Search featured levels by name or author', onInput: () => render() }),
          h('select', { onChange: (e) => { ui.featuredChar = Number(e.target.value); render(); } },
            h('option', { value: 0, selected: ui.featuredChar === 0 }, 'Any character'),
            h('option', { value: -1, selected: ui.featuredChar === -1 }, 'Players choose'),
            charNames().map((n, i) => h('option', { value: i + 1, selected: ui.featuredChar === i + 1 }, n))),
          h('button', { class: 'btn ghost', onClick: () => act(async () => { const p = await mp.randomLevel(); if (p) { ui.selected = p; toast(`Picked ${p.name}`); } }) }, 'Random')),
        h('div', { class: 'browser' }, list, detailsPane()),
      ];
    } else if (ui.levelTab === 'player') {
      const p = ui.player;
      const list = h('div', { class: 'lvlist', key: `playerlist-${p.page}` });
      if (p.loading) list.append(h('div', { class: 'muted small' }, 'Loading levels…'));
      else if (p.error) list.append(h('div', { class: 'muted small' }, p.error));
      else if (p.results) list.append(...p.results.map(levelRow));
      const search = () => loadPlayerLevels(1);
      content = [
        h('div', { class: 'controls' },
          h('select', { onChange: (e) => { p.mode = e.target.value; render(); } },
            h('option', { value: 'all', selected: p.mode === 'all' }, 'Browse all'),
            h('option', { value: 'name', selected: p.mode === 'name' }, 'Level name'),
            h('option', { value: 'author', selected: p.mode === 'author' }, 'Author')),
          p.mode !== 'all' ? textBox('psearch', { placeholder: p.mode === 'name' ? 'Level name contains…' : 'Author name…', onEnter: search }) : null,
          h('select', { onChange: (e) => { p.sort = e.target.value; search(); } },
            [['rating', 'Top rated'], ['plays', 'Most played'], ['newest', 'Newest'], ['oldest', 'Oldest']].map(([v, t]) => h('option', { value: v, selected: p.sort === v }, t))),
          p.mode === 'all' ? h('select', { onChange: (e) => { p.uploaded = e.target.value; search(); } },
            [['anytime', 'All time'], ['month', 'This month'], ['week', 'This week'], ['today', 'Today']].map(([v, t]) => h('option', { value: v, selected: p.uploaded === v }, t))) : null,
          h('button', { class: 'btn', disabled: p.loading, onClick: search }, 'Search')),
        h('div', { class: 'browser' },
          h('div', null, list,
            h('div', { class: 'pager' },
              h('button', { class: 'btn ghost', disabled: p.loading || p.page <= 1, onClick: () => loadPlayerLevels(p.page - 1) }, '← Previous'),
              h('span', null, p.results ? `Page ${p.page}${p.pages > 1 ? ` of ${p.pages}` : ''} · ${p.results.length} levels` : ''),
              h('button', { class: 'btn ghost', disabled: p.loading || p.page >= p.pages, onClick: () => loadPlayerLevels(p.page + 1) }, 'Next →'))),
          detailsPane()),
      ];
    } else if (ui.levelTab === 'mpmaps') {
      const m = ui.mpmaps;
      const list = h('div', { class: 'lvlist', key: `mpmaps-${m.page}` });
      if (m.loading) list.append(h('div', { class: 'muted small' }, 'Loading multiplayer maps…'));
      else if (m.error) list.append(h('div', { class: 'muted small' }, m.error));
      else if (m.results) list.append(...m.results.map(levelRow));
      content = [
        h('div', { class: 'controls' },
          h('span', { class: 'small muted', style: 'flex:1' }, 'Levels made for racing: start positions, checkpoints and more. Map makers put HWMP in the level name.'),
          h('select', { onChange: (e) => { m.sort = e.target.value; loadMpMaps(1); } },
            [['rating', 'Top rated'], ['plays', 'Most played'], ['newest', 'Newest']].map(([v, t]) => h('option', { value: v, selected: m.sort === v }, t))),
          h('button', { class: 'btn ghost', title: 'How to make a multiplayer map (opens the guide in your browser)', onClick: () => tx.openExternal(MAP_GUIDE_URL) }, 'Make one')),
        h('div', { class: 'browser' },
          h('div', null, list,
            h('div', { class: 'pager' },
              h('button', { class: 'btn ghost', disabled: m.loading || m.page <= 1, onClick: () => loadMpMaps(m.page - 1) }, '← Previous'),
              h('span', null, m.results && m.results.length ? `Page ${m.page}${m.pages > 1 ? ` of ${m.pages}` : ''}` : ''),
              h('button', { class: 'btn ghost', disabled: m.loading || m.page >= m.pages, onClick: () => loadMpMaps(m.page + 1) }, 'Next →'))),
          detailsPane()),
      ];
    } else {
      content = [
        h('div', { class: 'controls' },
          textBox('lvid', { placeholder: 'Level ID (the number in a level link)', maxlength: 12, onEnter: lookupId }),
          h('button', { class: 'btn', disabled: ui.idLookup.loading, onClick: lookupId }, ui.idLookup.loading ? 'Looking up…' : 'Look up')),
        ui.idLookup.error ? h('div', { class: 'error small' }, ui.idLookup.error) : null,
        detailsPane(),
      ];
    }
    return [
      header('Choose a level', () => { ui.view = 'main'; render(); }),
      h('div', { class: 'body', key: 'levelsbody' }, tabs, content),
    ];
  }

  // ---- redraw -----------------------------------------------------------------------------------
  let lastPanelHtml = '';
  function render() {
    // results modal (interactive, so only rebuilt on state changes)
    if (mp.phase !== 'results') ui.resultsHidden = false;
    patch(resultsLayer, mp.race && mp.phase === 'results' && !ui.resultsHidden && !ui.open && bridge.session && bridge.raceMode ? results(mp.race) : null);

    renderTip();
    const notes = ui.whatsNew ? CHANGELOG : [];
    patch(modalLayer, notes.length ? whatsNewModal(c, notes, closeWhatsNew) : null);

    // While the game's own pause menu is open in a lobby race, offer skipping the level and leaving.
    const paused = !!(bridge.session && bridge.session.paused);
    const inLobbyLevel = !!(mp.lobby && mp.race && bridge.raceMode && !(solo && solo.active));
    const controls = paused && !ui.open && inLobbyLevel ? raceControls() : null;
    patch(raceMenuLayer, paused && !ui.open && inLobbyLevel
      ? h('div', { class: 'race-menu' }, controls ? [h('span', { class: 't' }, 'Stuck on this level?'), ...controls] : null, leaveButton())
      : null);

    // pill
    const inLobby = !!mp.lobby;
    pill.classList.toggle('live', inLobby);
    pill.classList.toggle('compact', !!bridge.session);
    pill.hidden = ui.open; // the panel has its own close button
    patch(pill, h('span', { class: 'dot' }), 'MULTIPLAYER', inLobby ? h('span', { class: 'sub' }, `${mp.lobby.members.length} in lobby`) : null);

    if (!ui.open) { patch(panelLayer); lastPanelHtml = ''; return; }
    if (ui.view === 'levels' && inLobby && !mp.isHost) ui.view = 'main';
    const view = { levels: levelsView, settings: () => settingsView(c), stats: () => statsView(c), maphelp: () => mapHelpView(c) }[ui.view];
    const panel = h('div', { class: 'panel' }, view ? view() : inLobby ? lobbyView() : browserView());
    const html = panel.outerHTML;
    if (html === lastPanelHtml) return; // nothing visible changed: keep the live DOM (hover, scroll, focus)
    lastPanelHtml = html;

    // Update the panel in place, carrying over scroll positions and the focused text box for any
    // part that had to be rebuilt.
    const scrollers = new Map();
    for (const el of panelLayer.querySelectorAll('[data-key]')) scrollers.set(el.dataset.key, { top: el.scrollTop, atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 4 });
    const focused = activeInput();
    const focus = focused && focused.dataset.key ? { key: focused.dataset.key, start: focused.selectionStart, end: focused.selectionEnd } : null;
    patch(panelLayer, h('div', { class: 'scrim', onClick: () => toggle(false) }), panel);
    for (const el of panelLayer.querySelectorAll('[data-key]')) {
      const s = scrollers.get(el.dataset.key);
      if (el.dataset.key === 'chatlog' && (!s || s.atBottom)) el.scrollTop = el.scrollHeight;
      else if (s) el.scrollTop = s.top;
    }
    if (focus) {
      const el = panelLayer.querySelector(`[data-key="${focus.key}"]`);
      if (el && el !== activeInput()) { el.focus(); try { el.setSelectionRange(focus.start, focus.end); } catch {} }
    }
  }

  // ---- HUD (runs every animation frame) --------------------------------------------------------
  const tagEls = new Map();
  let lastHud = 0;
  let lastInSession = false;
  let lastPaused = false;
  function hudFrame(ts) {
    requestAnimationFrame(hudFrame);
    updateTags();
    if (ts - lastHud < 50) return; // text HUD at 20 Hz
    lastHud = ts;
    // Entering/leaving a level moves the MULTIPLAYER button and hides the first-run tip.
    const inSession = !!bridge.session;
    const paused = !!(bridge.session && bridge.session.paused);
    if (inSession !== lastInSession || paused !== lastPaused) { lastInSession = inSession; lastPaused = paused; render(); }
    const race = mp.race;
    hud.replaceChildren();
    if (race && mp.lobby && bridge.raceMode && (bridge.session || bridge.pendingLoad)) {
      const now = mp.clock.now();
      const participating = race.participants.includes(mp.self.id);
      if (mp.phase === 'loading' && participating) {
        const waiting = race.participants.filter((id) => mp.players.get(id)?.status === 'loading').length;
        hud.append(h('div', { class: 'countdown wait' }, bridge.session ? `Waiting for ${waiting} player${waiting === 1 ? '' : 's'}…` : 'Loading level…'));
      } else if (race.goAt != null && now < race.goAt) {
        const left = Math.ceil((race.goAt - now) / 1000);
        if (left <= 3) hud.append(h('div', { class: 'countdown' }, String(left)));
        else hud.append(h('div', { class: 'countdown wait' }, 'Get ready…'));
      } else if (race.goAt != null && now - race.goAt < 900 && mp.phase === 'racing') {
        hud.append(h('div', { class: 'countdown go' }, 'GO!'));
      }
      if (race.goAt != null && now >= race.goAt && bridge.session) {
        const mine = race.finishes[mp.self.id];
        const died = race.deaths[mp.self.id];
        hud.append(h('div', { class: 'timer' }, fmtTime(mine != null ? mine : died != null ? died : now - race.goAt)));
        hud.append(...raceExtras(c, race));
        const dl = deadlineHint(c, race);
        if (dl) hud.append(dl);
        const r = bridge.restartMode;
        const restart = r === 'off' ? 'No restarts' : bridge.checkpoint && r === 'checkpoint' ? 'R: back to checkpoint' : 'R: restart';
        const done = canSpectate() && bridge.puppets.size ? '  ·  Tab: watch others' : '';
        const chat = mp.prefs.emoteKeys ? '  ·  1-6: quick chat' : '';
        hud.append(h('div', { class: 'hint' }, `${restart}  ·  Esc: pause / skip  ·  F2: lobby${done}${chat}`));
      }
      hud.append(standings(race));
    } else if (solo && solo.active && bridge.session) {
      hud.append(...soloHud(c));
      if (solo.test) hud.append(testPanel(c));
    }
    hud.style.setProperty('--hud', String(mp.prefs.hudScale || 1));
  }

  function standings(race) {
    const survival = race.rules.mode === 'survival';
    const rows = rankRace(race).filter((r) => mp.players.has(r.id));
    return h('div', { class: 'standings' }, rows.map((r) => {
      const p = mp.players.get(r.id);
      const text = r.ms != null ? fmtTime(r.ms)
        : survival && r.dead ? `out ${fmtTime(r.deadMs)}`
          : r.dnf ? 'DNF' : p.status === 'loading' ? '…' : r.progress > 0 ? progressText(r.progress) : '';
      return h('div', { class: `st ${survival && r.dead ? 'out' : ''} ${bridge.spectating === r.id ? 'watched' : ''}` },
        h('span', { class: 'pos' }, r.ms != null || (survival && r.dead) ? `${r.place}.` : '·'),
        h('span', { class: r.id === mp.self.id ? 'me' : '' }, p.name),
        h('span', { class: 'muted' }, text));
    }));
  }

  /** A racer's result text: time, survival, or how far they got. */
  function resultText(r, race) {
    if (r.ms != null) return fmtTime(r.ms);
    if (race.rules.mode === 'survival') return r.dead ? `out at ${fmtTime(r.deadMs)}` : r.dnf ? 'left' : 'survived';
    if (r.dnf) return 'DNF';
    return r.progress > 0 ? progressText(r.progress) : 'DNF';
  }

  function progressText(p) {
    const info = bridge.courseInfo();
    if (info.laps > 1 && info.total) {
      const lap = Math.floor(p / (info.total + 1)) + 1;
      return `lap ${lap}, ${p % (info.total + 1)} checkpoint${p % (info.total + 1) === 1 ? '' : 's'}`;
    }
    return `${p} checkpoint${p === 1 ? '' : 's'}`;
  }

  function results(race) {
    const rows = rankRace(race).filter((r) => mp.players.has(r.id));
    const cup = mp.settings.cup;
    const cupRace = race.cupIndex >= 0 && (cup.active || cup.done);
    const lastCupRace = cupRace && race.cupIndex + 1 >= cup.levels.length;
    return h('div', { class: 'results' },
      h('h1', null, race.rules.mode === 'survival' ? 'Survival results' : 'Results'),
      cupRace ? h('div', { class: 'small muted', style: 'text-align:center; margin:-6px 0 8px' }, `Cup race ${race.cupIndex + 1} of ${cup.levels.length}`) : null,
      rows.map((r) => h('div', { class: `r ${r.place === 1 ? 'first' : ''} ${r.id === mp.self.id ? 'mine' : ''}` },
        h('span', { class: 'p' }, r.place ? String(r.place) : '-'),
        h('span', null, mp.players.get(r.id).name),
        h('span', null, resultText(r, race)))),
      voteCard(c),
      h('div', { class: 'row between', style: 'margin-top: 14px' },
        h('button', { class: 'btn ghost', onClick: () => { ui.resultsHidden = true; render(); } }, 'Keep driving'),
        mp.isHost
          ? (cup.active && cupRace && !lastCupRace
            ? h('div', { class: 'row' },
              h('button', { class: 'btn ghost', onClick: () => { ui.resultsHidden = true; toggle(true); } }, 'Cup standings'),
              h('button', { class: 'btn green', disabled: cup.scored !== cup.index, onClick: () => mp.cupNext() }, `Next race (${cup.index + 2}/${cup.levels.length})`))
            : mp.settings.vote ? h('span', { class: 'small muted' }, 'Voting…')
              : h('div', { class: 'row' },
                h('button', { class: 'btn ghost', onClick: () => { ui.resultsHidden = true; ui.view = 'levels'; toggle(true); } }, 'Choose level'),
                h('button', { class: 'btn ghost', title: 'Everyone votes between three random levels', onClick: () => mp.voteStart().catch((e) => toast(e.message, 'error')) }, 'Vote'),
                h('button', { class: 'btn', onClick: () => act(async () => {
                  const pick = await mp.randomLevel({ start: true });
                  if (pick) toast(`Next up: ${pick.name}`);
                }) }, 'Random'),
                h('button', { class: 'btn green', onClick: () => mp.startRace() }, 'Race again')))
          : h('span', { class: 'small muted' }, mp.settings.vote ? 'Vote for the next level!' : 'Waiting for the host…')),
      lastCupRace && cup.done ? h('div', { class: 'winner', style: 'margin-top:10px' }, `🏆 ${cupWinnerText(cup)}`) : null);
  }

  /** Screen position (CSS pixels) of a point in level pixels, or null if the level isn't drawn. */
  function projector(s) {
    const renderer = hookRenderer();
    const view = renderer && renderer.view;
    const cont = s && s.containerSprite && s.containerSprite._pixiSprite;
    if (!view || !cont || !cont.worldTransform) return null;
    const rect = view.getBoundingClientRect();
    const sx = rect.width / renderer.screen.width;
    const sy = rect.height / renderer.screen.height;
    const wt = cont.worldTransform;
    const project = (x, y) => { const g = wt.apply({ x, y }); return { x: rect.left + g.x * sx, y: rect.top + g.y * sy }; };
    const scale = (s.level && s.level.m_physScale) || s.m_physScale || 30;
    return { project, pxPerMeter: scale * Math.abs(wt.a) * sx };
  }

  const markerEls = new Map();
  function updateMarkers() {
    const s = bridge.session;
    const test = !!(solo && solo.active && solo.test);
    const show = s && bridge.raceMode && (test || mp.prefs.markers);
    const tags = show ? bridge.mapTags() : null;
    const proj = tags ? projector(s) : null;
    const course = { ...bridge.courseInfo(), reachedSet: bridge.course.reached };
    drawMarkers(markers, markerEls, proj ? proj.project : () => null, proj ? proj.pxPerMeter : 0, proj ? tags : null, course, test);
  }

  function bubbleFor(id) {
    const b = ui.bubbles.get(id);
    if (!b) return null;
    if (performance.now() > b.until) { ui.bubbles.delete(id); return null; }
    return b.text;
  }

  let selfBubble = null;
  function updateTags() {
    updateMarkers();
    const s = bridge.session;
    const seen = new Set();
    // Our own quick-chat bubble, above our head.
    const mine = mp.self && bubbleFor(mp.self.id);
    const ch = s && s.character;
    const head = mine && ch && (ch.head1Body || ch.chestBody);
    const proj = head ? projector(s) : null;
    if (proj) {
      const scale = (s.level && s.level.m_physScale) || s.m_physScale || 30;
      const p = head.m_xf.position;
      const at = proj.project(p.x * scale, p.y * scale);
      if (!selfBubble) { selfBubble = h('div', { class: 'tag selfbubble' }); tags.append(selfBubble); }
      selfBubble.textContent = mine;
      selfBubble.style.left = `${at.x}px`; selfBubble.style.top = `${at.y - 30}px`;
    } else if (selfBubble) { selfBubble.remove(); selfBubble = null; }
    if (s && bridge.puppets.size && (mp.prefs.nameTags || ui.bubbles.size)) {
      const renderer = hookRenderer();
      const view = renderer && renderer.view;
      const cont = s.containerSprite && s.containerSprite._pixiSprite;
      if (view && cont && cont.worldTransform) {
        const rect = view.getBoundingClientRect();
        const sx = rect.width / renderer.screen.width;
        const sy = rect.height / renderer.screen.height;
        for (const [id, p] of bridge.puppets) {
          const w = p.headWorldPos();
          if (!w) continue;
          const g = cont.worldTransform.apply({ x: w.x, y: w.y });
          let x = rect.left + g.x * sx;
          let y = rect.top + g.y * sy - 28;
          const off = x < 8 || y < 8 || x > innerWidth - 8 || y > innerHeight - 8;
          x = Math.max(60, Math.min(innerWidth - 60, x));
          y = Math.max(24, Math.min(innerHeight - 8, y));
          let el = tagEls.get(id);
          if (!el) { el = h('div', { class: 'tag' }); tagEls.set(id, el); tags.append(el); }
          const bubble = bubbleFor(id);
          if (!mp.prefs.nameTags && !bubble) continue;
          const name = id === GHOST_ID ? 'Your best' : mp.players.get(id)?.name || 'Player';
          const text = bubble ? `${name}: ${bubble}` : name;
          if (el.textContent !== text) el.textContent = text;
          el.classList.toggle('edge', off);
          el.classList.toggle('bubble', !!bubble);
          el.classList.toggle('ghostTag', id === GHOST_ID);
          el.classList.toggle('watched', bridge.spectating === id);
          el.style.left = `${x}px`; el.style.top = `${y}px`;
          seen.add(id);
        }
      }
    }
    for (const [id, el] of tagEls) if (!seen.has(id)) { el.remove(); tagEls.delete(id); }
  }

  let hookRenderer = () => null;
  function setRendererGetter(fn) { hookRenderer = fn; }

  // ---- updates ----------------------------------------------------------------------------------
  function showUpdate(st) {
    patch(updateBox, st && st.state === 'ready' ? h('div', { class: 'update' },
      h('span', null, `Update ${st.version || ''} is ready.`),
      h('button', { class: 'btn green', onClick: () => tx.update.install() }, 'Restart now')) : null);
  }
  tx.update?.onStatus?.(showUpdate);
  tx.update?.status?.().then(showUpdate).catch(() => {});

  let lastRaceId = null;
  mp.subscribe((_m, evt) => {
    // A new race is loading for us: get the panel out of the way.
    const rid = mp.race && mp.race.id;
    if (rid !== lastRaceId) {
      lastRaceId = rid;
      if (rid && ui.open && mp.race.participants.includes(mp.self?.id)) toggle(false);
    }
    if (evt && evt.toast) toast(evt.toast, evt.kind);
    else if (evt && evt.chat) { if (!ui.open) toast(`${evt.chat.name}: ${evt.chat.text}`); }
    else if (evt && evt.openPanel) { ui.view = 'main'; toggle(true); }
    else if (evt && evt.emote) { ui.bubbles.set(evt.emote.id, { text: evt.emote.text, until: performance.now() + 3500 }); }
    else render();
  });

  // Keep the lobby list fresh while it's on screen.
  setInterval(() => { if (ui.open && !mp.lobby && !ui.loadingLobbies) refreshLobbies(); }, 8000);
  if (notesSince(mp.prefs.lastSeenVersion, tx.modVersion || '0').length) ui.whatsNew = true;
  render();
  requestAnimationFrame(hudFrame);
  return { toggle, toast, setRendererGetter };
}
