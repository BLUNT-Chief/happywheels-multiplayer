// Locates game classes and singletons by their shape (method/field names), never by
// webpack module id, so small game updates don't break the mod.

import { libs } from '../hooks.js';

const cache = new Map();

function* exportsOf() {
  for (const mod of libs.modules.values()) {
    const exp = mod && mod.exports;
    if (!exp || (typeof exp !== 'object' && typeof exp !== 'function')) continue;
    let keys;
    try { keys = Object.keys(exp); } catch { continue; }
    for (const k of keys) {
      let v;
      try { v = exp[k]; } catch { continue; }
      if (v) yield v;
    }
  }
}

function protoHas(fn, names) {
  if (typeof fn !== 'function' || !fn.prototype) return false;
  return names.every((n) => n in fn.prototype);
}

// names[0] must be defined by the class itself (not inherited), which picks the base class
// over subclasses that merely inherit the same methods.
function findClass(key, names) {
  if (cache.has(key)) return cache.get(key);
  for (const v of exportsOf()) {
    if (protoHas(v, names) && Object.prototype.hasOwnProperty.call(v.prototype, names[0])) { cache.set(key, v); return v; }
  }
  return null;
}

function findStatic(key, pred) {
  if (cache.has(key)) return cache.get(key);
  for (const v of exportsOf()) {
    try { if (pred(v)) { cache.set(key, v); return v; } } catch {}
  }
  return null;
}

export const Game = {
  /** Global settings singleton (static class): currentSession, characterIndex, ... */
  get Settings() {
    return findStatic('Settings', (v) => typeof v === 'function' && 'CURRENT_VERSION' in v && 'characterIndex' in v && 'characterNames' in v);
  },
  get Session() { return findClass('Session', ['setupCharacter', 'levelComplete', 'run30fps', 'run60fps', 'getStartPoint']); },
  get SessionController() { return findClass('SessionController', ['restartLevel', 'returnToMainMenu', 'beginSession', 'loadSession']); },
  /** Loads level + character art; we reuse it to build art for remote players' characters. */
  get ContentLoader() { return findClass('ContentLoader', ['loadCharacterData', 'dataLoaded', 'characterData']); },
  /** The game's level record (decodes names, ratings, forced character like the game does). */
  get LevelData() { return findClass('LevelData', ['getAverageRating', 'dateFromString', 'forceChar']); },
  get CharacterBase() { return findClass('CharacterBase', ['trackDeath', 'checkKeyStates', 'checkReplayData', 'addKeyListeners']); },
  /** Module object that App.init decorates with featuredLevels(). */
  get FeaturedLevels() {
    return findStatic('FeaturedLevels', (v) => typeof v === 'function' && typeof v.featuredLevels === 'function' && 'levelBeaten' in v);
  },

  get session() { return this.Settings?.currentSession || null; },

  /** The App instance (owns main menu / session controller / editor). */
  get app() {
    const S = this.Settings;
    let p = S && S.debugText;
    for (let i = 0; p && i < 8; i++, p = p.parent) {
      if (typeof p.openDeepLink === 'function') return p;
    }
    return null;
  },
};
