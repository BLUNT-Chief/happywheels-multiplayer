// Remote players are rendered as "puppets": real game characters built with the game's own
// classes, whose bodies are driven from network snapshots every frame. The game's own paint
// code then draws them, vehicle, gore and all.

import { log } from '../log.js';
import { libs } from '../hooks.js';
import { Game } from './locate.js';
import { computeLayout, resolvePath, isEventMethod } from './character.js';

const INTERP_DELAY_MS = 100;
const MAX_SNAPSHOTS = 40;

function buildCharacterData(session, characterIndex) {
  const CL = Game.ContentLoader;
  const loader = Object.create(CL.prototype);
  loader._levelVersion = session.levelVersion;
  loader.characterIndex = characterIndex;
  loader.dispatchEvent = () => true;
  loader.loadCharacterData();
  return loader._characterData;
}

/** The session's contact-listener registries (Maps keyed by shape). */
function listenerMaps(session) {
  const cl = session.contactListener;
  if (!cl) return [];
  return Object.keys(cl).map((k) => cl[k]).filter((v) => v instanceof Map);
}

function allBodies(world) {
  const s = new Set();
  for (let b = world.m_bodyList; b; b = b.m_next) s.add(b);
  return s;
}

function lerpAngle(a, b, t) {
  let d = b - a;
  d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
  return a + d * t;
}

class Puppet {
  constructor(session, spec) {
    this.session = session;
    this.spec = spec; // { characterIndex, hideVehicle, layout }
    this.snapshots = [];
    this.mcs = [];
    this.bodies = new Set();
    this.driven = new Set();
    this.shapes = new Set();
    this.appliedOnce = new Set();
    this.alpha = 1;
    this.character = null;
    this.slotBodies = [];
    this.dead = false;
    // Collisions only 'arm' once this racer and the local player have been apart for a moment,
    // so everyone can share the start line (and restart) without exploding into each other.
    // Tracked per part: a racer who left a part (say, a pogo stick) where you are still becomes
    // solid everywhere else.
    this.armedBodies = new Set();
    this.clearSteps = new Map(); // body -> consecutive steps away from the local player
    // Free: physics moves this racer instead of snapshots (an AI racer tumbling after a hit).
    this.free = false;
    // Ghost: never solid to the local player, even with collisions on (an AI racer that finished).
    this.ghost = false;
  }

  spawn() {
    const session = this.session;
    const S = Game.Settings;
    const world = session.m_world;
    const container = session.containerSprite;
    const cd = buildCharacterData(session, this.spec.characterIndex);
    const beforeKids = new Set(container.children);
    const beforeBodies = allBodies(world);
    const maps = listenerMaps(session);
    const beforeListeners = maps.map((m) => new Set(m.keys()));
    const saved = { ch: session._character, idx: S.characterIndex, hv: S.hideVehicle };
    let ch;
    try {
      try {
        S.characterIndex = this.spec.characterIndex;
        S.hideVehicle = !!this.spec.hideVehicle;
        session.setupCharacter(cd);
        ch = session._character;
      } finally {
        S.characterIndex = saved.idx;
        S.hideVehicle = saved.hv;
      }
      ch.main = false;
      ch.__hwmpPuppet = true;
      this.character = ch;
      // Some characters' setup refers to session.character (e.g. the dad's kid bolts its seat to
      // session.character.frameBody), so the puppet is the session's character while it builds.
      ch.create();
    } finally {
      session._character = saved.ch;
      // Whatever happened, take ownership of everything the spawn created, and drop the game's
      // contact handlers for it: puppets are display-only (gore comes from replayed events), and a
      // throwing handler inside a physics step would wedge the whole world.
      for (const kid of container.children) if (!beforeKids.has(kid)) this.mcs.push(kid);
      const added = [];
      for (const b of allBodies(world)) if (!beforeBodies.has(b)) added.push(...this.trackBody(b));
      maps.forEach((m, i) => { for (const k of [...m.keys()]) if (!beforeListeners[i].has(k)) m.delete(k); });
      // Box2D pairs overlapping shapes as they are created, before we could tag them as puppet
      // parts, so the contact filter never saw them. Re-run the broadphase for them now; this
      // drops those contacts (e.g. with the local player on the shared start line).
      this.refilter(added);
    }

    // Drive the bodies named by the sender's layout; if our layout disagrees (different game
    // build), names still line up and unknown ones are simply skipped.
    const layout = this.spec.layout && this.spec.layout.length ? this.spec.layout : computeLayout(ch);
    this.layout = layout;
    this.refreshSlots();
    this.setAlpha(this.alpha);
    this.paint();
  }

  /** Tags a body and its shapes as ours; returns the shapes. */
  trackBody(b) {
    this.bodies.add(b);
    b.__hwmpPuppet = this;
    const shapes = [];
    for (let s = b.GetShapeList(); s; s = s.m_next) { this.shapes.add(s); s.__hwmpPuppet = this; shapes.push(s); }
    return shapes;
  }

  refilter(shapes) {
    const world = this.session.m_world;
    if (!world || world.m_lock) return;
    for (const s of shapes) { try { if (!s.m_body.destroyed) world.Refilter(s); } catch {} }
  }

  refreshSlots() {
    this.slotBodies = this.layout.map((k) => {
      const b = resolvePath(this.character, k);
      return b && libs.b2Body && b instanceof libs.b2Body && !b.destroyed ? b : null;
    });
    this.driven = new Set(this.slotBodies.filter(Boolean));
  }

  /** Bodies created after spawn (e.g. by a replayed break) must be tracked for filtering. */
  adoptNewBodies() {
    const world = this.session.m_world;
    const added = [];
    for (const b of allBodies(world)) {
      if (b.__hwmpPuppet || this.bodies.has(b)) continue;
      // New bodies whose joints connect to one of ours belong to us.
      for (let j = b.m_jointList; j; j = j.next) {
        if (this.bodies.has(j.other)) { added.push(...this.trackBody(b)); break; }
      }
    }
    this.refilter(added);
  }

  setAlpha(a) {
    this.alpha = a;
    for (const mc of this.mcs) { try { mc.alpha = a; } catch {} }
  }

  pushSnapshot(t, data) {
    const arr = this.snapshots;
    if (arr.length && t <= arr[arr.length - 1].t) return; // out of order / duplicate
    arr.push({ t, data });
    if (arr.length > MAX_SNAPSHOTS) arr.shift();
  }

  /** Moves bodies to the interpolated remote state for render time `now` (synced clock, ms). */
  apply(now) {
    if (!this.character || this.dead || this.free) return;
    const arr = this.snapshots;
    if (!arr.length) return;
    const rt = now - INTERP_DELAY_MS;
    let a = arr[0];
    let b = null;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].t <= rt) { a = arr[i]; b = arr[i + 1] || null; break; }
    }
    let t = 0;
    if (b) t = Math.min(1, Math.max(0, (rt - a.t) / (b.t - a.t)));
    const da = a.data;
    const db = b ? b.data : null;
    const n = Math.min(this.slotBodies.length, Math.floor(da.length / 6));
    const pos = { x: 0, y: 0 };
    for (let i = 0; i < n; i++) {
      const body = this.slotBodies[i];
      const o = i * 6;
      if (!body || body.destroyed || !Number.isFinite(da[o])) continue;
      let x = da[o], y = da[o + 1], ang = da[o + 2];
      if (db && Number.isFinite(db[o])) {
        x += (db[o] - x) * t;
        y += (db[o + 1] - y) * t;
        ang = lerpAngle(ang, db[o + 2], t);
      } else if (!db) {
        // Extrapolate briefly past the newest snapshot (packet loss), capped.
        const dt = Math.min(0.15, Math.max(0, (rt - a.t) / 1000));
        x += da[o + 3] * dt; y += da[o + 4] * dt; ang += da[o + 5] * dt;
      }
      pos.x = x; pos.y = y;
      body.SetXForm(pos, ang);
      body.m_linearVelocity.Set(da[o + 3], da[o + 4]);
      body.m_angularVelocity = da[o + 5];
      body.WakeUp?.();
      // Keep interpolation state coherent for 60fps rendering.
      if (body.m_interpolatedPosition) {
        body.m_interpolatedPosition.Set(x, y);
        body.m_interpolatedAngle = ang;
        body.m_interpolatedWorldCenter?.SetV?.(body.m_sweep.c);
        body.m_interpolatedMatrix?.SetM?.(body.m_xf.R);
      }
    }
  }

  paint() {
    if (!this.character || this.dead) return;
    try { this.character.paint(); } catch {}
  }

  applyEvent(path, method, args) {
    if (!isEventMethod(method)) return;
    const target = resolvePath(this.character, path);
    if (!target || typeof target[method] !== 'function') return;
    const once = `${path}|${method}`;
    if (method !== 'eject') {
      if (this.appliedOnce.has(once)) return;
      this.appliedOnce.add(once);
    }
    const container = this.session.containerSprite;
    const beforeKids = new Set(container.children);
    const maps = listenerMaps(this.session);
    const beforeListeners = maps.map((m) => new Set(m.keys()));
    try {
      target[method](...args.slice(0, 4));
    } catch (e) {
      log.warn('puppet event failed', method, e);
    }
    maps.forEach((m, i) => { for (const k of [...m.keys()]) if (!beforeListeners[i].has(k)) m.delete(k); });
    this.adoptNewBodies();
    this.refreshSlots();
    // Display objects created by the event (gore pieces) belong to this puppet too.
    for (const kid of container.children) {
      if (!beforeKids.has(kid)) { this.mcs.push(kid); try { kid.alpha = this.alpha; } catch {} }
    }
  }

  destroy(worldAlive) {
    if (this.dead) return;
    this.dead = true;
    const session = this.session;
    for (const m of listenerMaps(session)) for (const s of this.shapes) m.delete(s);
    if (worldAlive && session.m_world) {
      for (const b of this.bodies) { try { if (!b.destroyed) session.m_world.DestroyBody(b); } catch {} }
    }
    for (const mc of this.mcs) {
      try { if (mc.parent) mc.parent.removeChild(mc); } catch {}
    }
    try { this.character.die(); } catch {}
    this.mcs = [];
    this.bodies.clear();
    this.shapes.clear();
    this.character = null;
  }

  /** Axis-aligned box around the driven bodies (meters), padded for limb size. */
  bounds(pad = 1.2) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of this.driven) {
      if (b.destroyed) continue;
      const p = b.m_xf.position;
      if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    }
    return x0 === Infinity ? null : { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
  }

  /** Hand the racer to physics (a tumble), or back to snapshots. Refilters so it lands on the ground. */
  setFree(on) {
    if (this.free === !!on || !this.character) return;
    this.free = !!on;
    this.refilter([...this.shapes]);
    if (on) for (const b of this.driven) b.WakeUp?.();
  }

  /** Push from a hit that happened in another player's game: the direction of the push and its strength. */
  kick(nx, ny, strength) {
    const speed = Math.max(3, Math.min(10, strength / 6));
    const spin = (nx >= 0 ? 1 : -1) * Math.min(6, speed * 0.6);
    for (const b of this.driven) {
      if (b.destroyed) continue;
      b.m_linearVelocity.Set(b.m_linearVelocity.x + nx * speed, b.m_linearVelocity.y + ny * speed - 2);
      b.m_angularVelocity += spin;
      b.WakeUp?.();
    }
  }

  /** Solid to the local player: the main body has armed (used for the ghost look). */
  get armed() {
    const ch = this.character;
    const main = ch && ch.chestBody;
    return main ? this.armedBodies.has(main) : this.armedBodies.size > 0;
  }

  /** One physics step of arming: parts away from the local player's box for `steps` steps arm. */
  updateArming(box, steps, pad = 1.2) {
    for (const b of this.bodies) {
      if (b.destroyed || this.armedBodies.has(b)) continue;
      const p = b.m_xf.position;
      const near = p.x > box.x0 - pad && p.x < box.x1 + pad && p.y > box.y0 - pad && p.y < box.y1 + pad;
      const n = near ? 0 : (this.clearSteps.get(b) || 0) + 1;
      this.clearSteps.set(b, n);
      if (n >= steps) this.armedBodies.add(b);
    }
  }

  resetArming() {
    this.armedBodies.clear();
    this.clearSteps.clear();
  }

  /** Screen-space anchor (world coords, pixels) for name tags. */
  headWorldPos() {
    const ch = this.character;
    const b = ch && (ch.head1Body || ch.chestBody);
    if (!b || b.destroyed) return null;
    const p = b.m_xf.position;
    return { x: p.x * this.session.m_physScale, y: p.y * this.session.m_physScale };
  }
}

/** Contact filter: decides every collision involving a puppet. */
export function makeContactFilter(defaultFilter, opts) {
  return {
    ShouldCollide(a, b) {
      // By shape or by body: the game can add shapes to a body after we tagged it.
      const pa = a.__hwmpPuppet || (a.m_body && a.m_body.__hwmpPuppet);
      const pb = b.__hwmpPuppet || (b.m_body && b.m_body.__hwmpPuppet);
      if (!pa && !pb) return defaultFilter.ShouldCollide(a, b);
      if (pa && pb) return false;
      const p = pa || pb;
      const ps = pa ? a : b;
      const other = pa ? b : a;
      if (other.IsSensor?.() || other.m_isSensor || ps.m_isSensor) return false;
      if (opts.isLocalShape(other)) return opts.collisions() && !p.ghost && p.armedBodies.has(ps.m_body);
      const ob = other.m_body;
      // Free (non network-driven) puppet parts may rest on static level geometry; nothing else.
      // A racer handed to physics (tumbling after a hit) lands on the ground too.
      if (ob && ob.IsStatic() && (p.free || !p.driven.has(ps.m_body))) return defaultFilter.ShouldCollide(a, b);
      return false;
    },
  };
}

export { Puppet };
