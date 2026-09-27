#!/usr/bin/env bash
# Launch two local instances that race each other over the localhost relay (no second Steam
# account needed). Instance 1 uses Steam for the game itself; instance 2 runs without Steam.
# Dev bridges: 127.0.0.1:47800 (host) and :47801 (guest).
# HWMP_OFFSCREEN=1 ./scripts/dev-duo.sh keeps both windows off-screen and unfocused.
cd "$(dirname "$0")/.."
taskkill //F //IM electron.exe >/dev/null 2>&1
sleep 1
unset ELECTRON_RUN_AS_NODE
node scripts/build-renderer.js >/dev/null || exit 1
(HWMP_LOCAL_NET=1 HWMP_MULTI=1 HWMP_OFFSCREEN=${HWMP_OFFSCREEN:-0} HWMP_PROFILE=1 HWMP_NAME=Alice HWMP_DEV_PORT=47800 ELECTRON_ENABLE_LOGGING=1 \
  ./node_modules/electron/dist/electron.exe . --hwmp-dev > .dev-run.log 2>&1 &)
sleep 3
(HWMP_LOCAL_NET=1 HWMP_MULTI=1 HWMP_OFFSCREEN=${HWMP_OFFSCREEN:-0} HWMP_PROFILE=2 HWMP_NAME=Bob HWMP_NO_STEAM=1 HWMP_DEV_PORT=47801 ELECTRON_ENABLE_LOGGING=1 \
  ./node_modules/electron/dist/electron.exe . --hwmp-dev > .dev-run2.log 2>&1 &)
for p in 47800 47801; do
  for i in $(seq 1 60); do curl -s -m 1 "http://127.0.0.1:$p/logs" >/dev/null 2>&1 && break; sleep 0.5; done
done
sleep 4
echo "duo started"
