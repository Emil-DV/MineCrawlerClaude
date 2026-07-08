#!/usr/bin/env bash
# Start the Ollama server (for BOT_MODE=ollama) in the background, detached.
# Usage: scripts/start-ollama.sh
#   OLLAMA_HOST overrides the listen address (default 127.0.0.1:11434).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="$ROOT/.ollama.pid"
LOG="$ROOT/ollama.log"
HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
API="http://${HOST}/api/version"

command -v ollama >/dev/null 2>&1 || { echo "ollama not found on PATH. Install it: https://ollama.com/download"; exit 1; }

# Already up? (our PID file, then the API endpoint) — never double-start.
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Ollama already running (PID $(cat "$PIDFILE"))."; exit 0
fi
if curl -sS -m 2 "$API" >/dev/null 2>&1; then
  echo "Ollama is already serving at ${HOST}."; exit 0
fi

OLLAMA_HOST="$HOST" nohup ollama serve > "$LOG" 2>&1 &
echo $! > "$PIDFILE"

# Wait up to 15s for the API to answer.
for _ in $(seq 1 15); do
  if curl -sS -m 2 "$API" >/dev/null 2>&1; then
    echo "Ollama started (PID $(cat "$PIDFILE"), serving at ${HOST})."
    echo "  Logs: tail -f ollama.log"
    echo "  Stop: scripts/stop-ollama.sh"
    exit 0
  fi
  sleep 1
done

echo "Ollama launched (PID $(cat "$PIDFILE")) but the API didn't answer within 15s — check ollama.log."
exit 1
