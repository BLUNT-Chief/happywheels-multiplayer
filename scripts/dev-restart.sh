#!/usr/bin/env bash
# Restart the dev instance (kills only the dev Electron, not the real game).
cd "$(dirname "$0")/.."
taskkill //F //IM electron.exe >/dev/null 2>&1
for i in 1 2 3 4 5 6 7 8 9 10; do tasklist | grep -qi "^electron.exe" || break; sleep 0.5; done
(./scripts/dev.sh > .dev-run.log 2>&1 &)
for i in $(seq 1 40); do curl -s -m 1 http://127.0.0.1:47800/logs >/dev/null 2>&1 && break; sleep 0.5; done
sleep 3
echo "restarted"; grep -E "hwmp|ERROR|rror" .dev-run.log | grep -v "Security Warning" | head -20
