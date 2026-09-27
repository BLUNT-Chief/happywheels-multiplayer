// Injected into the game page between the library bundle and the game bundle.
import { installHooks, libs, state, on } from './hooks.js';
import { installDevCapture } from './devCapture.js';
import { initBridge, bridge } from './game/bridge.js';
import { Game } from './game/locate.js';
import { Multiplayer } from './net/race.js';
import { createOverlay } from './ui/overlay.js';

const tx = window.hwmp;

if (tx?.devCapture) installDevCapture();

// Must happen synchronously, before the game bundle boots.
const chunkGlobals = installHooks();
if (!chunkGlobals.length) console.warn('[hwmp] webpack chunk array not found; the game layout may have changed');

async function boot() {
  await initBridge();
  const mp = new Multiplayer(tx, bridge);
  const overlay = createOverlay(mp, bridge, tx);
  overlay.setRendererGetter(() => state.renderer);
  await mp.start();
  if (tx?.dev) window.__hwmp = { libs, state, on, bridge, mp, Game, overlay };
  console.log('[hwmp] ready');
}

if (!tx) {
  console.error('[hwmp] native bridge missing; multiplayer disabled');
} else if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => boot().catch((e) => console.error('[hwmp] boot failed', e)));
} else {
  boot().catch((e) => console.error('[hwmp] boot failed', e));
}
