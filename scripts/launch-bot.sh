#!/usr/bin/env bash
# Launch an extra Claude-controlled Minecraft bot with a custom name.
# You drive it by typing instructions straight into THIS terminal (its command
# window); the bot also still responds to in-game chat.
#
# Usage:
#   ./scripts/launch-bot.sh <BotName> [S | O | viewerPort] [viewerPort]
#
# Second parameter:
#   S            standalone — no AI loop; you type chat/commands sent straight to
#                the server (plain text = chat, leading "/" = command)
#   O            ollama — AI loop driven by a local Ollama model (no API key needed)
#   <number>     Anthropic AI mode with a web viewer on that port
#   (omitted)    Anthropic AI mode, no viewer
# In S or O mode an optional third parameter sets a viewer port.
#
# Examples:
#   ./scripts/launch-bot.sh Steve            # Anthropic AI bot, no web viewer
#   ./scripts/launch-bot.sh Alex 3008        # Anthropic AI bot, viewer on :3008
#   ./scripts/launch-bot.sh Dwane S          # standalone (no AI), you puppet it by typing
#   ./scripts/launch-bot.sh Olly O           # local-Ollama AI bot
#   ./scripts/launch-bot.sh Olly O 3008      # local-Ollama AI bot, viewer on :3008
#
# Connection (host/port/version) and the API key come from .env, same as `npm start`.
# Standalone and ollama modes do not need an Anthropic API key.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <BotName> [S | O | viewerPort] [viewerPort]" >&2
  exit 1
fi

NAME="$1"
MODE="${2:-}"

# Run from the project root so .env and src/ resolve regardless of where this is called.
cd "$(dirname "$0")/.."

# Exported vars take precedence: dotenv does not override variables already set.
export MC_USERNAME="$NAME"
export ENABLE_VIEWER=false

if [ "$MODE" = "S" ] || [ "$MODE" = "s" ]; then
  export BOT_MODE=standalone
  if [ "$#" -ge 3 ]; then export ENABLE_VIEWER=true; export VIEWER_PORT="$3"; fi
  echo "Launching \"$NAME\" in STANDALONE mode (no AI). Type a chat message or /command and press Enter. Ctrl-C to stop."
elif [ "$MODE" = "O" ] || [ "$MODE" = "o" ]; then
  export BOT_MODE=ollama
  if [ "$#" -ge 3 ]; then export ENABLE_VIEWER=true; export VIEWER_PORT="$3"; fi
  echo "Launching \"$NAME\" in OLLAMA mode (local model ${OLLAMA_MODEL:-qwen2.5-coder:7b}). Type an instruction and press Enter. Ctrl-C to stop."
elif [ -n "$MODE" ]; then
  export ENABLE_VIEWER=true
  export VIEWER_PORT="$MODE"
  echo "Launching \"$NAME\" (Anthropic AI) with viewer on :$MODE. Type an instruction and press Enter. Ctrl-C to stop."
else
  echo "Launching \"$NAME\" (Anthropic AI). Type an instruction and press Enter to direct it. Ctrl-C to stop."
fi

exec node src/index.js
