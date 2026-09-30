'use strict';
// Auto-update via electron-updater (GitHub Releases, configured in package.json "build.publish").
// At launch the launcher window checks first and installs a new version before the game starts,
// so friends stay on the same version. While playing, updates download in the background and the
// game offers "Restart now" (or installs on quit).

const { ipcMain, BrowserWindow } = require('electron');
const { autoUpdater } = require('electron-updater');

const CHECK_INTERVAL_MS = 30 * 60 * 1000;

function createUpdater({ isTrustedSender, log = console }) {
  let status = { state: 'idle' };
  const listeners = new Set();
  const set = (s) => {
    status = s;
    for (const fn of listeners) { try { fn(status); } catch {} }
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed() && !w.__hwmpLauncher) w.webContents.send('hwmp:update:status', status);
  };

  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableWebInstaller = true; // we publish the full installer, never a web installer
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ state: 'current' }));
  autoUpdater.on('update-available', (info) => set({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => set({ ...status, state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => { log.warn('[hwmp] update error', err && err.message); set({ state: 'error', message: String(err && err.message || err) }); });

  ipcMain.handle('hwmp:update:status', (e) => (isTrustedSender(e) ? status : null));
  ipcMain.on('hwmp:update:install', (e) => {
    if (isTrustedSender(e) && status.state === 'ready') setImmediate(() => autoUpdater.quitAndInstall(true, true));
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});

  return {
    get status() { return status; },

    /**
     * Resolves 'ready' when an update has been downloaded, or 'none' when there is nothing to
     * install right now (up to date, offline, check timed out, or `skip` resolved first).
     */
    checkBeforeLaunch({ onStatus, skip, checkTimeoutMs = 10000 }) {
      return new Promise((resolve) => {
        let done = false;
        const finish = (r) => { if (done) return; done = true; listeners.delete(onChange); clearTimeout(timer); resolve(r); };
        const onChange = (s) => {
          onStatus(s);
          if (s.state === 'ready') finish('ready');
          else if (s.state === 'current' || s.state === 'error') finish('none');
          else if (s.state === 'downloading') clearTimeout(timer); // a download is worth waiting for
        };
        listeners.add(onChange);
        const timer = setTimeout(() => finish('none'), checkTimeoutMs);
        if (skip) skip.then(() => finish('none'));
        check();
      });
    },

    installNow() { autoUpdater.quitAndInstall(true, true); },

    startBackground() { setInterval(check, CHECK_INTERVAL_MS).unref(); },
  };
}

module.exports = { createUpdater };
