#!/usr/bin/env bash
# Stop the Minecraft server gracefully (so the world saves). Sends "stop" to the
# console FIFO if the server was started by start-server.sh; otherwise falls back
# to a SIGTERM on the server.jar process (vanilla saves on SIGTERM too).
# Usage: scripts/stop-server.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT/server"
PIDFILE="$SERVER_DIR/.server.pid"
HOLDERFILE="$SERVER_DIR/.holder.pid"
FIFO="$SERVER_DIR/.console.in"

cleanup() {
  [ -f "$HOLDERFILE" ] && kill "$(cat "$HOLDERFILE")" 2>/dev/null
  rm -f "$PIDFILE" "$HOLDERFILE" "$FIFO"
}

# Find the server PID: our PID file first, then any running server.jar process.
PID=""
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  PID="$(cat "$PIDFILE")"
else
  PID="$(pgrep -f 'server\.jar nogui' | head -1 || true)"
fi

if [ -z "$PID" ]; then
  echo "Server is not running."; cleanup; exit 0
fi

echo "Stopping server (PID $PID) gracefully..."
if [ -p "$FIFO" ]; then
  echo "stop" > "$FIFO"          # clean shutdown via the console
else
  kill -TERM "$PID" 2>/dev/null  # not ours — SIGTERM triggers the save+shutdown hook
fi

# Wait up to 40s for it to save and exit.
for _ in $(seq 1 40); do
  kill -0 "$PID" 2>/dev/null || break
  sleep 1
done

# Escalate if it's still alive.
if kill -0 "$PID" 2>/dev/null; then
  echo "Still running — sending SIGTERM..."; kill -TERM "$PID" 2>/dev/null
  sleep 5
fi
if kill -0 "$PID" 2>/dev/null; then
  echo "Forcing shutdown (SIGKILL)..."; kill -KILL "$PID" 2>/dev/null
fi

cleanup
echo "Server stopped."
