// Runtime hooks into the game's (obfuscated) bundle via its webpack chunk array.
// Library code (Box2D, PIXI) lives in dependencies.js and is not obfuscated, so we
// identify classes by prototype shape instead of by (mangled) export names.

const listeners = { world: [], preStep: [], postStep: [], render: [], libs: [] };
export const libs = { b2World: null, b2Body: null, b2Shape: null, PIXI: {}, webpackRequire: null, modules: new Map() };
export const state = { worlds: new Set(), stage: null, renderer: null, lastWorld: null };

export function on(evt, fn) {
  listeners[evt].push(fn);
  return () => { const i = listeners[evt].indexOf(fn); if (i >= 0) listeners[evt].splice(i, 1); };
}
function emit(evt, ...args) {
  for (const fn of listeners[evt]) {
    try { fn(...args); } catch (e) { console.error(`[hwmp] ${evt} listener failed`, e); }
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
    const r = origStep.apply(this, args);
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

function wrapFactory(id, factory) {
  if (typeof factory !== 'function' || factory.__hwmp) return factory;
  const wrapped = function (module, exports, require) {
    if (require && !libs.webpackRequire) {
      libs.webpackRequire = require;
      // Wrap every factory (including the game's own modules) so we can reach their exports later.
      if (require.m) for (const mid of Object.keys(require.m)) require.m[mid] = wrapFactory(mid, require.m[mid]);
    }
    const r = factory.call(this, module, exports, require);
    if (module) libs.modules.set(id, module);
    try { inspectExports(module && module.exports); } catch {}
    return r;
  };
  wrapped.__hwmp = true;
  return wrapped;
}

function wrapChunk(chunk) {
  if (!Array.isArray(chunk) || !chunk[1] || typeof chunk[1] !== 'object') return;
  const mods = chunk[1];
  for (const id of Object.keys(mods)) mods[id] = wrapFactory(id, mods[id]);
}

function isChunkArray(v) {
  return Array.isArray(v) && v.length > 0 && Array.isArray(v[0]) && Array.isArray(v[0][0]) && v[0][1] && typeof v[0][1] === 'object';
}

function hookChunkArray(arr) {
  if (arr.__hwmp) return;
  Object.defineProperty(arr, '__hwmp', { value: true });
  arr.forEach(wrapChunk);
  // The webpack runtime replaces push() when it boots; keep wrapping lazily-pushed chunks.
  let realPush = arr.push;
  Object.defineProperty(arr, 'push', {
    configurable: true,
    get() {
      // Capture the current target: webpack binds the old push as its "parent" before replacing it.
      const target = realPush;
      return function (...chunks) { chunks.forEach(wrapChunk); return target.apply(arr, chunks); };
    },
    set(fn) { realPush = fn; },
  });
}

export function installHooks() {
  const found = [];
  for (const k of Object.getOwnPropertyNames(self)) {
    let v;
    try { v = self[k]; } catch { continue; }
    if (isChunkArray(v)) { hookChunkArray(v); found.push(k); }
  }
  return found;
}

// Registry helpers for exploring/locating game modules at runtime.
export function allModuleIds() {
  const r = libs.webpackRequire;
  return r && r.m ? Object.keys(r.m) : [];
}
