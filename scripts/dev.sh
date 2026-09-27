#!/usr/bin/env bash
# Launch the mod in dev mode (dev bridge on 127.0.0.1:47800).
cd "$(dirname "$0")/.."
unset ELECTRON_RUN_AS_NODE
node scripts/build-renderer.js >/dev/null && ELECTRON_ENABLE_LOGGING=1 exec ./node_modules/electron/dist/electron.exe . --hwmp-dev "$@"
