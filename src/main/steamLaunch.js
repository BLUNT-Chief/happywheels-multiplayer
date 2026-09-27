'use strict';
// Makes Steam's Play button for Happy Wheels start the multiplayer mod, by setting the game's
// Launch Options (Steam -> Happy Wheels -> Properties) to  "<mod exe>" %command%.
//
// Steam keeps these in userdata/<account>/config/localconfig.vdf and rewrites that file from
// memory when it exits, so edits only stick while Steam is closed. The edit is surgical: only the
// one value changes, everything else in the file stays byte-for-byte identical.

const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { steamRoots, parseVdf } = require('./gameLocator');

const APP_ID = '4705510';
const OUR_EXE = 'Happy Wheels Multiplayer.exe';
const CONFIG_PATH = ['UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps'];

// ---- VDF with source positions ------------------------------------------------------------------

function tokenize(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '{' || c === '}') { tokens.push({ type: c, start: i, end: i + 1 }); i++; continue; }
    if (c === '"') {
      const start = i;
      let value = '';
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const e = text[i + 1];
          value += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
        } else {
          value += text[i++];
        }
      }
      if (i >= n) throw new Error('unterminated string in VDF');
      i++;
      tokens.push({ type: 'str', value, start, end: i });
      continue;
    }
    // Unquoted token (or a [$CONDITION] tag).
    const start = i;
    while (i < n && !/[\s{}"]/.test(text[i])) i++;
    const value = text.slice(start, i);
    if (value.startsWith('[')) continue;
    tokens.push({ type: 'str', value, start, end: i });
  }
  return tokens;
}

/** Nodes: { key, keyTok, value?: token, open?: token, close?: token, children?: [] } */
function parsePositions(text) {
  const tokens = tokenize(text);
  let p = 0;
  function block(closing) {
    const children = [];
    while (p < tokens.length) {
      const t = tokens[p];
      if (t.type === '}') {
        if (!closing) throw new Error('unexpected } in VDF');
        return { children, close: t };
      }
      if (t.type !== 'str') throw new Error('expected key in VDF');
      p++;
      const v = tokens[p++];
      if (!v) throw new Error('missing value in VDF');
      if (v.type === '{') {
        const inner = block(true);
        p++; // consume }
        children.push({ key: t.value, keyTok: t, open: v, close: inner.close, children: inner.children });
      } else if (v.type === 'str') {
        children.push({ key: t.value, keyTok: t, value: v });
      } else {
        throw new Error('unexpected } after key in VDF');
      }
    }
    if (closing) throw new Error('unterminated block in VDF');
    return { children };
  }
  return block(false).children;
}

const findChild = (children, key) => children && children.find((c) => c.children && c.key.toLowerCase() === key.toLowerCase());
const escapeVdf = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function lineStart(text, pos) { const i = text.lastIndexOf('\n', pos - 1); return i + 1; }
function indentOf(text, pos) { return text.slice(lineStart(text, pos), pos).match(/^[\t ]*/)[0]; }

function locate(text) {
  let node = { children: parsePositions(text) };
  for (const key of CONFIG_PATH) {
    node = findChild(node.children, key);
    if (!node) return { apps: null, app: null };
  }
  return { apps: node, app: findChild(node.children, APP_ID) };
}

function readLaunchOptions(text) {
  const { app } = locate(text);
  const opt = app && app.children.find((c) => !c.children && c.key.toLowerCase() === 'launchoptions');
  return opt ? opt.value.value : '';
}

/** Returns the edited text (only the LaunchOptions value for our app changes). */
function withLaunchOptions(text, value) {
  const { apps, app } = locate(text);
  if (!apps) throw new Error('Steam config has no apps section');
  const quoted = `"${escapeVdf(value)}"`;
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  if (app) {
    const opt = app.children.find((c) => !c.children && c.key.toLowerCase() === 'launchoptions');
    if (opt) return text.slice(0, opt.value.start) + quoted + text.slice(opt.value.end);
    if (!value) return text;
    const ind = `${indentOf(text, app.keyTok.start)}\t`;
    const at = app.open.end;
    return `${text.slice(0, at)}${nl}${ind}"LaunchOptions"\t\t${quoted}${text.slice(at)}`;
  }
  if (!value) return text;
  const ind = `${indentOf(text, apps.keyTok.start)}\t`;
  const at = lineStart(text, apps.close.start);
  const blockText = `${ind}"${APP_ID}"${nl}${ind}{${nl}${ind}\t"LaunchOptions"\t\t${quoted}${nl}${ind}}${nl}`;
  return text.slice(0, at) + blockText + text.slice(at);
}

// ---- Steam install / accounts ----------------------------------------------------------------------

let rootOverride = null;
/** Tests only: operate on a fake Steam folder instead of the real one. */
function setSteamRootForTests(dir) { rootOverride = dir; }

function steamRoot() {
  if (rootOverride) return rootOverride;
  return steamRoots().find((r) => fs.existsSync(path.join(r, 'userdata')) && fs.existsSync(path.join(r, 'steam.exe'))) || null;
}

/** Account folder of the most recently logged-in Steam user (from loginusers.vdf). */
function mostRecentAccount(root) {
  try {
    const users = parseVdf(fs.readFileSync(path.join(root, 'config', 'loginusers.vdf'), 'utf8')).users || {};
    for (const [id64, u] of Object.entries(users)) {
      if (u && (u.MostRecent === '1' || u.mostrecent === '1')) return String(BigInt(id64) - 76561197960265728n);
    }
  } catch {}
  return null;
}

/** localconfig.vdf files to manage: accounts that have played Happy Wheels, plus the most recent. */
function targetFiles(root) {
  if (!root) return [];
  const recent = mostRecentAccount(root);
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(root, 'userdata')); } catch {}
  for (const id of dirs) {
    if (!/^\d+$/.test(id) || id === '0') continue;
    const file = path.join(root, 'userdata', id, 'config', 'localconfig.vdf');
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let hasApp = false;
    try { hasApp = !!locate(text).app; } catch { continue; } // unparseable: leave it alone
    if (hasApp || id === recent) out.push(file);
  }
  return out;
}

function desiredOption(exePath) { return `"${exePath}" %command%`; }
const isOurs = (value) => value.toLowerCase().includes(OUR_EXE.toLowerCase());

/**
 * 'on'      every target already launches the mod at exePath
 * 'off'     no launch options set (safe to set up)
 * 'stale'   points at the mod but an old path (safe to update)
 * 'custom'  the player has their own launch options (ask before replacing)
 * 'unknown' no Steam install / accounts found
 */
function status(exePath) {
  const root = steamRoot();
  const files = targetFiles(root);
  if (!files.length) return { state: 'unknown', files };
  const want = desiredOption(exePath);
  const values = files.map((f) => { try { return readLaunchOptions(fs.readFileSync(f, 'utf8')); } catch { return null; } });
  let state = 'on';
  for (const v of values) {
    if (v === null) continue;
    if (v === want) continue;
    if (!v.trim()) { if (state === 'on') state = 'off'; continue; }
    if (isOurs(v)) { if (state === 'on' || state === 'off') state = 'stale'; continue; }
    state = 'custom';
  }
  return { state, files, values };
}

/** Writes the option (value '' removes it). Steam must be closed. Returns files changed. */
function apply(exePath, enable, { replaceCustom = false } = {}) {
  const want = enable ? desiredOption(exePath) : '';
  const changed = [];
  for (const file of targetFiles(steamRoot())) {
    const text = fs.readFileSync(file, 'utf8');
    const cur = readLaunchOptions(text);
    if (cur === want) continue;
    if (enable && cur.trim() && !isOurs(cur) && !replaceCustom) continue; // never clobber the player's own options
    if (!enable && !isOurs(cur)) continue; // only remove what we set
    const next = withLaunchOptions(text, want);
    if (readLaunchOptions(next) !== want) throw new Error('verification failed');
    if (parsePositions(next).length !== parsePositions(text).length) throw new Error('structure changed unexpectedly');
    const backup = `${file}.hwmp-backup`;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    const tmp = `${file}.hwmp-tmp`;
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, file);
    changed.push(file);
  }
  return changed;
}

// ---- Steam process control ---------------------------------------------------------------------------

function steamRunning() {
  return new Promise((resolve) => {
    execFile('tasklist.exe', ['/FI', 'IMAGENAME eq steam.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, encoding: 'utf8', timeout: 8000 },
      (err, out) => resolve(!err && out.toLowerCase().includes('"steam.exe"')));
  });
}

async function waitFor(pred, timeoutMs, stepMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

async function shutdownSteam() {
  const root = steamRoot();
  if (!root) return false;
  spawn(path.join(root, 'steam.exe'), ['-shutdown'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  return waitFor(async () => !(await steamRunning()), 60000);
}

function startSteam() {
  const root = steamRoot();
  if (!root) return false;
  spawn(path.join(root, 'steam.exe'), [], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

module.exports = { setSteamRootForTests, status, apply, steamRunning, shutdownSteam, startSteam, desiredOption, readLaunchOptions, withLaunchOptions, APP_ID };
