// The game replaces console.* with no-ops once its bundle boots, so keep the real methods
// (captured before the game runs) and also forward everything to the log file via the preload.

const real = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function fmt(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

function send(level, args) {
  try { window.hwmp?.log?.(level, args.map(fmt).join(' ').slice(0, 4000)); } catch {}
}

export const log = {
  info: (...a) => { real.log('[hwmp]', ...a); send('info', a); },
  warn: (...a) => { real.warn('[hwmp]', ...a); send('warn', a); },
  error: (...a) => { real.error('[hwmp]', ...a); send('error', a); },
};

// Uncaught errors from our own code (the game's are its business).
window.addEventListener('error', (e) => {
  if (String(e.filename || '').includes('/__hwmp__/')) send('error', [e.error || e.message]);
});
window.addEventListener('unhandledrejection', (e) => send('error', ['unhandled rejection', e.reason]));
