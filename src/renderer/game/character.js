// Character introspection shared by the local player (sampling) and remote puppets (applying).
//
// A "layout" is an ordered list of property paths ("chestBody", "girl.head1Body", "elves.2.chestBody")
// that resolve to Box2D bodies on a character. Two characters of the same class produce the
// same layout, so body state can be streamed as a flat array.
import { log } from '../log.js';

import { libs } from '../hooks.js';

export const MAX_BODIES = 60;

// Break/smash methods take only numbers/booleans, so they can be replayed on a puppet.
// Names come from the network, so this pattern is also the security whitelist.
const EVENT_METHOD = /^(?:[a-z][A-Za-z]*(?:Smash|Break)\d?|eject)$/;
export const isEventMethod = (name) => typeof name === 'string' && name.length < 40 && EVENT_METHOD.test(name);

const SKIP_KEYS = new Set(['paintVector', 'actionsVector', 'chunks', 'composites', 'voiceArray', 'magnetHeld', 'session', 'sourceObject', 'shapeGuide', 'listeners', 'parent', 'root', 'stage', 'userVehicle']);

function isBody(v) { return !!v && libs.b2Body && v instanceof libs.b2Body; }
function isCharLike(v) {
  return !!v && typeof v === 'object' && Array.isArray(v.paintVector) && isBody(v.chestBody) && typeof v.checkKeyStates === 'function';
}

/** Sub-characters (moped girl, dad's kid, elves...) as [path, character]. Includes the root as ''. */
export function characterTree(root) {
  const out = [['', root]];
  const seen = new Set([root]);
  for (const k of Object.keys(root)) {
    if (k.startsWith('_') || SKIP_KEYS.has(k)) continue;
    let v;
    try { v = root[k]; } catch { continue; }
    if (isCharLike(v) && !seen.has(v)) { seen.add(v); out.push([k, v]); }
    else if (Array.isArray(v)) {
      v.forEach((x, i) => { if (isCharLike(x) && !seen.has(x)) { seen.add(x); out.push([`${k}.${i}`, x]); } });
    }
  }
  return out;
}

export function resolvePath(root, path) {
  if (!path) return root;
  let o = root;
  for (const part of path.split('.')) {
    if (o == null) return null;
    o = o[part];
  }
  return o ?? null;
}

export function computeLayout(root) {
  const cands = [];
  for (const [prefix, ch] of characterTree(root)) {
    const pre = prefix ? `${prefix}.` : '';
    for (const k of Object.keys(ch)) {
      if (k.startsWith('_') || SKIP_KEYS.has(k)) continue;
      let v;
      try { v = ch[k]; } catch { continue; }
      if (isBody(v)) cands.push({ key: pre + k, body: v, prio: /Body$/.test(k) ? 0 : 1 });
      else if (Array.isArray(v) && v.length <= 32) {
        v.forEach((x, i) => { if (isBody(x)) cands.push({ key: `${pre}${k}.${i}`, body: x, prio: 2 }); });
      }
    }
  }
  cands.sort((a, b) => a.prio - b.prio || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const seen = new Set();
  const keys = [];
  for (const c of cands) {
    if (seen.has(c.body) || c.body.destroyed) continue;
    seen.add(c.body);
    keys.push(c.key);
    if (keys.length >= MAX_BODIES) break;
  }
  return keys;
}

export function bodiesOf(root, layout) {
  return layout.map((k) => {
    const b = resolvePath(root, k);
    return isBody(b) && !b.destroyed ? b : null;
  });
}

/** Writes x, y, angle, vx, vy, av per layout slot into `out` (NaN for missing bodies). */
export function sampleBodies(root, layout, out) {
  for (let i = 0; i < layout.length; i++) {
    const b = resolvePath(root, layout[i]);
    const o = i * 6;
    if (!isBody(b) || b.destroyed) { out[o] = NaN; continue; }
    const p = b.m_xf.position;
    const v = b.m_linearVelocity;
    out[o] = p.x; out[o + 1] = p.y; out[o + 2] = b.m_sweep.a;
    out[o + 3] = v.x; out[o + 4] = v.y; out[o + 5] = b.m_angularVelocity;
  }
  return out;
}

/**
 * Wraps whitelisted break/smash methods on a character tree (instance-level, so puppets of the
 * same class are unaffected). Only outermost calls are reported, since replaying those
 * reproduces the nested ones.
 */
export function hookCharacterEvents(root, onEvent) {
  let depth = 0;
  const restores = [];
  for (const [path, ch] of characterTree(root)) {
    const names = new Set();
    for (let p = Object.getPrototypeOf(ch); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const n of Object.getOwnPropertyNames(p)) if (isEventMethod(n) && typeof p[n] === 'function') names.add(n);
    }
    for (const name of names) {
      const had = Object.prototype.hasOwnProperty.call(ch, name);
      const prev = ch[name];
      ch[name] = function (...args) {
        const top = depth === 0;
        depth++;
        let r;
        try { r = prev.apply(this, args); } finally { depth--; }
        if (top && args.length <= 4 && args.every((a) => a === undefined || typeof a === 'number' || typeof a === 'boolean')) {
          try { onEvent(path, name, args); } catch (e) { log.error('event hook', e); }
        }
        return r;
      };
      restores.push(() => { if (had) ch[name] = prev; else delete ch[name]; });
    }
  }
  return () => restores.forEach((f) => f());
}
