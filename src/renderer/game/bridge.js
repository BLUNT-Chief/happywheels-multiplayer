// High-level control of the game for the race logic: load a level by id, freeze everyone at the
// start line, detect restarts / finishes, and keep remote puppets in sync with the local world.

import { log } from '../log.js';
import { on as onHook, state as hookState } from '../hooks.js';
import { Game } from './locate.js';
import { computeLayout, hookCharacterEvents, characterTree, bodiesOf } from './character.js';
import { Puppet, makeContactFilter } from './puppets.js';

const listeners = {};
const UNARMED_ALPHA = 0.7;
const ARM_AFTER_STEPS = 15; // half a second apart at 30 Hz
function emit(evt, ...a) { for (const f of listeners[evt] || []) { try { f(...a); } catch (e) { log.error('bridge listener', evt, e); } } }

export const bridge = {
  ready: false,
  frozen: false,
  raceMode: false,
  collisions: false,
  ghostAlpha: 0.45,
  session: null,         // current race-eligible session (not replay/menu)
  sessionSerial: 0,      // increments on every session start (restarts included)
  layout: [],
  puppets: new Map(),    // peerId -> Puppet
  puppetSpecs: new Map(),// peerId -> { spec, events: [] } used to rebuild after local restarts
  now: () => performance.now(),
  pendingLoad: null,

  on(evt, fn) { (listeners[evt] ||= []).push(fn); return () => { listeners[evt] = listeners[evt].filter((f) => f !== fn); }; },

  screen() {
    const app = Game.app;
    if (!app) return 'loading';
    if (app.editor) return 'editor';
    if (app.sessionController) return this.session ? 'session' : 'loading-level';
    if (app.mainMenu) return 'menu';
    return 'other';
  },

  characterNames() { return (Game.Settings?.characterNames || []).slice(); },

  gameVersion() { return String(Game.Settings?.CURRENT_VERSION_STRING || ''); },

  /** Featured levels from the game's own list (fetched once per launch; failures retry). */
  featuredLevels() {
    if (!this.featuredPromise) {
      const F = Game.FeaturedLevels;
      if (!F) return Promise.reject(new Error('The game is still starting, try again in a moment'));
      this.featuredPromise = Promise.resolve(F.featuredLevels()).then((list) => {
        if (!list || !list.length) throw new Error('The featured level list is unavailable (offline?)');
        return list.map(levelInfo);
      });
      this.featuredPromise.catch(() => { this.featuredPromise = null; });
    }
    return this.featuredPromise;
  },

  /**
   * Player-made levels from totaljerkface.com, same query as the game's level browser.
   * mode: 'all' | 'name' | 'author'; sort: 'rating' | 'plays' | 'newest' | 'oldest';
   * uploaded: 'today' | 'week' | 'month' | 'anytime'. Returns { levels, pages }.
   */
  async playerLevels({ mode = 'all', sort = 'rating', uploaded = 'anytime', page = 1, term = '' } = {}) {
    const form = new URLSearchParams();
    form.set('action', mode === 'name' ? 'search_by_name' : mode === 'author' ? 'search_by_user' : 'get_all');
    form.set('page', String(Math.max(1, page | 0)));
    form.set('sortby', sort);
    form.set('uploaded', uploaded);
    if (mode !== 'all') form.set('sterm', String(term).slice(0, 60));
    return queryLevels(form);
  },

  /** One level's details by id, or null if it doesn't exist. */
  async levelById(id) {
    const form = new URLSearchParams();
    form.set('action', 'get_level');
    form.set('level_id', String(id | 0));
    const { levels } = await queryLevels(form);
    return levels[0] || null;
  },

  /** Leaves whatever the player is doing and loads `levelId`; resolves once the session starts. */
  loadLevel(levelId, { characterIndex = 1, timeoutMs = 45000 } = {}) {
    const app = Game.app;
    if (!app) return Promise.reject(new Error('Game is still starting'));
    if (app.editor) return Promise.reject(new Error('Close the level editor to join the race'));
    if (this.pendingLoad) this.pendingLoad.reject(new Error('superseded'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pendingLoad === p) { this.pendingLoad = null; reject(new Error('Timed out loading the level')); } }, timeoutMs);
      const p = {
        levelId: Number(levelId),
        characterIndex,
        resolve: (s) => { clearTimeout(timer); resolve(s); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this.pendingLoad = p;
      try {
        leaveSessionController(app);
        wrapLevelLoadComplete(app);
        app.openDeepLink({ kind: 'level', id: p.levelId });
        if (app.mainMenu) { // a popup blocked the deep link; go around it
          app.closeMainMenu();
          app.loadLevelByID(p.levelId);
        }
      } catch (e) {
        this.pendingLoad = null;
        p.reject(e);
      }
    });
  },

  returnToMenu() {
    const app = Game.app;
    if (app) leaveSessionController(app);
  },

  restart() {
    const app = Game.app;
    const ctl = app && app.sessionController;
    if (ctl && this.session) ctl.restartLevel();
  },

  setFrozen(v) { this.frozen = !!v; },

  localCharacterInfo() {
    const S = Game.Settings;
    const s = this.session;
    return { characterIndex: S ? S.characterIndex : 1, hideVehicle: !!(S && S.hideVehicle), layout: this.layout.slice(), levelId: S ? S.levelIndex : 0, version: s ? s.version : 0 };
  },

  // ---- puppets -------------------------------------------------------------------------------

  /** spec: { characterIndex, hideVehicle, layout } */
  setPuppet(peerId, spec) {
    this.removePuppet(peerId);
    this.puppetSpecs.set(peerId, { spec, events: [] });
    if (this.session) this.spawnPuppet(peerId);
  },

  spawnPuppet(peerId) {
    const entry = this.puppetSpecs.get(peerId);
    if (!entry || !this.session || !this.session.m_world) return null;
    const p = new Puppet(this.session, entry.spec);
    p.alpha = this.collisions ? UNARMED_ALPHA : this.ghostAlpha;
    try {
      p.spawn();
    } catch (e) {
      log.error('failed to spawn puppet', e);
      try { p.destroy(true); } catch {}
      return null;
    }
    this.puppets.set(peerId, p);
    for (const ev of entry.events) p.applyEvent(ev.path, ev.method, ev.args);
    return p;
  },

  removePuppet(peerId, forget = true) {
    const p = this.puppets.get(peerId);
    if (p) { p.destroy(!!(this.session && this.session.m_world)); this.puppets.delete(peerId); }
    if (forget) this.puppetSpecs.delete(peerId);
  },

  clearPuppets() { for (const id of [...this.puppetSpecs.keys()]) this.removePuppet(id); },

  /** Remote player restarted: rebuild their puppet fresh (intact body, at the start). */
  resetPuppet(peerId) {
    const entry = this.puppetSpecs.get(peerId);
    if (!entry) return;
    entry.events = [];
    this.removePuppet(peerId, false);
    if (this.session) this.spawnPuppet(peerId);
  },

  puppetState(peerId, t, data) {
    const p = this.puppets.get(peerId);
    if (p) p.pushSnapshot(t, data);
  },

  puppetEvent(peerId, path, method, args) {
    const entry = this.puppetSpecs.get(peerId);
    if (!entry) return;
    if (entry.events.length < 256) entry.events.push({ path, method, args });
    const p = this.puppets.get(peerId);
    if (p) p.applyEvent(path, method, args);
  },

  setCollisions(on) {
    this.collisions = !!on;
    for (const p of this.puppets.values()) {
      p.armed = false; p.clearSteps = 0;
      p.setAlpha(this.collisions ? UNARMED_ALPHA : this.ghostAlpha);
    }
  },
};

// ---- hooks into game classes -------------------------------------------------------------------

/** POSTs to the level server like the game's browser does and parses its XML answer. */
async function queryLevels(form) {
  const base = (Game.Settings && Game.Settings.siteURL) || 'https://totaljerkface.com/';
  // A string body: the game's request forwarding can't stream form objects.
  const res = await fetch(`${base}get_level.hw`, { method: 'POST', body: form.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  if (!res.ok) throw new Error(`The level server answered ${res.status}`);
  const text = await res.text();
  if (text.slice(0, 8).includes('failure')) {
    if (text.includes('not_found') || text.includes('no_level')) return { levels: [], pages: 1 };
    throw new Error('The level server could not run that search');
  }
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Unexpected answer from the level server');
  const root = doc.documentElement;
  const LD = Game.LevelData;
  const levels = [...doc.getElementsByTagName('lv')].map((n) => {
    const a = (k) => n.getAttribute(k);
    const uc = n.getElementsByTagName('uc')[0];
    const comments = uc ? uc.textContent : '';
    if (LD) {
      try { return levelInfo(new LD(a('id'), a('ln'), a('ui'), a('un'), a('rg'), a('vs'), a('ps'), a('dp'), comments, a('pc'), 1, 1, 1, a('dp'))); } catch {}
    }
    return { id: Number(a('id')), name: String(a('ln') || ''), author: String(a('un') || ''), character: Number(a('pc')) || 0, forceChar: Number(a('pc')) > 0, rating: 0, votes: Number(a('vs')) || 0, plays: Number(a('ps')) || 0, comments: '', created: 0 };
  }).filter((l) => l.id > 0);
  return { levels, pages: Math.max(1, Number(root.getAttribute('pp')) || 1) };
}

/** Plain summary of the game's level record. */
function levelInfo(l) {
  const created = l.created instanceof Date && !Number.isNaN(l.created.getTime()) ? l.created.getTime() : 0;
  return {
    id: Number(l.id), name: String(l.name || ''), author: String(l.author_name || ''),
    character: Number(l.character) || 0, forceChar: !!l.forceChar,
    rating: Number(l.average_rating) || 0, votes: Number(l.votes) || 0, plays: Number(l.plays) || 0,
    comments: String(l.comments || '').slice(0, 400), created,
  };
}

function isRaceEligible(session) {
  return session && !session.isReplay && !session.isMenu && !session.isEditorTest;
}

function markLocalShapes(session) {
  const ch = session.character;
  if (!ch) return;
  for (const [, c] of characterTree(ch)) {
    for (const k of Object.keys(c)) {
      const b = c[k];
      if (b && b.m_xf && typeof b.GetShapeList === 'function' && !b.__hwmpPuppet) {
        for (let s = b.GetShapeList(); s; s = s.m_next) s.__hwmpLocal = true;
      }
    }
  }
}

function installContactFilter(session) {
  const world = session.m_world;
  if (!world || world.__hwmpFilter) return;
  const def = world.m_contactFilter;
  world.m_contactFilter = makeContactFilter(def, {
    isLocalShape: (s) => s.__hwmpLocal === true,
    collisions: () => bridge.collisions,
  });
  world.__hwmpFilter = true;
}

/** Back to the main menu from anywhere in a level: playing, paused, character select or loading. */
function leaveSessionController(app) {
  const ctl = app.sessionController;
  if (!ctl) return;
  if (ctl.session) { ctl.returnToMainMenu(); return; }
  // No session yet (character menu or level still loading): abandon the controller so a load that
  // finishes later can't start a session on it (see the beginSession wrapper).
  ctl.__hwmpAbandoned = true;
  try { if (ctl.characterMenu) ctl.closeCharacterMenu(); } catch {}
  try { ctl.loadContainer.hide(); } catch {}
  app.closeSessionController();
}

const levelLoadWrapped = new WeakSet();
function wrapLevelLoadComplete(app) {
  if (levelLoadWrapped.has(app) || typeof app.levelLoadCompleteBind !== 'function') return;
  levelLoadWrapped.add(app);
  const orig = app.levelLoadCompleteBind;
  app.levelLoadCompleteBind = function (ev) {
    const r = orig.call(this, ev);
    // The loader reported an error: the game went back to the main menu.
    if (bridge.pendingLoad && app.mainMenu && !app.sessionController) {
      const p = bridge.pendingLoad;
      bridge.pendingLoad = null;
      p.reject(new Error('Level could not be loaded (not found or offline)'));
    }
    return r;
  };
}

function wrap(proto, name, make) {
  const orig = proto[name];
  if (typeof orig !== 'function' || orig.__hwmpWrapped) return;
  const w = make(orig);
  w.__hwmpWrapped = true;
  proto[name] = w;
}

function installGameHooks() {
  const SessionP = Game.Session.prototype;
  const CtlP = Game.SessionController.prototype;

  wrap(SessionP, 'start', (orig) => function (...a) {
    const r = orig.apply(this, a);
    if (isRaceEligible(this)) onSessionStart(this);
    return r;
  });
  wrap(SessionP, 'die', (orig) => function (...a) {
    if (this === bridge.session) onSessionEnd(this);
    return orig.apply(this, a);
  });
  wrap(SessionP, 'levelComplete', (orig) => function (...a) {
    const r = orig.apply(this, a);
    if (this === bridge.session) {
      emit('levelComplete', this);
      // The game locks the controls at the finish (its victory menu takes over). In a race that
      // menu is suppressed, so give the controls back: players keep driving while others finish.
      if (bridge.raceMode) this.inputAllowed = true;
    }
    return r;
  });
  for (const name of ['run30fps', 'run60fps']) {
    wrap(SessionP, name, (orig) => function (...a) {
      if (bridge.frozen && this === bridge.session) return undefined;
      return orig.apply(this, a);
    });
  }
  // Race mode: skip the character menu (character comes from our lobby) ...
  wrap(CtlP, 'begin', (orig) => function (...a) {
    const p = bridge.pendingLoad;
    if (p && !this.replayDataObject && this.levelDataObject && Number(this.levelDataObject.id) === p.levelId) {
      const S = Game.Settings;
      if (!this.levelDataObject.forceChar) { S.hideVehicle = false; S.characterIndex = p.characterIndex; }
      this.incrementPlays = true;
      return this.loadSession();
    }
    return orig.apply(this, a);
  });
  // ... and don't pop the end-of-level menu while racing (players keep watching the race).
  wrap(CtlP, 'sessionCompleteHandler', (orig) => function (...a) {
    if (bridge.raceMode && this.session === bridge.session) {
      try { this.session.removeEventListener(a[0]?.type, this.sessionCompleteHandlerBind); } catch {}
      return undefined;
    }
    return orig.apply(this, a);
  });
  wrap(CtlP, 'beginSession', (orig) => function (...a) {
    if (this.__hwmpAbandoned) return undefined;
    return orig.apply(this, a);
  });
  wrap(CtlP, 'returnToMainMenu', (orig) => function (...a) {
    const r = orig.apply(this, a);
    emit('exitedToMenu');
    return r;
  });

  onHook('preStep', (world) => {
    const s = bridge.session;
    if (!s || world !== s.m_world || !bridge.puppets.size) return;
    const now = bridge.now();
    for (const p of bridge.puppets.values()) p.apply(now);
    if (bridge.collisions && !bridge.frozen) armCollisions(s);
  });
  onHook('postStep', (world) => {
    const s = bridge.session;
    if (!s || world !== s.m_world) return;
    emit('step', s);
  });
  onHook('render', () => {
    const s = bridge.session;
    if (!s || !bridge.puppets.size) { emit('frame', s); return; }
    const now = bridge.now();
    for (const p of bridge.puppets.values()) { p.apply(now); p.paint(); }
    emit('frame', s);
  });
}

function localBounds(session, pad = 1.2) {
  const ch = session.character;
  if (!ch) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of bodiesOf(ch, bridge.layout)) {
    if (!b) continue;
    const p = b.m_xf.position;
    if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
  }
  return x0 === Infinity ? null : { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

function armCollisions(session) {
  const mine = localBounds(session);
  if (!mine) return;
  for (const p of bridge.puppets.values()) {
    if (p.armed) continue;
    const o = p.bounds();
    const overlap = o && !(o.x1 < mine.x0 || o.x0 > mine.x1 || o.y1 < mine.y0 || o.y0 > mine.y1);
    p.clearSteps = overlap ? 0 : p.clearSteps + 1;
    if (p.clearSteps >= ARM_AFTER_STEPS) { p.armed = true; p.setAlpha(1); }
  }
}

function onSessionStart(session) {
  bridge.session = session;
  bridge.sessionSerial++;
  const ch = session.character;
  bridge.layout = computeLayout(ch);
  markLocalShapes(session);
  installContactFilter(session);
  if (!ch.__hwmpHooked) {
    ch.__hwmpHooked = true;
    hookCharacterEvents(ch, (path, method, args) => {
      // Breaks can create new body parts; the character object outlives restarts, so use the
      // current session rather than the one this hook was installed in.
      if (bridge.session) markLocalShapes(bridge.session);
      emit('localEvent', path, method, args);
    });
  }
  for (const id of bridge.puppetSpecs.keys()) bridge.spawnPuppet(id);
  const p = bridge.pendingLoad;
  const S = Game.Settings;
  if (p && S && Number(S.levelIndex) === p.levelId) { bridge.pendingLoad = null; p.resolve(session); }
  emit('sessionStart', session, bridge.sessionSerial);
}

function onSessionEnd(session) {
  for (const id of [...bridge.puppets.keys()]) bridge.removePuppet(id, false);
  bridge.session = null;
  emit('sessionEnd', session);
}

/** Resolves once the game's classes are available and hooks are installed. */
export function initBridge() {
  return new Promise((resolve) => {
    const tryInit = () => {
      if (bridge.ready) return resolve(bridge);
      if (Game.Settings && Game.Session && Game.SessionController && Game.ContentLoader && hookState) {
        installGameHooks();
        bridge.ready = true;
        // A session may already be running if we initialized late.
        const s = Game.session;
        if (s && isRaceEligible(s)) onSessionStart(s);
        return resolve(bridge);
      }
      setTimeout(tryInit, 100);
    };
    tryInit();
  });
}

export { bodiesOf };
