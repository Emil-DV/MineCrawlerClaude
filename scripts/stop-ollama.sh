#!/usr/bin/env bash
# Stop the Ollama server. Uses our PID file if start-ollama.sh launched it;
# otherwise finds and stops any running `ollama serve` process.
# Usage: scripts/stop-ollama.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="$ROOT/.ollama.pid"

# Find the PID: our PID file first, then any running `ollama serve`.
PID=""
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  PID="$(cat "$PIDFILE")"
else
  PID="$(pgrep -f 'ollama serve' | head -1 || true)"
fi

if [ -z "$PID" ]; then
  echo "Ollama is not running."; rm -f "$PIDFILE"; exit 0
fi

echo "Stopping Ollama (PID $PID)..."
kill -TERM "$PID" 2>/dev/null

# Wait up to 15s for a clean exit, then escalate.
for _ in $(seq 1 15); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done
if kill -0 "$PID" 2>/dev/null; then
  echo "Still running — forcing shutdown (SIGKILL)..."; kill -KILL "$PID" 2>/dev/null
fi

rm -f "$PIDFILE"
echo "Ollama stopped."
