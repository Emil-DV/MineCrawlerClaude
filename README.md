# MineCrawler Claude

Claude controls a character on a local vanilla Minecraft server. A
[Mineflayer](https://github.com/PrismarineJS/mineflayer) bot joins the server as
a player; Claude (via the Anthropic API, using tool use) decides what it does.

```
Vanilla Minecraft server (Java)  ──network──▶  Mineflayer bot (Node.js)
                                                       ▲
                                                tool calls
                                                       ▼
                                              Claude (Anthropic API)
```

## Prerequisites

- **Node.js 18+** (uses the built-in `fetch`).
- **A JDK** to run the server — **Java 21+** for Minecraft 1.20.5 and newer.
  Check with `java -version`. Install if missing:
  - Debian/Ubuntu: `sudo apt install openjdk-21-jre-headless`
  - Fedora: `sudo dnf install java-21-openjdk-headless`
  - Arch: `sudo pacman -S jre-openjdk-headless`
  - macOS (Homebrew): `brew install openjdk@21`
  - Or download from https://adoptium.net
- **An Anthropic API key** — https://console.anthropic.com
- Java Edition only (Bedrock uses a different protocol Mineflayer can't speak).
- You do **not** need to own/install Minecraft to watch the bot — a built-in web
  viewer streams its view. (You only need the game client if you want to join
  and play alongside it.)

## Setup

```bash
# 1. Install dependencies
npm install
# To skip the browser viewer and keep the install lean:
#   npm install --omit=optional   (then set ENABLE_VIEWER=false in .env)

# 2. Configure your API key and settings
cp .env.example .env
# edit .env, set ANTHROPIC_API_KEY

# 3. Download + configure the vanilla server (defaults to 1.21.4)
npm run server:setup
# (override version: npm run server:setup 1.21.1 — also set MC_VERSION in .env to match)
```

`server:setup` downloads the official `server.jar` from Mojang, accepts the
EULA, and writes `server.properties` with `online-mode=false` so the bot can
join without Microsoft authentication.

> **Security:** `online-mode=false` disables auth. Keep this server on your LAN
> only — do not port-forward it to the internet.

## Run

Open two terminals:

```bash
# Terminal 1 — start the Minecraft server (wait for "Done!")
npm run server

# Terminal 2 — connect Claude's bot
npm start
```

Then:

- **Watch** the bot at http://localhost:3007
- **Command** it by typing in Terminal 2, e.g. `mine 3 oak logs`, `come to me`,
  `what's around you?`
- If you join with a real Minecraft client (offline account, same version,
  address `localhost`), you can command it via in-game chat too.

### Extra bots

Run more bots alongside the main one, each with its own name and command window:

```bash
./scripts/launch-bot.sh Steve          # AI bot, no web viewer
./scripts/launch-bot.sh Alex 3008      # AI bot, viewer at http://localhost:3008
./scripts/launch-bot.sh Dwane S        # standalone (no AI) — you puppet it by typing
./scripts/launch-bot.sh Dwane S 3008   # standalone, with a viewer on :3008
```

Run each in its own terminal and type into it (each bot also responds to in-game
chat). Server connection and the API key come from `.env`, same as `npm start`.

The second parameter selects the mode:

| Value | Mode |
|-------|------|
| *(omitted)* | Anthropic AI bot, no viewer |
| a port number | Anthropic AI bot with a web viewer on that port |
| `S` | **Standalone** — no AI loop, no API key needed. You drive the bot yourself (see below). |
| `O` | **Ollama** — AI loop driven by a local Ollama model, no Anthropic key needed (see below). |

In `S` or `O` mode an optional third argument sets a viewer port. The web viewer
is off by default so it won't clash with the main bot's port `3007`.

In **standalone mode** each line you type is resolved as:

1. `??` (or `?` / `help`) — list the avatar's actions and their parameters.
2. A **tool name + args** — invoke that action directly, e.g.:
   ```
   goTo 10 64 20
   mineNearestBlock coal_ore 5
   findBlocks ore 32
   fillArea oak_log 1 2 3 4 5 6
   observe
   ```
   Args are positional in the tool's parameter order; numbers are parsed, and a
   trailing text parameter keeps spaces (so `chat hello there` works).
3. **Anything else** — sent to the server as chat, or as a `/command`
   (e.g. `/gamemode creative`).

> Because a bare tool name runs the action, to literally *say* a word that is also
> a tool (e.g. "stop") in chat, use `chat stop`. Standalone has no preemption, so
> let a long action finish (or run `stop`) before starting another.

### Local model (Ollama)

Drive the bot with a local LLM instead of the Anthropic API — no key, no cost,
runs offline. Install [Ollama](https://ollama.com), then pull a **tool-calling**
model:

```bash
ollama pull qwen2.5-coder:7b      # or llama3.1, qwen2.5, mistral-nemo, ...
```

Set `BOT_MODE=ollama` in `.env` (and `OLLAMA_MODEL` to the model you pulled), then
`npm start` — or launch an extra bot with `./scripts/launch-bot.sh Olly O`. The
same think/act loop runs against Ollama's `/api/chat`; it uses the model's native
tool calls, and falls back to parsing tool-call JSON from the reply for models
(like `qwen2.5-coder`) that emit it as text.

> The model **must support tool calling**, and smaller local models are slower and
> less reliable at multi-step tasks than the Anthropic models. `OLLAMA_HOST`
> defaults to `http://localhost:11434`.

## What Claude can do

The tools exposed to Claude live in `src/tools.js` and are implemented in
`src/minecraft-actions.js`:

**Perception**

| Tool | Action |
|------|--------|
| `observe` | Report position, facing, health, food, inventory, nearby entities and notable blocks |
| `findBlocks` | Locate nearby *visible* blocks by name and return their coordinates |

**Movement & looking**

| Tool | Action |
|------|--------|
| `goTo` | Walk to coordinates |
| `goToPlayer` / `followPlayer` | Go to / continuously follow a player |
| `move` | Move forward/back/left/right (relative to facing) a number of blocks |
| `jump` | Jump up and hop one block in a relative direction (climb a step) |
| `turn` | Turn to face a relative direction (forward/back/left/right) |
| `lookDirection` / `lookAt` | Face a cardinal direction / look at a coordinate |
| `stop` | Cancel movement and the current goal |

**Mining**

| Tool | Action |
|------|--------|
| `mineNearestBlock` | Mine nearest *visible* block(s) of a type (prefers the nearest player's gaze) |
| `digBlock` | Mine the single block at exact coordinates |
| `mineArea` | Mine out every block in a box (top-down) |
| `digTestTunnel` | Walk to the wall ahead and dig a 1-wide, 2-high tunnel forward |

**Building**

| Tool | Action |
|------|--------|
| `placeBlock` | Place one block at coordinates |
| `fillArea` / `buildWall` | Fill a box / build a straight wall |
| `fillPit` | Fill the pit the bot is standing in, up to ground level, matching the floor block |
| `plantField` | Hoe grass blocks at the bot's level into farmland and plant a seed |

**Inventory & items**

| Tool | Action |
|------|--------|
| `equipItem` | Equip an inventory item |
| `dropItem` | Drop items on the ground |
| `collectItems` | Walk to and pick up nearby dropped items |
| `useItem` | Use (right-click) the held item — buckets, potions, etc. |
| `eat` | Eat food to restore hunger |
| `craftItem` | Craft an item (uses a nearby crafting table for 3x3) |
| `depositToChest` / `withdrawFromChest` | Store / retrieve items in a chest, barrel, or shulker |

**Interaction & combat**

| Tool | Action |
|------|--------|
| `chat` | Speak in in-game chat |
| `activateBlock` | Use a block — doors, buttons, levers, chests |
| `attackEntity` | Attack a mob/player (or nearest hostile) |

To give Claude new abilities, add a function in `minecraft-actions.js` and a
matching tool definition in `tools.js`. The agent loop in `src/agent.js` handles
the rest.

## Layout

```
src/
  index.js              entry point: bot, viewer, chat + terminal input
  agent.js              Anthropic tool-use loop
  agent-ollama.js       local-Ollama tool-use loop (BOT_MODE=ollama)
  tools.js              tool definitions + dispatcher
  minecraft-actions.js  bot capabilities
scripts/
  setup-server.mjs      download + configure the vanilla server
  start-server.mjs      launch the server
  launch-bot.sh         launch an extra named bot with its own command window
  test-commands.js      functional test of every tool (npm run test:commands)
```

## Testing

With the server running, exercise every tool against the live world:

```bash
npm run test:commands
```

This connects a throwaway `TestBot`, and — if the server puts it in creative —
loads a test inventory and runs real placements, mining, chest I/O, crafting,
etc. in a small work area (cleaning up after itself). It prints a pass/fail line
per tool. Destructive/environment-dependent tools (combat, follow-player) use
safe inputs.

It first **teleports to the nearest online character** so the test runs where
someone is (it falls back to walking, then to testing in place). The teleport
uses `/tp`, which needs `TestBot` opped — it's already in `server/ops.json`. If
no one else is online it just tests at spawn, so have your client or another bot
connected to watch.

## Notes

- `MC_VERSION` in `.env` **must** match the server version you downloaded.
- Mineflayer supports Minecraft 1.8–1.21.x.
- Default model is `claude-sonnet-4-6` (fast control loop); set `CLAUDE_MODEL`
  to `claude-opus-4-8` for harder reasoning.
