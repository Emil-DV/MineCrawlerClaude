#!/usr/bin/env bash
# Start the Minecraft server in the background (detached), with a console FIFO so
# stop-server.sh can shut it down gracefully (saving the world).
# Usage: scripts/start-server.sh        (MC_MEMORY=4G to override the 2G default)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT/server"
PIDFILE="$SERVER_DIR/.server.pid"
HOLDERFILE="$SERVER_DIR/.holder.pid"
FIFO="$SERVER_DIR/.console.in"
LOG="$SERVER_DIR/console.log"
MEM="${MC_MEMORY:-2G}"

[ -f "$SERVER_DIR/server.jar" ] || { echo "server/server.jar not found. Run: npm run server:setup"; exit 1; }

# Already up? (check our PID file, then the port, so we never double-start.)
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Server already running (PID $(cat "$PIDFILE"))."; exit 0
fi
if (exec 3<>/dev/tcp/127.0.0.1/25565) 2>/dev/null; then
  echo "Port 25565 is already in use — a server is already running."; exit 0
fi

# (Re)create the console FIFO and hold its write end open so the server's stdin
# never hits EOF; this lets stop-server.sh feed it the "stop" command later.
rm -f "$FIFO"; mkfifo "$FIFO"
sleep infinity > "$FIFO" &
echo $! > "$HOLDERFILE"

cd "$SERVER_DIR"
nohup java -Xmx"$MEM" -Xms"$MEM" -jar server.jar nogui < "$FIFO" > "$LOG" 2>&1 &
echo $! > "$PIDFILE"

echo "Minecraft server starting (PID $(cat "$PIDFILE"), ${MEM} RAM)."
echo "  Logs:  tail -f server/console.log"
echo "  Stop:  scripts/stop-server.sh"
