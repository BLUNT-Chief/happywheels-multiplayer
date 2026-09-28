// Runtime hooks into the game's (obfuscated) bundle via its webpack chunk array.
// Library code (Box2D, PIXI) lives in dependencies.js and is not obfuscated, so we
// identify classes by prototype shape instead of by (mangled) export names.

import { log } from './log.js';

const listeners = { world: [], preStep: [], postStep: [], render: [], libs: [] };
export const libs = { b2World: null, b2Body: null, b2Shape: null, PIXI: {}, webpackRequire: null, modules: new Map() };
export const state = { worlds: new Set(), stage: null, renderer: null, lastWorld: null };

export function on(evt, fn) {
  listeners[evt].push(fn);
  return () => { const i = listeners[evt].indexOf(fn); if (i >= 0) listeners[evt].splice(i, 1); };
}
function emit(evt, ...args) {
  for (const fn of listeners[evt]) {
    try { fn(...args); } catch (e) { log.error(`${evt} listener failed`, e); }
  }
}

function hasProto(fn, ...names) {
  if (typeof fn !== 'function' || !fn.prototype) return false;
  for (const n of names) if (typeof fn.prototype[n] !== 'function') return false;
  return true;
}

let stepSuppressed = () => false;
export function setStepGate(fn) { stepSuppressed = fn; }

function patchWorld(World) {
  if (libs.b2World) return;
  libs.b2World = World;
  const proto = World.prototype;
  const origStep = proto.Step;
  proto.Step = function (...args) {
    if (!state.worlds.has(this)) {
      state.worlds.add(this);
      emit('world', this);
    }
    state.lastWorld = this;
    if (stepSuppressed(this)) return undefined;
    emit('preStep', this, args);
    let r;
    try {
      r = origStep.apply(this, args);
    } catch (e) {
      // Box2D leaves the world locked if anything throws mid-step, after which every body
      // creation silently fails. Unlock so one bad callback can't break the session for good.
      this.m_lock = false;
      throw e;
    }
    emit('postStep', this, args);
    return r;
  };
  const origDestroy = proto.Destroy;
  if (origDestroy) {
    proto.Destroy = function (...args) {
      state.worlds.delete(this);
      if (state.lastWorld === this) state.lastWorld = null;
      return origDestroy.apply(this, args);
    };
  }
}

function patchRenderer(R) {
  if (R.prototype.__hwmpRender) return;
  R.prototype.__hwmpRender = true;
  const orig = R.prototype.render;
  R.prototype.render = function (obj, ...rest) {
    const opts = rest[0];
    // Only the main screen render (not render-to-texture passes).
    if (obj && !(opts && (opts.renderTexture || opts.baseTexture))) {
      state.stage = obj;
      state.renderer = this;
      emit('render', obj, this);
    }
    return orig.call(this, obj, ...rest);
  };
}

function collectPixi(k, v) {
  const P = libs.PIXI;
  if (hasProto(v, 'addChild', 'removeChild', 'getChildIndex', 'sortChildren')) {
    if (hasProto(v, 'calculateVertices') && v.from) P.Sprite ||= v;
    else if (hasProto(v, 'beginFill', 'drawRect')) P.Graphics ||= v;
    // The base Container is the class that itself defines addChild.
    else if (Object.prototype.hasOwnProperty.call(v.prototype, 'addChild')
      && !hasProto(Object.getPrototypeOf(v.prototype)?.constructor, 'addChild')) P.Container ||= v;
  } else if (hasProto(v, 'updateUvs', 'clone') && typeof v.from === 'function') P.Texture ||= v;
  else if (hasProto(v, 'render', 'resize', 'reset', 'clear')) { P.Renderer ||= v; patchRenderer(v); }
}

function inspectExports(exp) {
  if (!exp || (typeof exp !== 'object' && typeof exp !== 'function')) return;
  let keys;
  try { keys = Object.keys(exp); } catch { return; }
  if (keys.length > 2000) return;
  for (const k of keys) {
    let v;
    try { v = exp[k]; } catch { continue; }
    if (typeof v !== 'function') continue;
    if (hasProto(v, 'CreateBody', 'Step', 'DestroyBody')) patchWorld(v);
    else if (hasProto(v, 'SetXForm', 'GetLinearVelocity', 'GetUserData', 'GetShapeList')) libs.b2Body ||= v;
    else if (hasProto(v, 'SetFilterData', 'GetFilterData', 'GetBody')) libs.b2Shape ||= v;
    collectPixi(k, v);
  }
}

// ---- Access to the game's webpack modules ----------------------------------------------------------
// The game ships as webpack 5 chunks waiting on a global queue (an array with an obfuscated name),
// each one [chunkIds, { moduleId: factory }, runtime?]. We find that queue by its contents and add a
// probe chunk: when webpack processes a chunk it calls the chunk's runtime callback with its own
// require function. With that, every module factory webpack knows about is swapped for a traced
// copy, so each module's exports are inspected as the module loads, before the game uses them.

const PROBE_CHUNK_ID = 'hwmp-probe';
const tracedFactories = new WeakSet();
const attachedQueues = new WeakSet();

const isModuleTable = (t) => !!t && typeof t === 'object' && !Array.isArray(t)
  && Object.values(t).every((f) => typeof f === 'function');

const isQueuedChunk = (entry) => Array.isArray(entry) && entry.length >= 2 && Array.isArray(entry[0]) && isModuleTable(entry[1]);

function recordModule(id, module) {
  if (!module) return;
  libs.modules.set(id, module);
  try { inspectExports(module.exports); } catch {}
}

function traceFactory(id, factory) {
  if (typeof factory !== 'function' || tracedFactories.has(factory)) return factory;
  function traced(module, ...rest) {
    const result = Reflect.apply(factory, this, [module, ...rest]);
    recordModule(id, module);
    return result;
  }
  tracedFactories.add(traced);
  return traced;
}

function traceModuleTable(table) {
  for (const id of Object.keys(table)) table[id] = traceFactory(id, table[id]);
}

/** The probe chunk's runtime callback: webpack passes in its require function. */
function adoptRequire(req) {
  if (libs.webpackRequire || typeof req !== 'function') return;
  libs.webpackRequire = req;
  if (req.m) traceModuleTable(req.m);
  // If webpack was already running when we got here, some modules have loaded: look at those too.
  if (req.c) for (const [id, module] of Object.entries(req.c)) recordModule(id, module);
}

function attachToQueue(queue) {
  if (attachedQueues.has(queue)) return;
  attachedQueues.add(queue);
  for (const chunk of queue) traceModuleTable(chunk[1]);
  // Every push function assigned to the queue (webpack installs its own when it boots, keeping the
  // previous one to call on) is wrapped as it's assigned, so chunks arriving later are traced too.
  const tracing = (push) => function (...chunks) {
    for (const chunk of chunks) if (isQueuedChunk(chunk)) traceModuleTable(chunk[1]);
    return push.apply(this, chunks);
  };
  let push = tracing(queue.push);
  Object.defineProperty(queue, 'push', { configurable: true, get: () => push, set: (fn) => { push = tracing(fn); } });
  queue.push([[PROBE_CHUNK_ID], {}, adoptRequire]);
}

/** Attaches to the game's chunk queue(s). Returns their global names (empty if none were found). */
export function installHooks() {
  const names = Object.getOwnPropertyNames(self).filter((name) => {
    let value;
    try { value = self[name]; } catch { return false; }
    return Array.isArray(value) && value.length > 0 && value.every(isQueuedChunk);
  });
  for (const name of names) attachToQueue(self[name]);
  return names;
}

// Registry helpers for exploring/locating game modules at runtime.
export function allModuleIds() {
  const r = libs.webpackRequire;
  return r && r.m ? Object.keys(r.m) : [];
}
