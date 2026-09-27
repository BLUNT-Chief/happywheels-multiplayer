// Remote players are rendered as "puppets": real game characters built with the game's own
// classes, whose bodies are driven from network snapshots every frame. The game's own paint
// code then draws them, vehicle, gore and all.

import { libs } from '../hooks.js';
import { Game } from './locate.js';
import { computeLayout, resolvePath, isEventMethod } from './character.js';

const INTERP_DELAY_MS = 100;
const MAX_SNAPSHOTS = 40;
const GHOST_ALPHA = 0.45;

function buildCharacterData(session, characterIndex) {
  const CL = Game.ContentLoader;
  const loader = Object.create(CL.prototype);
  loader._levelVersion = session.levelVersion;
  loader.characterIndex = characterIndex;
  loader.dispatchEvent = () => true;
  loader.loadCharacterData();
  return loader._characterData;
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
  }

  spawn() {
    const session = this.session;
    const S = Game.Settings;
    const world = session.m_world;
    const container = session.containerSprite;
    const cd = buildCharacterData(session, this.spec.characterIndex);
    const beforeKids = new Set(container.children);
    const beforeBodies = allBodies(world);
    const saved = { ch: session._character, idx: S.characterIndex, hv: S.hideVehicle };
    let ch;
    try {
      S.characterIndex = this.spec.characterIndex;
      S.hideVehicle = !!this.spec.hideVehicle;
      session.setupCharacter(cd);
      ch = session._character;
    } finally {
      session._character = saved.ch;
      S.characterIndex = saved.idx;
      S.hideVehicle = saved.hv;
    }
    ch.main = false;
    ch.__hwmpPuppet = true;
    this.character = ch;
    ch.create();
    for (const kid of container.children) if (!beforeKids.has(kid)) this.mcs.push(kid);
    for (const b of allBodies(world)) if (!beforeBodies.has(b)) this.trackBody(b);

    // Drive the bodies named by the sender's layout; if our layout disagrees (different game
    // build), names still line up and unknown ones are simply skipped.
    const layout = this.spec.layout && this.spec.layout.length ? this.spec.layout : computeLayout(ch);
    this.layout = layout;
    this.refreshSlots();
    this.setAlpha(this.alpha);
    ch.paint();
  }

  trackBody(b) {
    this.bodies.add(b);
    b.__hwmpPuppet = this;
    for (let s = b.GetShapeList(); s; s = s.m_next) { this.shapes.add(s); s.__hwmpPuppet = this; }
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
    for (const b of allBodies(world)) {
      if (b.__hwmpPuppet || this.bodies.has(b)) continue;
      // New bodies whose joints connect to one of ours belong to us.
      for (let j = b.m_jointList; j; j = j.next) {
        if (this.bodies.has(j.other)) { this.trackBody(b); break; }
      }
    }
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
    if (!this.character || this.dead) return;
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
    try {
      target[method](...args.slice(0, 4));
    } catch (e) {
      console.warn('[hwmp] puppet event failed', method, e);
    }
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
    const cl = session.contactListener;
    if (cl && typeof cl.deleteListener === 'function') {
      const types = ['ADD', 'REMOVE', 'PERSIST', 'RESULT'].map((t) => cl.constructor[t]).filter(Boolean);
      for (const s of this.shapes) for (const t of types) { try { cl.deleteListener(t, s); } catch {} }
    }
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
      const pa = a.__hwmpPuppet;
      const pb = b.__hwmpPuppet;
      if (!pa && !pb) return defaultFilter.ShouldCollide(a, b);
      if (pa && pb) return false;
      const p = pa || pb;
      const ps = pa ? a : b;
      const other = pa ? b : a;
      if (other.IsSensor?.() || other.m_isSensor || ps.m_isSensor) return false;
      if (opts.isLocalShape(other)) return opts.collisions();
      const ob = other.m_body;
      // Free (non network-driven) puppet parts may rest on static level geometry; nothing else.
      if (ob && ob.IsStatic() && !p.driven.has(ps.m_body)) return defaultFilter.ShouldCollide(a, b);
      return false;
    },
  };
}

export { Puppet };
