// Injected into the game page between the library bundle and the game bundle.
import { log } from './log.js';
import { installHooks, libs, state, on } from './hooks.js';
import { installDevCapture } from './devCapture.js';
import { initBridge, bridge } from './game/bridge.js';
import { Game } from './game/locate.js';
import { Multiplayer } from './net/race.js';
import { createOverlay } from './ui/overlay.js';

const tx = window.hwmp;

/* global __DEV__ */
if (__DEV__ && tx?.devCapture) installDevCapture();

// Must happen synchronously, before the game bundle boots.
const chunkGlobals = installHooks();
if (!chunkGlobals.length) log.warn('webpack chunk array not found; the game layout may have changed');

const ATTACH_TIMEOUT_MS = 45000;

/** Shown when a Happy Wheels update changed something the mod depends on. The game still works. */
function showIncompatible() {
  const el = document.createElement('div');
  el.textContent = 'Multiplayer could not start with this version of Happy Wheels. A mod update should fix it soon; the game itself works normally.';
  el.style.cssText = 'position:fixed;right:12px;top:44px;max-width:360px;z-index:2147483000;padding:10px 14px;border-radius:10px;background:rgba(18,22,30,.94);color:#f4f6fb;font:13px Helvetica,Arial,sans-serif;border:1px solid rgba(255,120,120,.6)';
  document.body.append(el);
  setTimeout(() => el.remove(), 20000);
}

async function boot() {
  const attached = await Promise.race([initBridge().then(() => true), new Promise((r) => setTimeout(() => r(false), ATTACH_TIMEOUT_MS))]);
  if (!attached) {
    log.error('could not attach to the game: game classes not found (Happy Wheels probably updated)');
    showIncompatible();
    return;
  }
  const mp = new Multiplayer(tx, bridge);
  const overlay = createOverlay(mp, bridge, tx);
  overlay.setRendererGetter(() => state.renderer);
  await mp.start();
  if (__DEV__ && tx?.dev) window.__hwmp = { libs, state, on, bridge, mp, Game, overlay };
  log.info('ready');
}

if (!tx) {
  log.error('native bridge missing; multiplayer disabled');
} else if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => boot().catch((e) => log.error('boot failed', e)));
} else {
  boot().catch((e) => log.error('boot failed', e));
}
