'use strict';
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [path.join(root, 'src/renderer/index.js')],
  outfile: path.join(root, 'out/web/inject.js'),
  bundle: true,
  format: 'iife',
  target: 'chrome130',
  sourcemap: 'inline',
  logLevel: 'info',
  loader: { '.css': 'text', '.svg': 'text' },
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  } else {
    await esbuild.build(options);
  }
})().catch((e) => { console.error(e); process.exit(1); });
