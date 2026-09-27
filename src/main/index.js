'use strict';
// Happy Wheels Multiplayer launcher (main process).
// Boots the player's own Steam copy of Happy Wheels inside this Electron runtime and adds the
// multiplayer layer. No game files are modified or redistributed.

const path = require('node:path');
const { app, dialog, ipcMain, shell } = require('electron');
const { findGameDir } = require('./gameLocator');
const { bootGame, APP_PREFIX, GAME_HOSTS } = require('./gameHost');
const { SteamNet } = require('./steamNet');
const { registerNetIpc } = require('./netIpc');
const { initLog, log, captureWebContents } = require('./log');

const IS_DEV_BUILD = !app.isPackaged;
const DEV = IS_DEV_BUILD && process.argv.includes('--hwmp-dev');
const ENV = (k) => (IS_DEV_BUILD ? process.env[k] : undefined); // dev-only switches
const ROOT = path.join(__dirname, '..', '..');
const MOD_VERSION = app.getVersion();
const APP_TITLE = 'Happy Wheels Multiplayer';

function isTrustedSender(e) {
  const url = e.senderFrame && e.senderFrame.url;
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && GAME_HOSTS.has(u.hostname) && u.pathname.startsWith(APP_PREFIX);
  } catch {
    return false;
  }
}

/** Steam passes lobby invites as '+connect_lobby <id>' when it launches the game. */
function lobbyFromArgv(argv) {
  const i = argv.indexOf('+connect_lobby');
  const id = i >= 0 ? String(argv[i + 1] || '') : '';
  return /^\d{15,20}$/.test(id) ? id : null;
}

function fail(message) {
  app.whenReady().then(() => {
    dialog.showErrorBox(APP_TITLE, message);
    app.quit();
  });
}

function main() {
  const gameDir = findGameDir(ENV('HWMP_GAME_DIR'));
  if (!gameDir) {
    fail('Could not find Happy Wheels.\n\nInstall Happy Wheels from Steam, then start Happy Wheels Multiplayer again.');
    return;
  }

  const profile = ENV('HWMP_PROFILE');
  const userDataDir = path.join(app.getPath('appData'), profile ? `HappyWheelsMP-${profile}` : 'HappyWheelsMP');
  initLog(path.join(userDataDir, 'logs'));
  log.info(`[hwmp] ${APP_TITLE} ${MOD_VERSION} starting; game at ${gameDir}`);
  process.on('uncaughtException', (e) => log.error('[hwmp] uncaught', e));

  // Transport: Steam lobbies + P2P (default) or the localhost relay for multi-instance testing.
  let transport = null;
  const steamNet = new SteamNet({ modVersion: MOD_VERSION });
  if (ENV('HWMP_LOCAL_NET') === '1') {
    const { LocalNet } = require('./localNet');
    const local = new LocalNet({ name: ENV('HWMP_NAME') });
    local.connect().then(() => { transport = local; }).catch((e) => console.error('[hwmp] local net failed', e));
  }
  registerNetIpc(() => transport, isTrustedSender);

  ipcMain.handle('hwmp:version', () => MOD_VERSION);
  ipcMain.on('hwmp:log', (e, level, message) => {
    if (!isTrustedSender(e)) return;
    const fn = level === 'error' ? log.error : level === 'warn' ? log.warn : log.info;
    fn(`[page] ${String(message).slice(0, 4000)}`);
  });
  ipcMain.on('hwmp:devFlags', (e) => {
    e.returnValue = { dev: DEV, capture: DEV && ENV('HWMP_CAPTURE') === '1', modVersion: MOD_VERSION };
  });
  ipcMain.on('hwmp:openExternal', (e, url) => {
    if (!isTrustedSender(e)) return;
    try { if (new URL(url).protocol === 'https:') shell.openExternal(url); } catch {}
  });

  // Several local test instances: bypass the game's single-instance lock, keep background windows
  // simulating, and tile the windows.
  if (ENV('HWMP_MULTI') === '1') {
    app.requestSingleInstanceLock = () => true;
    app.commandLine.appendSwitch('disable-renderer-backgrounding');
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
    ipcMain.on('native:loaded', (e) => setTimeout(() => e.sender.setBackgroundThrottling(false), 0));
    const slot = Number(profile || 1) - 1;
    app.on('browser-window-created', (_e, win) => win.once('show', () => setTimeout(() => {
      win.unmaximize();
      win.setBounds({ x: 20 + slot * 950, y: 40, width: 940, height: 560 });
    }, 300)));
  }

  bootGame({
    gameDir,
    modWebDir: path.join(ROOT, 'out', 'web'),
    preloadPath: path.join(ROOT, 'src', 'preload', 'preload.js'),
    userDataDir,
    noSteam: ENV('HWMP_NO_STEAM') === '1',
    onSteamClient: (client) => {
      steamNet.attach(client);
      if (!transport) transport = steamNet;
    },
  });

  app.on('browser-window-created', (_e, win) => {
    captureWebContents(win.webContents);
    win.setTitle(APP_TITLE);
    win.on('page-title-updated', (ev) => ev.preventDefault());
  });
  app.on('will-quit', () => steamNet.shutdown());
  const launchLobby = lobbyFromArgv(process.argv);
  if (launchLobby) steamNet.pendingInvite = launchLobby;
  app.on('second-instance', (_e, argv) => {
    const id = lobbyFromArgv(argv);
    if (id) steamNet.emit('hwmp:lobby:inviteAccepted', id);
  });

  if (app.isPackaged) {
    app.whenReady().then(() => require('./updater').initUpdater({ isTrustedSender, log }));
  }
  if (!app.isPackaged) {
    // The updater only runs in installed builds; answer its IPC so the UI stays quiet in dev.
    ipcMain.handle('hwmp:update:status', () => ({ state: 'dev' }));
  }
  if (DEV) {
    app.on('render-process-gone', (_e, _wc, d) => console.error('[hwmp] renderer gone', d));
    app.on('child-process-gone', (_e, d) => console.error('[hwmp] child gone', d));
    process.on('exit', (c) => console.error('[hwmp] exit', c));
    require('./devBridge').startDevBridge(Number(ENV('HWMP_DEV_PORT') || 47800));
    global.__hwmpSteam = () => steamNet.client;
  }
}

main();
