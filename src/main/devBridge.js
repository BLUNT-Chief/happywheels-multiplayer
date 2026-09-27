'use strict';
// Development-only remote control for the game window (never enabled in release builds).
// Binds to 127.0.0.1 only.
//   POST /eval        body = JS expression/program -> JSON result (awaited)
//   GET  /shot?file=  capture window to PNG
//   POST /input       body = JSON Electron input event(s)
//   GET  /logs        recent console output from the page

const http = require('node:http');
const fs = require('node:fs');
const { BrowserWindow } = require('electron');

function startDevBridge(port = 47800) {
  const logs = [];
  const attached = new WeakSet();

  function win() {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed());
    if (w && !attached.has(w.webContents)) {
      attached.add(w.webContents);
      w.webContents.on('console-message', (details) => {
        logs.push(`[${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`);
        if (logs.length > 2000) logs.splice(0, logs.length - 2000);
      });
    }
    return w;
  }
  setInterval(win, 500).unref();

  const server = http.createServer(async (req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body, null, 1));
    };
    try {
      const url = new URL(req.url, 'http://x');
      const body = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
      const w = win();
      if (!w) return send(503, { error: 'no window' });
      const wc = w.webContents;
      if (url.pathname === '/eval') {
        const wrapped = `(async () => { try { const __r = await (async () => { ${body} })(); return { ok: true, value: __r }; } catch (e) { return { ok: false, error: String(e && e.stack || e) }; } })()`;
        const result = await wc.executeJavaScript(wrapped, true);
        return send(200, result);
      }
      if (url.pathname === '/shot') {
        const img = await wc.capturePage();
        const file = url.searchParams.get('file');
        let png = img;
        const maxW = Number(url.searchParams.get('w') || 0);
        if (maxW && img.getSize().width > maxW) png = img.resize({ width: maxW });
        if (file) { fs.writeFileSync(file, png.toPNG()); return send(200, { file, size: png.getSize() }); }
        return send(200, png.toPNG(), 'image/png');
      }
      if (url.pathname === '/input') {
        const events = JSON.parse(body);
        for (const ev of Array.isArray(events) ? events : [events]) {
          if (ev.delay) await new Promise((r) => setTimeout(r, ev.delay));
          else wc.sendInputEvent(ev);
        }
        return send(200, { ok: true });
      }
      if (url.pathname === '/focus') { w.show(); w.focus(); wc.focus(); return send(200, { ok: true }); }
      if (url.pathname === '/logs') {
        const n = Number(url.searchParams.get('n') || 100);
        return send(200, logs.slice(-n).join('\n'), 'text/plain');
      }
      if (url.pathname === '/main') {
        // evaluate in the main process (dev only)
        // eslint-disable-next-line no-new-func
        const value = await new Function('require', 'process', `return (async () => { ${body} })()`)(require, process);
        return send(200, { ok: true, value });
      }
      send(404, { error: 'unknown endpoint' });
    } catch (e) {
      send(500, { error: String(e && e.stack || e) });
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}

module.exports = { startDevBridge };
