require('dotenv').config()
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const readline = require('readline')
const { tools, dispatch } = require('./tools')

// Print the avatar's available actions with their parameter order. "??", "?", "help".
function printCommands() {
  console.log(`\nThe avatar can do ${tools.length} things (type: name then args, e.g. "goTo 10 64 20"):`)
  for (const t of tools) {
    const params = Object.keys(t.input_schema.properties || {})
    console.log(`${t.name} ${params.length ? params.join(' ') : '(no args)'}`)
    console.log(`    ${t.description}`)
  }

  // First sentence of a tool's description, capped — a short help string.
  const shortHelp = (name) => {
    const t = tools.find((x) => x.name === name)
    if (!t) return ''
    return t.description.split('. ')[0].replace(/\.$/, '').slice(0, 80)
  }

  console.log('\nShortcuts (short name → full command):')
  for (const [short, long] of Object.entries(TOOL_NAME_ALIASES)) {
    console.log(`  ${short} → ${long} — ${shortHelp(long)}`)
  }
  for (const [phrase, fn] of Object.entries(ALIASES)) {
    const tool = fn('you').tool
    console.log(`  "${phrase}" → ${tool} — ${shortHelp(tool)}`)
  }

  console.log('\n(type "??" to show this again)\n')
}

// Map whitespace-separated args to a tool's input by schema property order.
// Numbers are coerced; a trailing string property absorbs the rest of the line
// (so e.g. `chat hello there` keeps the spaces).
function parseToolArgs(tool, argTokens) {
  const props = tool.input_schema.properties || {}
  const keys = Object.keys(props)
  const required = tool.input_schema.required || []
  const value = {}
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]
    const type = props[key].type
    if (i === keys.length - 1 && type === 'string') {
      const rest = argTokens.slice(i).join(' ')
      if (rest !== '') value[key] = rest
    } else if (i < argTokens.length) {
      if (type === 'number') {
        const n = Number(argTokens[i])
        if (Number.isNaN(n)) return { error: `"${argTokens[i]}" is not a number for "${key}".` }
        value[key] = n
      } else {
        value[key] = argTokens[i]
      }
    }
  }
  const missing = required.filter((k) => !(k in value))
  if (missing.length) return { error: `Usage: ${tool.name} ${keys.join(' ')}  (missing: ${missing.join(', ')})` }
  return { value }
}

// Your in-game name, used to resolve "me" when there's no chat sender (terminal).
const OWNER = process.env.MC_OWNER || 'kaikdidk'

// Bots prefix their result echoes with this so other bots never obey them.
const ECHO = '»'

// Split a long string into chat-sized chunks on word boundaries (so e.g. a long
// inventory list goes out as several messages instead of being truncated).
function splitForChat(text, max = 180, limit = 6) {
  const parts = []
  let cur = ''
  for (const w of text.split(' ')) {
    if (cur && (cur + ' ' + w).length > max) {
      parts.push(cur)
      cur = w
      if (parts.length >= limit) return parts
    } else {
      cur = cur ? cur + ' ' + w : w
    }
  }
  if (cur) parts.push(cur)
  return parts
}

// Only this player's chat commands are obeyed, so bots never act on each other's
// chatter (which is what burns API tokens). Defaults to the owner; set
// BOT_COMMANDER=* to let anyone command the bot.
const COMMANDER = process.env.BOT_COMMANDER || OWNER
const obeys = (username) => COMMANDER === '*' || username.toLowerCase() === COMMANDER.toLowerCase()

// Phrase aliases → a direct tool call. `sender` is the chat author (undefined from
// the terminal, where "me" falls back to OWNER).
const ALIASES = {
  'come to me': (sender) => ({ tool: 'goToPlayer', input: { username: sender || OWNER } }),
  'come here': (sender) => ({ tool: 'goToPlayer', input: { username: sender || OWNER } }),
  come: (sender) => ({ tool: 'goToPlayer', input: { username: sender || OWNER } }),
  'follow me': (sender) => ({ tool: 'followPlayer', input: { username: sender || OWNER } }),
  follow: (sender) => ({ tool: 'followPlayer', input: { username: sender || OWNER } }),
  'look at me': (sender) => ({ tool: 'lookAtMe', input: { username: sender || OWNER } }),
  'chitchat': (sender) => ({ tool: 'chitchat', input: { username: sender || OWNER } }),
}

// Short names for typed/chatted tool commands that take arguments (e.g. "mine
// oak_log", "plant wheat_seeds"). Resolved to the real tool in runTool.
const TOOL_NAME_ALIASES = {
  mine: 'mineNearestBlock',
  plant: 'plantField',
  harvest: 'harvestAndCollect',
  replace: 'replaceField',
  gtw: 'gotoWaypoint',
  grab: 'withdrawFromChest',
  store: 'depositToChest',
  craft: 'craftItem',
  place: 'placeBlock',
  equip: 'equipItem',
  collect: 'collectItems',
  hyd: 'healthStatus',
  smelt: 'smeltItem',
  inv: 'inventory',
}
function resolveAlias(text, sender) {
  const fn = ALIASES[text.trim().toLowerCase()]
  return fn ? fn(sender) : null
}

// Resolve a chat message to a command for this bot, or null to ignore it.
// An optional [name]/[all] prefix targets a specific bot. With BOT_REQUIRE_NAME
// off (default), a message with no prefix is treated as a command for this bot;
// with it on, only explicitly addressed commands are obeyed. (Bot-to-bot loops
// are already prevented by the commander allow-list, so the prefix is optional.)
const REQUIRE_NAME = process.env.BOT_REQUIRE_NAME === 'true'
function commandFor(message, botName) {
  const m = message.match(/^\s*\[([^\]]+)\]\s*(.+)$/)
  if (m) {
    const target = m[1].trim().toLowerCase()
    if (target === 'all' || target === botName.toLowerCase()) return m[2].trim()
    return null // addressed to a different bot
  }
  return REQUIRE_NAME ? null : message.trim()
}

// Mode of operation:
//   standalone — no AI loop; you drive the bot by typing chat/commands.
//   ollama     — AI loop driven by a local Ollama model (no Anthropic key needed).
//   (default)  — AI loop driven by the Anthropic API.
const STANDALONE = process.env.BOT_MODE === 'standalone'
const OLLAMA = process.env.BOT_MODE === 'ollama'

if (!STANDALONE && !OLLAMA && !process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in (or use BOT_MODE=ollama / standalone).')
  process.exit(1)
}

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || 'localhost',
  port: Number(process.env.MC_PORT || 25565),
  username: process.env.MC_USERNAME || 'ClaudeBot',
  version: process.env.MC_VERSION || '1.21.4',
  auth: 'offline',
})

bot.loadPlugin(pathfinder)

bot.once('spawn', () => {
  // All pathfinding is non-destructive: the bot never digs or places blocks just
  // to travel (walking, collecting, going to chests/players/waypoints, moving
  // between build/mine cells). Task digging/placing still happens explicitly via
  // bot.dig / bot.placeBlock in the individual commands.
  bot.defaultMovements = new Movements(bot)
  bot.defaultMovements.canDig = false
  bot.defaultMovements.scafoldingBlocks = []
  bot.defaultMovements.allow1by1towers = false
  // followPlayer/goToPlayer/gotoWaypoint reference this; same restricted config.
  bot.followMovements = bot.defaultMovements
  // Building is allowed to dig/place to reach a spot (e.g. scaffold up to a high
  // wall block). placeOne switches to this just for positioning before a place.
  bot.buildMovements = new Movements(bot)
  // NOTE: canOpenDoors left at the library default (false). mineflayer's pathfinder
  // cannot route through doors on vanilla 1.21.x (verified: stuck at closed doors,
  // "no path" through open ones), and enabling it can degrade other pathing.
  bot.pathfinder.setMovements(bot.defaultMovements)
  console.log(`Bot spawned as "${bot.username}" (${STANDALONE ? 'standalone' : OLLAMA ? `ollama: ${process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b'}` : 'anthropic'} mode).`)

  // Personal space: keep ~1 block of clearance from any other player/bot. Only
  // nudges when idle, so it never fights an active goToPlayer/followPlayer/agent goal.
  const MIN_GAP = 1 // step away if another entity is closer than this (blocks)
  let keepingDistance = false
  const personalSpace = setInterval(async () => {
    if (keepingDistance || !bot.entity || bot.pathfinder.isMoving()) return
    if (bot.gatherUntil && Date.now() < bot.gatherUntil) return // just summoned — let bots gather
    // Never disturb an active follow — overriding the goal would stop the bot
    // from following once it catches up.
    const g = bot.pathfinder.goal
    if (g && g.constructor && g.constructor.name === 'GoalFollow') return
    let nearest = null
    let best = Infinity
    for (const p of Object.values(bot.players)) {
      if (!p.entity || p.username === bot.username) continue
      const d = bot.entity.position.distanceTo(p.entity.position)
      if (d < best) { best = d; nearest = p.entity }
    }
    if (!nearest || best >= MIN_GAP) return
    keepingDistance = true
    try {
      const away = bot.entity.position.minus(nearest.position)
      away.y = 0
      if (away.norm() < 0.01) away.x = 1 // exactly overlapping → pick any direction
      const dir = away.normalize()
      const t = bot.entity.position.offset(dir.x * 1.5, 0, dir.z * 1.5)
      await bot.pathfinder.goto(new goals.GoalNear(Math.floor(t.x), Math.floor(bot.entity.position.y), Math.floor(t.z), 1))
    } catch { /* blocked/cornered — try again next tick */ }
    keepingDistance = false
  }, 250)
  bot.once('end', () => clearInterval(personalSpace))

  // Don't drown: if the bot's head is underwater, hold the swim-up control until
  // it surfaces. Only manages the jump control while submerged, so it doesn't
  // interfere with normal jumping/pathfinding on land.
  let swimmingUp = false
  const swimUp = setInterval(() => {
    if (!bot.entity) return
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0)
    const head = bot.blockAt(eye)
    const headUnderwater = !!head && (head.name === 'water' || head.name === 'bubble_column')
    if (headUnderwater) {
      bot.setControlState('jump', true) // swim toward the surface
      swimmingUp = true
    } else if (swimmingUp) {
      bot.setControlState('jump', false)
      swimmingUp = false
    }
  }, 200)
  bot.once('end', () => clearInterval(swimUp))

  // Idle liveliness: every ~5-7s, glance in a new direction while standing around,
  // so the bot doesn't stare blankly. Skipped while it's busy (walking, following,
  // or digging) so it never turns away from an active task.
  let nextGlance = Date.now() + 5000
  const idleLook = setInterval(() => {
    if (!bot.entity || Date.now() < nextGlance) return
    nextGlance = Date.now() + 5000 + Math.random() * 2000 // next glance in 5-7s
    if (bot.pathfinder.isMoving() || bot.pathfinder.goal || bot.targetDigBlock) return
    const yaw = Math.random() * Math.PI * 2
    const pitch = (Math.random() - 0.5) * 0.6 // mostly level, a little up/down
    bot.look(yaw, pitch, false).catch(() => {})
  }, 1000)
  bot.once('end', () => clearInterval(idleLook))

  // If text is a phrase alias (e.g. "come to me"), run its tool and return the
  // result promise; otherwise return null so normal handling proceeds.
  const runAliasOrNull = (text, sender) => {
    const a = resolveAlias(text, sender)
    if (!a) return null
    return dispatch(bot, a.tool, a.input).then((r) => `${a.tool} -> ${r}`).catch((e) => `Error running ${a.tool}: ${e.message}`)
  }

  if (process.env.ENABLE_VIEWER !== 'false') {
    const port = Number(process.env.VIEWER_PORT || 3007)
    try {
      require('prismarine-viewer').mineflayer(bot, { port, firstPerson: false })
      console.log(`Watch the bot at http://localhost:${port}`)
    } catch (e) {
      console.warn('Viewer unavailable:', e.message)
    }
  }

  // Standalone: no AI loop. Both the terminal and in-game chat can run actions by
  // typing a tool name + args; anything else is treated as plain chat/command.
  if (STANDALONE) {
    // Standalone preemption: each new command bumps bot.cmdSeq and hard-stops the
    // bot, so a later "stop" (or any new command) interrupts the running action.
    // Long-running actions check bot.cmdSeq and bail when it changes.
    bot.cmdSeq = 0
    const preempt = () => {
      bot.cmdSeq++
      try { bot.pathfinder.setGoal(null) } catch {}
      try { bot.clearControlStates() } catch {}
      try { bot.stopDigging() } catch {}
      try { bot.pathfinder.setMovements(bot.defaultMovements) } catch {} // followPlayer re-restricts
    }

    // Run a tool if the first word names one. Returns a result string, or null
    // if the text isn't a tool invocation.
    const runTool = async (text) => {
      const [typed, ...rest] = text.split(/\s+/)
      const name = TOOL_NAME_ALIASES[typed.toLowerCase()] || typed
      const tool = tools.find((t) => t.name === name)
      if (!tool) return null
      const parsed = parseToolArgs(tool, rest)
      if (parsed.error) return parsed.error
      try {
        return `${name} -> ${await dispatch(bot, name, parsed.value)}`
      } catch (e) {
        return `Error running ${name}: ${e.message}`
      }
    }

    // Drive the bot via chat addressed to it: "[BotA] goTo 10 64 20" or "[all] come here".
    // Chat without a matching [name]/[all] prefix is ignored.
    bot.on('chat', async (username, message) => {
      if (username === bot.username) return
      if (message.startsWith(ECHO)) return // a bot's result echo — never obey it (would clobber goals)
      if (!obeys(username)) return // only the commander is obeyed
      const cmd = commandFor(message, bot.username)
      if (!cmd) return // not addressed to this bot
      console.log(`<${username}> ${message}`)
      preempt() // interrupt any running action (so "stop" / new commands take effect now)
      // Run one or more ";"-separated commands in sequence; stop if a newer command preempts us.
      const mySeq = bot.cmdSeq
      for (const part of cmd.split(';').map((s) => s.trim()).filter(Boolean)) {
        if (bot.cmdSeq !== mySeq) break
        const aliased = runAliasOrNull(part, username)
        const result = aliased ? await aliased : await runTool(part)
        if (result !== null) {
          console.log(`  ${result}`)
          // Report back, split across several messages if long (with a small delay
          // between them so the server doesn't treat it as spam).
          const parts = splitForChat(result.replace(/\s+/g, ' '))
          for (let i = 0; i < parts.length; i++) {
            if (i) await new Promise((r) => setTimeout(r, 400))
            bot.chat(`${ECHO} ${parts[i]}`)
          }
        }
      }
    })

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'do> ' })
    console.log('Standalone mode (no AI). Type an action (e.g. "goTo 10 64 20"), a chat message,')
    console.log('or a /command. "??" lists the actions. Players can run actions via in-game chat too.')
    rl.prompt()
    rl.on('line', async (line) => {
      const text = line.trim()
      if (!text) { rl.prompt(); return }
      if (text === '??' || text === '?' || text === 'help') { printCommands(); rl.prompt(); return }
      preempt() // interrupt any running action
      const mySeq = bot.cmdSeq
      for (const part of text.split(';').map((s) => s.trim()).filter(Boolean)) {
        if (bot.cmdSeq !== mySeq) break
        const aliased = runAliasOrNull(part)
        const result = aliased ? await aliased : await runTool(part)
        if (result !== null) console.log(`  ${result}`)
        else bot.chat(part) // not a tool → send to server as chat or a /command
      }
      rl.prompt()
    })
    return
  }

  // Pick the AI backend (lazy require so Ollama mode never loads the Anthropic SDK).
  const { createAgent } = require(OLLAMA ? './agent-ollama' : './agent')
  const agent = createAgent(bot)

  // Commands from players in-game chat — must be addressed "[name] ..." or "[all] ...".
  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    if (message.startsWith(ECHO)) return // a bot's result echo — never obey it
    if (!obeys(username)) return // only the commander is obeyed
    const cmd = commandFor(message, bot.username)
    if (!cmd) return // not addressed to this bot
    console.log(`<${username}> ${message}`)
    const aliased = runAliasOrNull(cmd, username)
    if (aliased) { aliased.then((r) => console.log(`[alias] ${r}`)); return }
    agent.processInstruction(cmd, username)
  })

  // Commands typed into this terminal (no Minecraft client required).
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'command> ' })
  console.log('Type an instruction here and press enter (e.g. "mine 3 oak logs", or "??" for the action list).')
  rl.prompt()
  rl.on('line', (line) => {
    const text = line.trim()
    if (text === '??' || text === '?' || text === 'help') { printCommands(); rl.prompt(); return }
    const aliased = text ? runAliasOrNull(text) : null
    if (aliased) aliased.then((r) => console.log(`[alias] ${r}`))
    else if (text) agent.processInstruction(text, 'console')
    rl.prompt()
  })
})

bot.on('kicked', (reason) => console.log('Kicked:', reason))
bot.on('error', (err) => console.log('Error:', err.message))
bot.on('end', () => console.log('Disconnected from server.'))
