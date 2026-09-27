'use strict';
// Bundles the in-game code (src/renderer) into out/web/inject.js.
//   node scripts/build-renderer.js          development build (inline source maps)
//   node scripts/build-renderer.js --prod   release build (minified, dev-only code stripped)
//   node scripts/build-renderer.js --watch
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--prod');

const options = {
  entryPoints: [path.join(root, 'src/renderer/index.js')],
  outfile: path.join(root, 'out/web/inject.js'),
  bundle: true,
  format: 'iife',
  target: 'chrome130',
  sourcemap: prod ? false : 'inline',
  minify: prod,
  legalComments: 'none',
  define: { __DEV__: prod ? 'false' : 'true' },
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
