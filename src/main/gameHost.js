'use strict';
// Boots the unmodified Happy Wheels main process (from the user's Steam install)
// inside our Electron runtime, with a few runtime interceptions:
//   - webroot is served from the Steam install folder
//   - steamworks "restart through Steam" is skipped and the client is captured
//   - our renderer bundle is injected into the game page
//   - our preload (window.hwmp bridge) is registered alongside the game's own
// Nothing in the game install is modified.

const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const { log } = require('./log');

const GAME_HOSTS = new Set(['totaljerkface.com', 'www.totaljerkface.com', 'beta.totaljerkface.com']);
const APP_PREFIX = '/__hw_app__/';
const MOD_PREFIX = `${APP_PREFIX}__hwmp__/`;

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function injectIntoHtml(html) {
  const tag = '<script src="./__hwmp__/inject.js"></script>';
  // Must run after dependencies.js (libraries) and before index.js (game).
  const re = /<script[^>]*src="[^"]*js\/index\.js"[^>]*>/i;
  if (re.test(html)) return html.replace(re, (m) => tag + m);
  log.warn('[hwmp] game page layout changed; injecting at <body>');
  // Unknown layout: inject as early as possible; inject.js copes with running before the libraries.
  return html.replace(/<body[^>]*>/i, (m) => m + tag);
}

/**
 * @param {object} opts
 * @param {string} opts.gameDir       Steam install folder
 * @param {string} opts.modWebDir     folder with our built renderer files (inject.js, ...)
 * @param {string} opts.preloadPath   our preload script
 * @param {string} opts.userDataDir   profile folder for the mod (kept separate from the real game)
 * @param {(client: any, steamworks: any) => void} opts.onSteamClient
 * @param {boolean} [opts.noSteam]      dev only: run without Steam (second local test instance)
 */
function bootGame(opts) {
  const { gameDir, modWebDir, preloadPath, userDataDir, onSteamClient, noSteam } = opts;
  const { app, protocol, session } = electron;

  const resources = path.join(gameDir, 'resources');
  const asarRoot = path.join(resources, 'app.asar');
  const pkg = JSON.parse(fs.readFileSync(path.join(asarRoot, 'package.json'), 'utf8'));
  const gameMain = path.join(asarRoot, pkg.main || 'electron/out/main.js');

  // --- steamworks: skip RestartAppIfNecessary (would relaunch the vanilla game) and capture the client.
  const steamworksPath = require.resolve('steamworks.js', { paths: [path.dirname(gameMain)] });
  const steamworks = require(steamworksPath);
  const origInit = steamworks.init;
  steamworks.restartAppIfNecessary = () => false;
  steamworks.init = (appId) => {
    if (noSteam) throw new Error("Steam disabled for this instance");
    const client = origInit(appId);
    try { onSteamClient(client, steamworks); } catch (e) { console.error('[hwmp] onSteamClient failed', e); }
    return client;
  };

  // --- protocol: serve our files and inject our script into the game page.
  const origHandle = protocol.handle.bind(protocol);
  protocol.handle = (scheme, handler) => {
    if (scheme !== 'https') return origHandle(scheme, handler);
    return origHandle(scheme, async (req) => {
      let url = null;
      try { url = new URL(req.url); } catch {}
      if (url && GAME_HOSTS.has(url.hostname) && url.pathname.startsWith(MOD_PREFIX)) {
        return serveModFile(modWebDir, decodeURIComponent(url.pathname.slice(MOD_PREFIX.length)));
      }
      const res = await handler(req);
      if (url && GAME_HOSTS.has(url.hostname) && url.pathname === `${APP_PREFIX}index.html` && res.ok) {
        const html = injectIntoHtml(await res.text());
        const headers = new Headers(res.headers);
        headers.delete('content-length');
        return new Response(html, { status: res.status, headers });
      }
      return res;
    });
  };

  // --- our preload runs next to the game's preload in every game frame.
  app.whenReady().then(() => {
    const ses = session.defaultSession;
    if (typeof ses.registerPreloadScript === 'function') {
      ses.registerPreloadScript({ type: 'frame', id: 'hwmp-preload', filePath: preloadPath });
    } else {
      ses.setPreloads([...ses.getPreloads(), preloadPath]);
    }
  });

  // --- load the game's main process with its resources path pointed at the Steam install.
  const desc = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true, writable: true, enumerable: true });
  try {
    require(gameMain);
  } finally {
    if (desc) Object.defineProperty(process, 'resourcesPath', desc);
  }
  // The game points userData at the vanilla profile; keep ours separate (safe across Chromium versions).
  app.setPath('userData', userDataDir);

  return { gameVersion: pkg.version, steamworks };
}

async function serveModFile(root, rel) {
  const base = path.resolve(root);
  const file = path.resolve(base, rel);
  if (file !== base && !file.startsWith(base + path.sep)) return new Response('Forbidden', { status: 403 });
  try {
    const data = await fs.promises.readFile(file);
    return new Response(data, {
      headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' },
    });
  } catch (e) {
    log.error('[hwmp] could not serve mod file', rel, e && e.message);
    return new Response('Not found', { status: 404 });
  }
}

module.exports = { bootGame, GAME_HOSTS, APP_PREFIX };
