#!/usr/bin/env bash
# Swarm Studio lifecycle: start | stop | status | logs [n]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-4321}"
URL="http://localhost:$PORT"
LOG="$ROOT/data/server.log"
PIDF="$ROOT/data/server.pid"
mkdir -p "$ROOT/data"

up() { curl -sf "$URL/api/health" >/dev/null 2>&1; }

case "${1:-status}" in
  start)
    if up; then echo "running: $URL"; exit 0; fi
    (cd "$ROOT" && PORT="$PORT" nohup node server.mjs >>"$LOG" 2>&1 & echo $! >"$PIDF")
    for _ in $(seq 20); do
      up && { echo "running: $URL"; exit 0; }
      sleep 0.5
    done
    echo "server did not start:"; tail -20 "$LOG"; exit 1 ;;
  stop)
    [ -f "$PIDF" ] && kill "$(cat "$PIDF")" 2>/dev/null || true
    rm -f "$PIDF"
    up && echo "still answering on $PORT (started elsewhere?)" || echo "stopped" ;;
  status)
    up && echo "running: $URL" || echo "not running" ;;
  logs)
    tail -n "${2:-50}" "$LOG" ;;
  *)
    echo "usage: ss.sh start|stop|status|logs [n]"; exit 2 ;;
esac
