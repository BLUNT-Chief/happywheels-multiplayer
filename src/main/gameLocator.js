'use strict';
// Finds the Steam install of Happy Wheels (app 4705510) without any native deps.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const APP_ID = 4705510;

function regQuery(key, value) {
  try {
    const out = execFileSync('reg.exe', ['query', key, '/v', value], { encoding: 'utf8', windowsHide: true });
    const m = out.match(new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`));
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function steamRoots() {
  const roots = [];
  if (process.platform === 'win32') {
    roots.push(regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath'));
    roots.push(regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'));
    roots.push(regQuery('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'));
    roots.push('C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam');
  } else {
    const home = process.env.HOME || '';
    roots.push(path.join(home, '.steam', 'steam'), path.join(home, '.local', 'share', 'Steam'));
  }
  return [...new Set(roots.filter(Boolean).map((p) => path.normalize(p)))];
}

// Minimal parser for Valve's KeyValues text format (libraryfolders.vdf / appmanifest).
function parseVdf(text) {
  const tokens = [];
  const re = /"((?:[^"\\]|\\.)*)"|([{}])/g;
  let m;
  while ((m = re.exec(text))) tokens.push(m[2] ?? m[1].replace(/\\\\/g, '\\'));
  let i = 0;
  function obj() {
    const o = {};
    while (i < tokens.length) {
      const k = tokens[i++];
      if (k === '}') return o;
      const v = tokens[i++];
      o[k] = v === '{' ? obj() : v;
    }
    return o;
  }
  return obj();
}

function libraryFolders(root) {
  const libs = [root];
  try {
    const vdf = parseVdf(fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8'));
    const lf = vdf.libraryfolders || vdf.LibraryFolders || {};
    for (const entry of Object.values(lf)) {
      if (entry && typeof entry === 'object' && entry.path) libs.push(path.normalize(entry.path));
      else if (typeof entry === 'string' && /[\\/]/.test(entry)) libs.push(path.normalize(entry));
    }
  } catch {}
  return libs;
}

function isGameDir(dir) {
  try {
    // Under Electron an .asar archive looks like a directory, so only check existence.
    return fs.existsSync(path.join(dir, 'resources', 'app.asar'))
      && fs.statSync(path.join(dir, 'resources', 'webroot', 'js', 'index.js')).isFile();
  } catch {
    return false;
  }
}

/** @returns {string|null} absolute path of the Happy Wheels install folder */
function findGameDir(overridePath) {
  if (overridePath && isGameDir(overridePath)) return overridePath;
  for (const root of steamRoots()) {
    for (const lib of libraryFolders(root)) {
      const manifest = path.join(lib, 'steamapps', `appmanifest_${APP_ID}.acf`);
      let installDir = 'Happy Wheels';
      try {
        installDir = parseVdf(fs.readFileSync(manifest, 'utf8')).AppState?.installdir || installDir;
      } catch {}
      const dir = path.join(lib, 'steamapps', 'common', installDir);
      if (isGameDir(dir)) return dir;
    }
  }
  return null;
}

module.exports = { APP_ID, findGameDir, isGameDir, parseVdf };
