'use strict';
// The launcher window: shows what the app is doing while it gets ready (updates, finding the
// game, Steam) and asks the player to fix problems instead of failing silently.

const path = require('node:path');
const { BrowserWindow, ipcMain, app } = require('electron');

const STEPS = [
  { id: 'update', label: 'Checking for updates' },
  { id: 'game', label: 'Finding Happy Wheels' },
  { id: 'link', label: "Setting up Steam's Play button" },
  { id: 'steam', label: 'Connecting to Steam' },
  { id: 'start', label: 'Starting the game' },
];

class Launcher {
  constructor({ version }) {
    this.state = { version, steps: STEPS.map((s) => ({ ...s, status: 'pending', detail: '' })), progress: null, message: null };
    this.win = null;
    this.pendingAsk = null;
    this.readyPromise = null;
    this.onAction = this.onAction.bind(this);
    this.onReady = this.onReady.bind(this);
  }

  open() {
    this.win = new BrowserWindow({
      width: 560,
      height: 460,
      resizable: false,
      maximizable: false,
      fullscreenable: false,
      frame: false,
      show: false,
      backgroundColor: '#141922',
      title: 'Happy Wheels Multiplayer',
      webPreferences: {
        preload: path.join(__dirname, '..', 'launcher', 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        devTools: !app.isPackaged,
        // Separate session: keeps the game's preload and https handling out of this window.
        partition: 'hwmp-launcher',
      },
    });
    this.win.__hwmpLauncher = true;
    this.win.once('ready-to-show', () => this.win && this.win.show());
    this.win.on('closed', () => {
      this.win = null;
      if (this.pendingAsk) { const r = this.pendingAsk; this.pendingAsk = null; r('quit'); }
    });
    ipcMain.on('launcher:action', this.onAction);
    ipcMain.on('launcher:ready', this.onReady);
    this.readyPromise = new Promise((resolve) => { this.resolveReady = resolve; });
    this.win.loadFile(path.join(__dirname, '..', 'launcher', 'index.html'));
    return this.readyPromise;
  }

  isSender(e) { return this.win && !this.win.isDestroyed() && e.sender === this.win.webContents; }

  onReady(e) {
    if (!this.isSender(e)) return;
    this.push();
    this.resolveReady();
  }

  onAction(e, id) {
    if (!this.isSender(e)) return;
    if (id === 'minimize') { this.win.minimize(); return; }
    if (id === 'quit' && !this.pendingAsk) { app.quit(); return; }
    if (this.pendingAsk) {
      const r = this.pendingAsk;
      this.pendingAsk = null;
      this.state.message = null;
      this.push();
      r(String(id));
    }
  }

  push() {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send('launcher:state', this.state);
  }

  step(id, status, detail = '') {
    const s = this.state.steps.find((x) => x.id === id);
    if (s) { s.status = status; s.detail = detail; }
    this.push();
  }

  progress(percent) { this.state.progress = percent; this.push(); }

  /** Shows a message with buttons and resolves with the id of the button pressed ('quit' if closed). */
  ask(message) {
    if (this.pendingAsk) this.pendingAsk('superseded');
    this.state.message = message;
    this.push();
    if (this.win && !this.win.isDestroyed()) { this.win.show(); this.win.focus(); }
    return new Promise((resolve) => { this.pendingAsk = resolve; });
  }

  /** Shows a message without waiting for a choice; cancelable by calling ask()/clearMessage(). */
  notice(message) { this.state.message = message; this.push(); }

  clearMessage() {
    if (this.pendingAsk) { const r = this.pendingAsk; this.pendingAsk = null; r('superseded'); }
    this.state.message = null;
    this.push();
  }

  close() {
    ipcMain.removeListener('launcher:action', this.onAction);
    ipcMain.removeListener('launcher:ready', this.onReady);
    const w = this.win;
    this.win = null;
    if (w && !w.isDestroyed()) w.destroy();
  }
}

module.exports = { Launcher };
