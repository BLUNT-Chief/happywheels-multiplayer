'use strict';
// Small file logger: %APPDATA%\HappyWheelsMP\logs\hwmp.log (rotated at 1 MB). Captures main-process
// messages plus the game page's multiplayer messages and errors, for bug reports.

const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 1024 * 1024;
let file = null;

function initLog(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'hwmp.log');
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, path.join(dir, 'hwmp.old.log'));
  } catch {
    file = null;
  }
  return file;
}

function write(level, parts) {
  const line = `${new Date().toISOString()} [${level}] ${parts.map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : safeJson(p))).join(' ')}\n`;
  if (file) { try { fs.appendFileSync(file, line); } catch {} }
}

function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }

const log = {
  info: (...a) => { write('info', a); console.log(...a); },
  warn: (...a) => { write('warn', a); console.warn(...a); },
  error: (...a) => { write('error', a); console.error(...a); },
  debug: () => {},
  get file() { return file; },
};

/** Record page-level errors in the log file. */
function captureWebContents(wc) {
  wc.on('console-message', (details) => {
    // Our own messages arrive through the hwmp:log IPC; only record browser-level errors here.
    const msg = String(details.message || '');
    if (details.level === 'error' && !msg.startsWith('[hwmp]')) write('page-error', [`${msg} (${details.sourceId}:${details.lineNumber})`]);
  });
  wc.on('render-process-gone', (_e, d) => write('error', ['renderer gone', d]));
}

module.exports = { initLog, log, captureWebContents };
