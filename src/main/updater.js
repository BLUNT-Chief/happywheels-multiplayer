'use strict';
// Auto-update via electron-updater (GitHub Releases, configured in package.json "build.publish").
// Updates download in the background; players get a "Restart now" prompt in-game and the update
// is otherwise applied automatically the next time they quit.

const { ipcMain, BrowserWindow } = require('electron');
const { autoUpdater } = require('electron-updater');

const CHECK_INTERVAL_MS = 30 * 60 * 1000;

function initUpdater({ isTrustedSender, log = console }) {
  let status = { state: 'idle' };
  const set = (s) => {
    status = s;
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('hwmp:update:status', status);
  };

  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }));
  autoUpdater.on('update-not-available', () => set({ state: 'current' }));
  autoUpdater.on('update-available', (info) => set({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => set({ ...status, state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => { log.warn?.('[hwmp] update error', err && err.message); set({ state: 'error', message: String(err && err.message || err) }); });

  ipcMain.handle('hwmp:update:status', (e) => (isTrustedSender(e) ? status : null));
  ipcMain.on('hwmp:update:install', (e) => {
    if (isTrustedSender(e) && status.state === 'ready') setImmediate(() => autoUpdater.quitAndInstall(false, true));
  });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 5000);
  setInterval(check, CHECK_INTERVAL_MS).unref();
}

module.exports = { initUpdater };
