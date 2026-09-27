'use strict';
// Happy Wheels Multiplayer (main process).
// Shows the launcher window, gets everything ready (updates, the Steam copy of Happy Wheels,
// Steam itself), then boots the player's own copy of the game inside this Electron runtime and
// adds the multiplayer layer. No game files are modified or redistributed.

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app, dialog, ipcMain, shell, BrowserWindow } = require('electron');
const { findGameDir, isGameDir } = require('./gameLocator');
const { bootGame, APP_PREFIX, GAME_HOSTS } = require('./gameHost');
const { SteamNet } = require('./steamNet');
const { registerNetIpc } = require('./netIpc');
const { initLog, log, captureWebContents } = require('./log');
const { Launcher } = require('./launcher');
const preflight = require('./preflight');
const steamLaunch = require('./steamLaunch');

const IS_DEV_BUILD = !app.isPackaged;
const DEV = IS_DEV_BUILD && process.argv.includes('--hwmp-dev');
const ENV = (k) => (IS_DEV_BUILD ? process.env[k] : undefined); // dev-only switches
const ROOT = path.join(__dirname, '..', '..');
const MOD_VERSION = app.getVersion();
const APP_TITLE = 'Happy Wheels Multiplayer';
const STEAM_APP_ID = 4705510;
const GAME_START_TIMEOUT_MS = 90000;

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

function vanillaRunningSync() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq Happy Wheels.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return out.toLowerCase().includes('"happy wheels.exe"');
  } catch {
    return false;
  }
}

/**
 * The game takes a single-instance lock on its own profile folder. Take it up front (restoring our
 * profile path afterwards) so a second copy of the mod quits quietly and hands focus to the first.
 */
function acquireGameLock(userDataDir) {
  app.setPath('userData', path.join(app.getPath('appData'), 'HappyWheels'));
  const got = app.requestSingleInstanceLock();
  app.setPath('userData', userDataDir);
  return got;
}

/**
 * Run by the uninstaller (not on updates): point Steam's Play button back at the normal game.
 * Steam overwrites its config while running, so it has to be closed for this.
 */
async function uninstallCleanup() {
  await app.whenReady();
  let closedSteam = false;
  for (;;) {
    const st = steamLaunch.status(process.execPath);
    const ours = (st.values || []).some((v) => v && v.toLowerCase().includes('happy wheels multiplayer.exe'));
    if (!ours) break;
    if (!(await steamLaunch.steamRunning())) {
      try { steamLaunch.apply(process.execPath, false); } catch (e) { log.error('[hwmp] could not restore Steam launch options', e); }
      break;
    }
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: APP_TITLE,
      message: 'Close Steam to finish uninstalling',
      detail: 'Happy Wheels in Steam is set to open Multiplayer. Steam has to be closed so it can be set back to the normal game.',
      buttons: ['Close Steam for me', 'Retry', 'Skip'],
      defaultId: 0,
      cancelId: 2,
    });
    if (choice === 2) break;
    if (choice === 0) closedSteam = await steamLaunch.shutdownSteam();
  }
  if (closedSteam) steamLaunch.startSteam();
  app.exit(0);
}

function main() {
  if (process.argv.includes('--hwmp-uninstall')) { uninstallCleanup(); return; }
  const profile = ENV('HWMP_PROFILE');
  const userDataDir = path.join(app.getPath('appData'), profile ? `HappyWheelsMP-${profile}` : 'HappyWheelsMP');
  app.setPath('userData', userDataDir); // before 'ready', so our browser profile is separate from the game's
  initLog(path.join(userDataDir, 'logs'));
  log.info(`[hwmp] ${APP_TITLE} ${MOD_VERSION} starting`);
  process.on('uncaughtException', (e) => log.error('[hwmp] uncaught', e));

  const multi = ENV('HWMP_MULTI') === '1';
  // If the regular game is open, the launcher explains that instead of the lock failing silently.
  let haveLock = multi;
  if (!multi && !vanillaRunningSync()) {
    haveLock = acquireGameLock(userDataDir);
    if (!haveLock) { app.quit(); return; } // another copy of the mod is already running
  }

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
  // Steam launch option that makes Steam start the mod instead of the vanilla game (overlay + invites).
  ipcMain.handle('hwmp:steamLaunchOption', (e) => (isTrustedSender(e) ? `"${process.execPath}" %command%` : null));
  ipcMain.on('hwmp:log', (e, level, message) => {
    if (!isTrustedSender(e)) return;
    const fn = level === 'error' ? log.error : level === 'warn' ? log.warn : log.info;
    fn(`[page] ${String(message).slice(0, 4000)}`);
  });
  ipcMain.on('hwmp:devFlags', (e) => {
    e.returnValue = { dev: DEV, modVersion: MOD_VERSION };
  });
  ipcMain.on('hwmp:openExternal', (e, url) => {
    if (!isTrustedSender(e)) return;
    try { if (new URL(url).protocol === 'https:') shell.openExternal(url); } catch {}
  });

  // Several local test instances: bypass the game's single-instance lock, keep background windows
  // simulating, and tile the game windows.
  if (multi) {
    app.requestSingleInstanceLock = () => true;
    app.commandLine.appendSwitch('disable-renderer-backgrounding');
    app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
    app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
    ipcMain.on('native:loaded', (e) => setTimeout(() => e.sender.setBackgroundThrottling(false), 0));
    const slot = Number(profile || 1) - 1;
    // HWMP_OFFSCREEN=1: automated tests run in windows parked off-screen that never take focus.
    const offscreen = ENV('HWMP_OFFSCREEN') === '1';
    const bounds = { x: (offscreen ? -3900 : 20) + slot * 950, y: 40, width: 940, height: 560 };
    app.on('browser-window-created', (_e, win) => {
      if (offscreen) {
        win.setBounds(bounds);
        win.show = () => win.showInactive();
        win.maximize = () => {};
        win.focus = () => {};
        win.setSkipTaskbar(true);
      }
      win.once('show', () => setTimeout(() => {
        if (win.__hwmpLauncher || win.isDestroyed()) return;
        win.unmaximize();
        win.setBounds(bounds);
      }, 300));
    });
  }

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
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });

  const updater = app.isPackaged ? require('./updater').createUpdater({ isTrustedSender, log }) : null;
  if (!updater) ipcMain.handle('hwmp:update:status', () => ({ state: 'dev' })); // keeps the in-game UI quiet in dev

  if (DEV) {
    app.on('render-process-gone', (_e, _wc, d) => console.error('[hwmp] renderer gone', d));
    app.on('child-process-gone', (_e, d) => console.error('[hwmp] child gone', d));
    process.on('exit', (c) => console.error('[hwmp] exit', c));
    require('./devBridge').startDevBridge(Number(ENV('HWMP_DEV_PORT') || 47800));
    global.__hwmpSteam = () => steamNet.client;
  }

  app.whenReady().then(() => launch({ userDataDir, updater, steamNet, haveLock, setTransport: (t) => { if (!transport) transport = t; } }))
    .catch((e) => {
      log.error('[hwmp] launch failed', e);
      dialog.showErrorBox(APP_TITLE, `Something went wrong while starting:\n\n${e && e.message}\n\nLog file: ${log.file || 'unavailable'}`);
      app.quit();
    });
}

/**
 * Sets Happy Wheels' Steam Launch Options to start this app. Steam must be closed to change them:
 * done silently when it already is, otherwise after asking once (restarts Steam).
 */
async function linkSteamPlayButton(ui, settings, userDataDir) {
  if (!app.isPackaged) { ui.step('link', 'done', 'Skipped (development build)'); return; }
  const exe = process.execPath;
  let st;
  try { st = steamLaunch.status(exe); } catch (e) { log.warn('[hwmp] steam link status failed', e); st = { state: 'unknown' }; }
  if (st.state === 'on') { ui.step('link', 'done', 'Pressing Play on Happy Wheels in Steam opens Multiplayer'); return; }
  if (st.state === 'unknown') { ui.step('link', 'warn', 'Steam install not found'); return; }
  if (settings.steamLink === 'never') { ui.step('link', 'done', 'Turned off'); return; }
  const custom = st.state === 'custom';
  const doApply = () => {
    const changed = steamLaunch.apply(exe, true, { replaceCustom: custom });
    log.info(`[hwmp] linked Steam's Play button (${changed.length} account(s))`);
    ui.step('link', 'done', 'Pressing Play on Happy Wheels in Steam now opens Multiplayer');
  };
  const running = await steamLaunch.steamRunning();
  if (!running && !custom) {
    try { doApply(); } catch (e) { log.error('[hwmp] steam link failed', e); ui.step('link', 'warn', 'Could not update Steam settings'); }
    return;
  }
  ui.step('link', 'active');
  const a = await ui.ask({
    kind: 'info',
    title: "Open Multiplayer from Steam's Play button?",
    text: (custom ? `Happy Wheels currently has your own Steam launch options (${(st.values || []).find((v) => v && v.trim()) || ''}). They would be replaced.\n` : '')
      + (running ? 'Then pressing Play on Happy Wheels in Steam starts Multiplayer, with Steam invites working. Steam has to restart once to save this (about 20 seconds).' : 'Then pressing Play on Happy Wheels in Steam starts Multiplayer, with Steam invites working.'),
    actions: [{ id: 'yes', label: running ? 'Set it up (restarts Steam)' : 'Set it up', primary: true }, { id: 'later', label: 'Not now' }, { id: 'never', label: "Don't ask again" }],
  });
  if (a === 'quit') { app.quit(); return; }
  if (a === 'never') { settings.steamLink = 'never'; preflight.saveSettings(userDataDir, settings); ui.step('link', 'done', 'Turned off'); return; }
  if (a !== 'yes') { ui.step('link', 'done', 'Not set up (you will be asked next time)'); return; }
  if (running) {
    ui.step('link', 'active', 'Closing Steam…');
    if (!(await steamLaunch.shutdownSteam())) { ui.step('link', 'warn', 'Steam did not close; try again next time'); return; }
  }
  try { doApply(); } catch (e) { log.error('[hwmp] steam link failed', e); ui.step('link', 'warn', 'Could not update Steam settings'); }
  if (running) { ui.step('link', 'done', 'Linked. Starting Steam again…'); steamLaunch.startSteam(); }
}

async function launch({ userDataDir, updater, steamNet, haveLock, setTransport }) {
  const ui = new Launcher({ version: MOD_VERSION });
  await ui.open();
  const settings = preflight.loadSettings(userDataDir);

  // 1. Updates: install before playing so everyone in a lobby runs the same version.
  if (updater) {
    ui.step('update', 'active');
    let skipResolve;
    const skip = new Promise((r) => { skipResolve = r; });
    const result = await updater.checkBeforeLaunch({
      skip,
      onStatus: (s) => {
        if (s.state === 'downloading') {
          ui.step('update', 'active', `Downloading version ${s.version || ''}… ${s.percent || 0}%`);
          ui.progress(s.percent || 0);
          if (!ui.state.message) {
            ui.ask({ kind: 'info', title: 'Updating', text: 'A new version is downloading. It will install and restart automatically.', actions: [{ id: 'skip', label: 'Play now, update later' }] })
              .then((a) => { if (a === 'skip') skipResolve(); });
          }
        }
      },
    });
    ui.progress(null);
    ui.clearMessage();
    if (result === 'ready') {
      ui.step('update', 'done', 'Installing the update — the game will restart by itself');
      log.info('[hwmp] installing update before launch');
      setTimeout(() => updater.installNow(), 1200);
      return;
    }
    const st = updater.status;
    ui.step('update', 'done', st.state === 'downloading' ? 'Will finish in the background' : st.state === 'error' ? 'Could not check (offline?) — continuing' : 'You have the latest version');
    updater.startBackground();
  } else {
    ui.step('update', 'done', 'Skipped (development build)');
  }

  // 2. Find the game.
  ui.step('game', 'active');
  const fake = ENV('HWMP_FAKE') || ''; // dev only: 'nogame', 'nosteam' preview the launcher's problem screens
  let gameDir = fake.includes('nogame') ? null : findGameDir(ENV('HWMP_GAME_DIR') || settings.gameDir);
  while (!gameDir) {
    ui.step('game', 'error', 'Not found');
    const a = await ui.ask({
      kind: 'error',
      title: 'Happy Wheels is not installed',
      text: 'This mod runs your own copy of Happy Wheels from Steam. Install it in Steam, then click Try again.\nIf it is installed somewhere unusual, choose its folder.',
      actions: [{ id: 'retry', label: 'Try again', primary: true }, { id: 'store', label: 'Open in Steam' }, { id: 'locate', label: 'Choose folder…' }, { id: 'quit', label: 'Quit' }],
    });
    if (a === 'quit') { app.quit(); return; }
    if (a === 'store') shell.openExternal(`steam://install/${STEAM_APP_ID}`);
    if (a === 'locate') {
      const r = await dialog.showOpenDialog(ui.win, { title: 'Select the Happy Wheels folder', properties: ['openDirectory'] });
      const dir = r.canceled ? null : r.filePaths[0];
      if (dir && isGameDir(dir)) { settings.gameDir = dir; preflight.saveSettings(userDataDir, settings); }
      else if (dir) await ui.ask({ kind: 'error', title: 'That is not the Happy Wheels folder', text: 'Pick the folder that contains "Happy Wheels.exe" (usually …\\steamapps\\common\\Happy Wheels).', actions: [{ id: 'ok', label: 'OK', primary: true }] });
    }
    ui.step('game', 'active');
    gameDir = findGameDir(ENV('HWMP_GAME_DIR') || settings.gameDir);
  }
  log.info(`[hwmp] game at ${gameDir}`);

  // The regular game and the mod can't run at the same time (same Steam app and save data).
  while (!haveLock && (await preflight.vanillaGameRunning())) {
    ui.step('game', 'warn', 'The regular Happy Wheels is open');
    const a = await ui.ask({
      kind: 'warn',
      title: 'Close the regular Happy Wheels first',
      text: 'The normal (single-player) Happy Wheels is running. Close it, then click Continue.\nTip: always start the game from the "Happy Wheels Multiplayer" shortcut to race with friends.',
      actions: [{ id: 'retry', label: 'Continue', primary: true }, { id: 'quit', label: 'Quit' }],
    });
    if (a === 'quit') { app.quit(); return; }
  }
  if (!haveLock && !acquireGameLock(userDataDir)) { app.quit(); return; }
  ui.step('game', 'done', gameDir);

  // Make Steam's Play button for Happy Wheels open the mod (installed builds only).
  await linkSteamPlayButton(ui, settings, userDataDir);

  // 3. Steam: required for lobbies; the game itself also works without it.
  ui.step('steam', 'active');
  let steamOk = false;
  let offline = false;
  for (;;) {
    const st = fake.includes('nosteam') ? { running: false, loggedIn: false } : await preflight.steamStatus();
    if (st.running && st.loggedIn) { steamOk = true; break; }
    ui.step('steam', 'warn', st.running ? 'Waiting for you to log in to Steam' : 'Steam is not running');
    let stop = false;
    const choice = ui.ask({
      kind: 'warn',
      title: st.running ? 'Log in to Steam' : 'Steam is not running',
      text: 'Multiplayer lobbies use Steam. Start Steam and log in; this continues automatically once it is ready.',
      actions: [...(st.running ? [] : [{ id: 'start', label: 'Start Steam', primary: true }]), { id: 'offline', label: 'Play without multiplayer' }, { id: 'quit', label: 'Quit' }],
    });
    choice.then(() => { stop = true; });
    // Poll until Steam is ready or the player picks something.
    while (!stop) {
      await new Promise((r) => setTimeout(r, 2000));
      const s2 = fake.includes('nosteam') ? st : await preflight.steamStatus();
      if (s2.running && s2.loggedIn) break;
      if (s2.running !== st.running) break; // state changed: refresh the message
    }
    if (!stop) { ui.clearMessage(); continue; }
    const a = await choice;
    if (a === 'quit') { app.quit(); return; }
    if (a === 'offline') { offline = true; break; }
    if (a === 'start') shell.openExternal('steam://open/main');
  }
  ui.step('steam', steamOk ? 'done' : 'warn', steamOk ? 'Ready' : offline ? 'Skipped — multiplayer is unavailable this session' : '');

  // 4. Boot the game and hand over to its window.
  ui.step('start', 'active', 'Loading Happy Wheels…');
  const gameShown = new Promise((resolve) => {
    app.on('browser-window-created', (_e, win) => {
      if (win.__hwmpLauncher) return;
      win.once('show', () => resolve(win));
    });
  });
  bootGame({
    gameDir,
    modWebDir: path.join(ROOT, 'out', 'web'),
    preloadPath: path.join(ROOT, 'src', 'preload', 'preload.js'),
    userDataDir,
    noSteam: ENV('HWMP_NO_STEAM') === '1',
    onSteamClient: (client) => {
      steamNet.attach(client);
      setTransport(steamNet);
    },
  });
  const win = await Promise.race([gameShown, new Promise((r) => setTimeout(() => r(null), GAME_START_TIMEOUT_MS))]);
  if (!win) {
    ui.step('start', 'error', 'The game did not open');
    const a = await ui.ask({
      kind: 'error',
      title: 'Happy Wheels did not start',
      text: `Try starting it again. If this keeps happening, send the log file to the mod's author:\n${log.file || ''}`,
      actions: [{ id: 'logs', label: 'Open log folder' }, { id: 'quit', label: 'Quit', primary: true }],
    });
    if (a === 'logs' && log.file) shell.showItemInFolder(log.file);
    app.quit();
    return;
  }
  ui.step('start', 'done');
  setTimeout(() => ui.close(), 400);
}

main();
