'use strict';
// Dev helper: node scripts/dev-eval.js <file.js | -e "code"> [--main] [--port N]
const fs = require('node:fs');
const http = require('node:http');
const args = process.argv.slice(2);
const main = args.includes('--main');
const pi = args.indexOf('--port');
const port = pi >= 0 ? Number(args[pi + 1]) : 47800;
const rest = args.filter((a, i) => a !== '--main' && i !== pi && i !== pi + 1);
const code = rest[0] === '-e' ? rest[1] : fs.readFileSync(rest[0], 'utf8');
const req = http.request({ host: '127.0.0.1', port, path: main ? '/main' : '/eval', method: 'POST' }, (res) => {
  let b = '';
  res.on('data', (c) => (b += c));
  res.on('end', () => {
    try {
      const j = JSON.parse(b);
      if (j.ok === false) console.log('ERROR:', j.error);
      else console.log(typeof j.value === 'string' ? j.value : JSON.stringify(j.value ?? j, null, 1));
    } catch { console.log(b); }
  });
});
req.on('error', (e) => console.log('bridge error:', e.message));
req.end(code);
