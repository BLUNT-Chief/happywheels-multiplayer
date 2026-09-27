// DOM overlay (inside a shadow root) for the lobby browser, lobby room and race HUD.
// All player-supplied text is inserted as text nodes, never as HTML.

import css from './styles.css';
import { fmtTime } from '../net/race.js';

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style') el.setAttribute('style', v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const lobbyCode = (id) => { try { return BigInt(id).toString(36).toUpperCase(); } catch { return String(id); } };
const parseCode = (code) => {
  const c = String(code).trim();
  if (/^\d{15,20}$/.test(c)) return c;
  if (!/^[0-9a-z]{6,14}$/i.test(c)) return null;
  let n = 0n;
  for (const ch of c.toLowerCase()) n = n * 36n + BigInt(parseInt(ch, 36));
  return n.toString();
};

export function createOverlay(mp, bridge, tx) {
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
  const hud = h('div');
  const tags = h('div');
  const panelLayer = h('div');
  const resultsLayer = h('div');
  const toasts = h('div', { class: 'toasts' });
  const updateBox = h('div');
  const pill = h('button', { class: 'pill', title: 'Multiplayer (F2)', onClick: () => toggle() });
  scaled.append(hud, resultsLayer, panelLayer, toasts, updateBox, pill);
  root.append(tags, scaled);
  (document.body || document.documentElement).append(host);

  const ui = { open: false, view: null, featured: null, featuredErr: null, levelFilter: '', lobbies: null, lobbiesErr: null, loadingLobbies: false, resultsHidden: false, busy: false };
  const avatars = new Map();
  const charNames = () => { const n = bridge.characterNames(); return n.length ? n : Array.from({ length: 11 }, (_, i) => `Character ${i + 1}`); };
  const charName = (i) => (i ? (charNames()[i - 1] || `Character ${i}`) : 'Players choose');
  const isTyping = () => { const a = shadow.activeElement; return !!a && (a.tagName === 'INPUT' || a.tagName === 'SELECT' || a.tagName === 'TEXTAREA'); };

  // Keep game hotkeys away from our text fields, and add ours (F2 panel, R restart).
  window.addEventListener('keydown', (e) => {
    if (isTyping()) { e.stopImmediatePropagation(); if (e.key === 'Escape') shadow.activeElement.blur(); return; }
    if (e.key === 'F2') { e.preventDefault(); e.stopImmediatePropagation(); toggle(); return; }
    if (ui.open && e.key === 'Escape') { e.stopImmediatePropagation(); toggle(false); return; }
    if ((e.key === 'r' || e.key === 'R') && !e.repeat && mp.race && bridge.session && (mp.phase === 'racing' || mp.phase === 'results') && !bridge.frozen) {
      e.stopImmediatePropagation();
      bridge.restart();
    }
  }, true);
  window.addEventListener('keyup', (e) => { if (isTyping()) e.stopImmediatePropagation(); }, true);

  function toggle(v = !ui.open) {
    ui.open = v;
    if (ui.open && !mp.lobby) refreshLobbies();
    render();
  }

  function toast(text, kind) {
    const t = h('div', { class: `toast ${kind || ''}` }, text);
    toasts.append(t);
    setTimeout(() => t.remove(), 4200);
    while (toasts.children.length > 4) toasts.firstChild.remove();
  }

  async function act(fn) {
    if (ui.busy) return;
    ui.busy = true; render();
    try { await fn(); } catch (e) { toast(e.message || String(e), 'error'); } finally { ui.busy = false; render(); }
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
    };
    if (typeof cached === 'string') img.src = cached;
    else if (!avatars.has(id)) { avatars.set(id, null); tx.avatar(id).then(apply).catch(() => {}); }
    return img;
  }

  // ---- views ------------------------------------------------------------------------------------
  function header(title) {
    return h('header', null,
      h('h1', null, title),
      h('div', { class: 'grow' }),
      h('span', { class: 'ver' }, `v${tx.modVersion || '?'}`),
      h('button', { class: 'close', title: 'Close (Esc)', onClick: () => toggle(false) }, '×'));
  }

  function browserView() {
    const code = h('input', { type: 'text', placeholder: 'Lobby code', maxlength: 24 });
    const type = h('select', { onChange: (e) => mp.setLobbyType(e.target.value) },
      h('option', { value: 'friends', selected: mp.prefs.lobbyType === 'friends' }, 'Friends only'),
      h('option', { value: 'public', selected: mp.prefs.lobbyType === 'public' }, 'Public'),
      h('option', { value: 'private', selected: mp.prefs.lobbyType === 'private' }, 'Invite / code only'));
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
            h('div', { class: 'small muted' }, `${d.level ? d.level : 'No level picked'} · ${d.phase === 'lobby' || !d.phase ? 'waiting' : 'racing'} · collisions ${d.collisions === '1' ? 'on' : 'off'}`)),
          h('div', { class: 'small muted' }, `${l.members.length}${l.limit ? `/${l.limit}` : ''} players`),
          l.compatible
            ? h('button', { class: 'btn', disabled: ui.busy, onClick: () => act(() => mp.join(l.id)) }, 'Join')
            : h('span', { class: 'small error', title: `Lobby runs mod ${d.modVersion || '?'}` }, 'Other version')));
      }
    }
    return [
      header('Multiplayer'),
      h('div', { class: 'body stack' },
        mp.self ? h('div', { class: 'muted' }, 'Signed in to Steam as ', h('b', null, mp.self.name)) : h('div', { class: 'error' }, 'Steam is not running. Start Steam, then restart Happy Wheels Multiplayer.'),
        h('div', { class: 'card stack' },
          h('h2', null, 'Host a race'),
          h('div', { class: 'row' },
            h('button', { class: 'btn pink big', disabled: ui.busy || !mp.self, onClick: () => act(() => mp.create()) }, 'Create lobby'),
            type)),
        h('div', { class: 'card stack' },
          h('div', { class: 'row between' }, h('h2', null, 'Join a race'),
            h('button', { class: 'btn ghost', disabled: ui.loadingLobbies, onClick: refreshLobbies }, ui.loadingLobbies ? 'Refreshing…' : 'Refresh')),
          h('div', { class: 'row' }, code,
            h('button', { class: 'btn', disabled: ui.busy, onClick: () => {
              const id = parseCode(code.value);
              if (!id) return toast('That lobby code does not look right', 'error');
              act(() => mp.join(id));
            } }, 'Join by code')),
          list),
        h('div', { class: 'small muted' }, 'Unofficial fan-made mod. Not affiliated with Fancy Force or Total Jerkface.')),
    ];
  }

  function playerRow(p) {
    const isHost = p.id === mp.hostId;
    const statusText = {
      lobby: p.ready ? '' : 'not ready', loading: 'loading…', ready: 'at the start line', racing: 'racing',
      finished: `finished ${fmtTime(p.finishMs)}`, dnf: 'did not finish', spectating: 'watching',
    }[p.status] ?? p.status;
    return h('div', { class: 'player' },
      avatarImg(p.id),
      h('div', null,
        h('div', null, p.name, isHost ? h('span', { class: 'badge host' }, 'HOST') : null,
          p.status === 'lobby' && p.ready ? h('span', { class: 'badge ready' }, 'READY') : null,
          p.id === mp.self.id ? h('span', { class: 'badge' }, 'you') : null),
        h('div', { class: 'status' }, charName(p.character))),
      h('div', { class: 'status' }, statusText));
  }

  function levelPicker(editable) {
    const lvl = mp.settings.level;
    const cur = h('div', null,
      lvl ? h('div', null, h('b', null, lvl.name), h('span', { class: 'small muted' }, `  #${lvl.id}${lvl.forceChar ? ` · ${charName(lvl.character)}` : ''}`))
        : h('div', { class: 'muted' }, editable ? 'Pick a level below' : 'Host has not picked a level yet'));
    if (!editable) return h('div', { class: 'card' }, h('div', { class: 'label' }, 'Level'), cur);
    loadFeatured();
    const search = h('input', { type: 'text', placeholder: 'Search featured levels', value: ui.levelFilter });
    const list = h('div', { class: 'levels' });
    const fill = () => {
      list.replaceChildren();
      if (ui.featuredErr === 'loading') return list.append(h('div', { class: 'muted small' }, 'Loading featured levels…'));
      if (ui.featuredErr) return list.append(h('div', { class: 'error small' }, `Could not load featured levels: ${ui.featuredErr}`));
      const f = ui.levelFilter.toLowerCase();
      const items = (ui.featured || []).filter((l) => !f || l.name.toLowerCase().includes(f) || String(l.id) === f).slice(0, 150);
      for (const l of items) {
        list.append(h('button', { class: `level ${lvl && lvl.id === l.id ? 'sel' : ''}`, onClick: () => mp.setLevel(l) },
          h('span', null, l.name), h('span', { class: 'char' }, l.forceChar ? charName(l.character) : 'any character')));
      }
      if (!items.length) list.append(h('div', { class: 'muted small' }, 'No matches'));
    };
    search.addEventListener('input', () => { ui.levelFilter = search.value; fill(); });
    fill();
    const custom = h('input', { type: 'text', placeholder: 'Level ID', maxlength: 12, style: 'width: 110px' });
    return h('div', { class: 'card stack' },
      h('div', { class: 'label' }, 'Level'), cur, search, list,
      h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Or any user level:'), custom,
        h('button', { class: 'btn ghost', onClick: () => {
          const id = Number(custom.value.trim());
          if (!Number.isInteger(id) || id < 1) return toast('Enter a numeric level ID', 'error');
          mp.setLevel({ id, name: `Level #${id}`, character: 0, forceChar: false });
        } }, 'Use')));
  }

  function lobbyView() {
    const me = mp.players.get(mp.self.id);
    const hostMode = mp.isHost;
    const lvl = mp.settings.level;
    const inRace = ['loading', 'countdown', 'racing'].includes(mp.phase);
    const charLocked = (lvl && lvl.forceChar) || mp.settings.forceCharacter;

    const players = h('div', { class: 'list' }, [...mp.players.values()].map(playerRow));
    const chatLog = h('div', { class: 'chat-log' }, mp.chat.map((c) => h('div', null, h('span', { class: 'who' }, c.name), c.text)));
    queueMicrotask(() => { chatLog.scrollTop = chatLog.scrollHeight; });
    const chatIn = h('input', { type: 'text', placeholder: 'Say something…', maxlength: 200, style: 'flex:1' });
    chatIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { mp.sendChat(chatIn.value); chatIn.value = ''; } });

    const charSel = h('select', { disabled: !!charLocked || inRace, onChange: (e) => mp.setCharacter(Number(e.target.value)) },
      charNames().map((n, i) => h('option', { value: i + 1, selected: mp.prefs.character === i + 1 }, n)));

    const settings = h('div', { class: 'card stack' },
      h('div', { class: 'label' }, 'Race rules'),
      h('label', { class: 'toggle' },
        h('input', { type: 'checkbox', checked: mp.settings.collisions, disabled: !hostMode || inRace, onChange: (e) => mp.setCollisions(e.target.checked) }),
        h('span', null, 'Collisions between players')),
      h('div', { class: 'small muted' }, mp.settings.collisions ? 'Racers can bump into each other.' : 'Other racers are see-through ghosts you pass through.'),
      h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Character:'),
        hostMode && !(lvl && lvl.forceChar)
          ? h('select', { disabled: inRace, onChange: (e) => mp.setForceCharacter(Number(e.target.value)) },
            [0, ...charNames().map((_, i) => i + 1)].map((i) => h('option', { value: i, selected: mp.settings.forceCharacter === i }, i ? `Everyone: ${charName(i)}` : 'Players choose')))
          : h('span', null, lvl && lvl.forceChar ? `${charName(lvl.character)} (set by level)` : charName(mp.settings.forceCharacter))),
      h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'After the first finish, others get'),
        hostMode
          ? h('select', { disabled: inRace, onChange: (e) => mp.setGrace(Number(e.target.value)) },
            [15, 30, 45, 60, 90, 120, 300].map((s) => h('option', { value: s, selected: mp.settings.graceSec === s }, `${s}s`)))
          : h('span', null, `${mp.settings.graceSec}s`),
        h('span', { class: 'small muted' }, 'to finish.')));

    let action;
    if (hostMode) {
      if (inRace) action = h('button', { class: 'btn big', disabled: true }, 'Race in progress');
      else action = h('button', { class: 'btn green big', disabled: !lvl, onClick: () => { mp.startRace(); toggle(false); } }, mp.phase === 'results' ? 'Start next race' : 'Start race');
    } else if (inRace || mp.phase === 'spectating') {
      action = h('button', { class: 'btn big', disabled: true }, mp.phase === 'spectating' ? 'Race in progress — next one soon' : 'Race in progress');
    } else {
      action = h('button', { class: `btn big ${me && me.ready ? 'ghost' : 'green'}`, onClick: () => mp.setReady(!(me && me.ready)) }, me && me.ready ? 'Not ready' : "I'm ready");
    }

    return [
      header(mp.settings.name || 'Race lobby'),
      h('div', { class: 'body' },
        h('div', { class: 'cols' },
          h('div', { class: 'stack' },
            h('div', { class: 'card stack' },
              h('div', { class: 'row between' }, h('div', { class: 'label' }, `Players (${mp.players.size})`),
                h('div', { class: 'row' },
                  h('span', { class: 'small muted' }, 'Code'), h('span', { class: 'code' }, lobbyCode(mp.lobby.id)),
                  h('button', { class: 'btn ghost', onClick: () => { navigator.clipboard?.writeText(lobbyCode(mp.lobby.id)); toast('Lobby code copied'); } }, 'Copy'))),
              players,
              h('div', { class: 'row' },
                h('button', { class: 'btn', onClick: () => mp.invite() }, 'Invite Steam friends'),
                h('button', { class: 'btn ghost', onClick: () => act(() => mp.leave()) }, 'Leave lobby'))),
            h('div', { class: 'card stack' }, h('div', { class: 'label' }, 'Chat'), chatLog, h('div', { class: 'row' }, chatIn))),
          h('div', { class: 'stack' },
            h('div', { class: 'card row between' },
              h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Your character'), charSel),
              action),
            levelPicker(hostMode && !inRace),
            settings,
            hostMode && mp.phase === 'results' ? h('button', { class: 'btn ghost', onClick: () => mp.backToLobby() }, 'End race for everyone') : null))),
    ];
  }

  let lastViewKey = '';
  function render() {
    // results modal (interactive, so only rebuilt on state changes)
    if (mp.phase !== 'results') ui.resultsHidden = false;
    resultsLayer.replaceChildren();
    if (mp.race && mp.phase === 'results' && !ui.resultsHidden && !ui.open) resultsLayer.append(results(mp.race));

    // pill
    pill.replaceChildren(h('span', { class: 'dot' }), 'MULTIPLAYER');
    const inLobby = !!mp.lobby;
    pill.classList.toggle('live', inLobby);
    pill.classList.toggle('compact', !!bridge.session);
    if (inLobby) pill.append(h('span', { class: 'sub' }, `${mp.players.size} in lobby`));

    // panel (rebuilt only when not typing, to keep focus/text intact)
    if (!ui.open) { panelLayer.replaceChildren(); lastViewKey = ''; return; }
    const key = inLobby ? 'lobby' : 'browser';
    if (isTyping() && key === lastViewKey) return;
    lastViewKey = key;
    panelLayer.replaceChildren(
      h('div', { class: 'scrim', onClick: () => toggle(false) }),
      h('div', { class: 'panel' }, inLobby ? lobbyView() : browserView()));
  }

  // ---- HUD (runs every animation frame) --------------------------------------------------------
  const tagEls = new Map();
  let lastHud = 0;
  function hudFrame(ts) {
    requestAnimationFrame(hudFrame);
    updateTags();
    if (ts - lastHud < 50) return; // text HUD at 20 Hz
    lastHud = ts;
    const race = mp.race;
    hud.replaceChildren();
    if (race && mp.lobby) {
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
        hud.append(h('div', { class: 'timer' }, fmtTime(mine != null ? mine : now - race.goAt)));
        if (race.deadline && mp.phase === 'racing') {
          const left = Math.max(0, Math.ceil((race.deadline - now) / 1000));
          hud.append(h('div', { class: 'hint', style: 'bottom: 34px' }, `Race ends in ${left}s`));
        }
        hud.append(h('div', { class: 'hint' }, 'R = restart from the start line  ·  F2 = lobby'));
      }
      hud.append(standings(race));
    }
  }

  function standings(race) {
    const rows = race.participants.map((id) => mp.players.get(id)).filter(Boolean)
      .map((p) => ({ p, ms: race.finishes[p.id], dnf: race.dnf.has(p.id) }))
      .sort((a, b) => (a.ms ?? Infinity) - (b.ms ?? Infinity) || (a.dnf - b.dnf));
    return h('div', { class: 'standings' }, rows.map((r, i) => h('div', { class: 'st' },
      h('span', { class: 'pos' }, r.ms != null ? `${i + 1}.` : '·'),
      h('span', { class: r.p.id === mp.self.id ? 'me' : '' }, r.p.name),
      h('span', { class: 'muted' }, r.ms != null ? fmtTime(r.ms) : r.dnf ? 'DNF' : r.p.status === 'loading' ? '…' : ''))));
  }

  function results(race) {
    const rows = race.participants.map((id) => mp.players.get(id)).filter(Boolean)
      .map((p) => ({ p, ms: race.finishes[p.id] }))
      .sort((a, b) => (a.ms ?? Infinity) - (b.ms ?? Infinity));
    return h('div', { class: 'results' },
      h('h1', null, 'Results'),
      rows.map((r, i) => h('div', { class: `r ${i === 0 && r.ms != null ? 'first' : ''}` },
        h('span', { class: 'p' }, r.ms != null ? `${i + 1}` : '-'),
        h('span', null, r.p.name),
        h('span', null, r.ms != null ? fmtTime(r.ms) : 'DNF'))),
      h('div', { class: 'row between', style: 'margin-top: 14px' },
        h('button', { class: 'btn ghost', onClick: () => { ui.resultsHidden = true; render(); } }, 'Keep driving'),
        mp.isHost
          ? h('div', { class: 'row' },
            h('button', { class: 'btn ghost', onClick: () => { ui.resultsHidden = true; toggle(true); } }, 'Change level'),
            h('button', { class: 'btn green', onClick: () => mp.startRace() }, 'Race again'))
          : h('span', { class: 'small muted' }, 'Waiting for the host…')));
  }

  function updateTags() {
    const s = bridge.session;
    const seen = new Set();
    if (s && bridge.puppets.size) {
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
          const name = mp.players.get(id)?.name || 'Player';
          if (el.textContent !== name) el.textContent = name;
          el.classList.toggle('edge', off);
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
    updateBox.replaceChildren();
    if (!st || st.state !== 'ready') return;
    updateBox.append(h('div', { class: 'update' },
      h('span', null, `Update ${st.version || ''} is ready.`),
      h('button', { class: 'btn green', onClick: () => tx.update.install() }, 'Restart now')));
  }
  tx.update?.onStatus?.(showUpdate);
  tx.update?.status?.().then(showUpdate).catch(() => {});

  mp.subscribe((_m, evt) => {
    if (evt && evt.toast) toast(evt.toast, evt.kind);
    else render();
  });
  render();
  requestAnimationFrame(hudFrame);
  return { toggle, toast, setRendererGetter };
}
