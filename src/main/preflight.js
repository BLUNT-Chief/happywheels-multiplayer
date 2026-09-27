'use strict';
// Checks the launcher runs before booting the game.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, encoding: 'utf8', timeout: 8000 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

async function processRunning(imageName) {
  if (process.platform !== 'win32') return false;
  const out = await run('tasklist.exe', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH']);
  return out.toLowerCase().includes(`"${imageName.toLowerCase()}"`);
}

async function countProcesses(imageName) {
  if (process.platform !== 'win32') return 0;
  const out = await run('tasklist.exe', ['/FI', `IMAGENAME eq ${imageName}`, '/FO', 'CSV', '/NH']);
  return out.toLowerCase().split('\n').filter((l) => l.includes(`"${imageName.toLowerCase()}"`)).length;
}

async function regDword(key, value) {
  const out = await run('reg.exe', ['query', key, '/v', value]);
  const m = out.match(/REG_DWORD\s+0x([0-9a-f]+)/i);
  return m ? parseInt(m[1], 16) : null;
}

/** { running, loggedIn } — ActiveUser is 0 while Steam is at the login screen. */
async function steamStatus() {
  const running = await processRunning('steam.exe');
  if (!running) return { running: false, loggedIn: false };
  const user = await regDword('HKCU\\Software\\Valve\\Steam\\ActiveProcess', 'ActiveUser');
  return { running: true, loggedIn: user == null ? true : user !== 0 };
}

/** The regular (non-multiplayer) game holds the same Steam app and save lock. */
function vanillaGameRunning() { return processRunning('Happy Wheels.exe'); }

// ---- small persisted settings (e.g. a manually located game folder) ----
function settingsFile(userDataDir) { return path.join(userDataDir, 'launcher-settings.json'); }

function loadSettings(userDataDir) {
  try { return JSON.parse(fs.readFileSync(settingsFile(userDataDir), 'utf8')) || {}; } catch { return {}; }
}

function saveSettings(userDataDir, settings) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(settingsFile(userDataDir), JSON.stringify(settings, null, 2));
  } catch {}
}

module.exports = { steamStatus, vanillaGameRunning, countProcesses, loadSettings, saveSettings };
