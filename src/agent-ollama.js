// Think/act loop backed by a local Ollama model instead of the Anthropic API.
// Mirrors src/agent.js (same createAgent(bot) interface + preemption), but talks
// to Ollama's /api/chat and tolerates models that emit tool calls as JSON text
// in `content` (e.g. qwen2.5-coder) rather than the native `tool_calls` field.
const { tools, dispatch } = require('./tools')

const HOST = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '')
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b'
const MAX_STEPS = 12 // safety cap on tool-call rounds per instruction

const SYSTEM = `You control a character in a Minecraft world through a bot.
You receive instructions from players and act using the provided tools. Guidelines:
- To act, call one of the provided tools. Do not invent tools or arguments.
- When unsure of the situation, call "observe" first.
- Talk to players with the "chat" tool. Keep messages short.
- Take the actions needed to fulfill the instruction, then stop and give a one-line summary.
- If you cannot do something, say so briefly.`

// Tools in Ollama/OpenAI function-calling shape.
const OLLAMA_TOOLS = tools.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}))
const TOOL_NAMES = new Set(tools.map((t) => t.name))

function safeParse(s) {
  try { return JSON.parse(s) } catch { return null }
}

// Pull tool calls out of a model message: native tool_calls first, else parse
// JSON object(s) of the form {"name","arguments"} from the text content.
function extractToolCalls(message) {
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
    return message.tool_calls
      .map((c) => ({
        name: c.function && c.function.name,
        args: typeof (c.function && c.function.arguments) === 'string'
          ? safeParse(c.function.arguments) || {}
          : (c.function && c.function.arguments) || {},
      }))
      .filter((c) => c.name)
  }
  let t = (message.content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  let obj = safeParse(t)
  if (!obj) {
    const m = t.match(/\{[\s\S]*\}/)
    if (m) obj = safeParse(m[0])
  }
  if (!obj) return []
  const arr = Array.isArray(obj) ? obj : [obj]
  return arr
    .filter((o) => o && typeof o.name === 'string' && TOOL_NAMES.has(o.name))
    .map((o) => ({ name: o.name, args: o.arguments || o.parameters || {} }))
}

// Circuit breaker: cap calls per rolling minute so a runaway loop can't spin forever.
const MAX_CALLS_PER_MIN = Number(process.env.AI_MAX_CALLS_PER_MIN || 30)

function createAgent(bot) {
  const history = []
  let runId = 0
  let controller = null
  let callTimes = []

  function overRateLimit() {
    const now = Date.now()
    callTimes = callTimes.filter((t) => now - t < 60000)
    if (callTimes.length >= MAX_CALLS_PER_MIN) return true
    callTimes.push(now)
    return false
  }

  function trim() {
    if (history.length <= 40) return
    for (let i = history.length - 40; i < history.length; i++) {
      if (history[i].role === 'user' && typeof history[i].content === 'string') {
        history.splice(0, i)
        return
      }
    }
  }

  // Strip back to a clean assistant text reply so a preempted run leaves no
  // dangling tool-call/result fragment.
  function rollbackToStable() {
    while (history.length) {
      const last = history[history.length - 1]
      if (last.role === 'assistant' && extractToolCalls(last).length === 0) break
      history.pop()
    }
  }

  async function handle(text, from, myRunId, signal) {
    rollbackToStable()
    trim()
    history.push({ role: 'user', content: `${from} says: ${text}` })

    for (let step = 0; step < MAX_STEPS; step++) {
      if (myRunId !== runId) return
      if (overRateLimit()) {
        console.error(`[ollama] rate limit reached (${MAX_CALLS_PER_MIN} calls/min) — pausing.`)
        return
      }
      let data
      try {
        const res = await fetch(`${HOST}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: MODEL, stream: false, messages: [{ role: 'system', content: SYSTEM }, ...history], tools: OLLAMA_TOOLS }),
          signal,
        })
        if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
        data = await res.json()
      } catch (e) {
        if (myRunId !== runId) return // aborted by a newer instruction
        throw e
      }
      if (myRunId !== runId) return

      const msg = data.message || {}
      const calls = extractToolCalls(msg)
      if (calls.length === 0) {
        history.push({ role: 'assistant', content: msg.content || '' })
        const said = (msg.content || '').trim()
        if (said) {
          console.log('[ollama]', said)
          // Small models often "talk" via the final reply instead of the chat tool,
          // so speak it in-game (unless it's a leftover JSON blob). Capped to one
          // chat line; other bots ignore it (commander allow-list).
          if (!/^[[{]/.test(said)) bot.chat(said.replace(/\s+/g, ' ').slice(0, 240))
        }
        return
      }

      history.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls })
      for (const call of calls) {
        if (myRunId !== runId) return
        let out
        try {
          out = await dispatch(bot, call.name, call.args || {})
        } catch (e) {
          out = `Error running ${call.name}: ${e.message}`
        }
        if (myRunId !== runId) return
        console.log(`[tool] ${call.name}(${JSON.stringify(call.args)}) -> ${out}`)
        history.push({ role: 'tool', content: String(out), tool_name: call.name })
      }
    }
    console.log('[ollama] stopped after reaching the step limit.')
  }

  function processInstruction(text, from) {
    runId += 1
    const myRunId = runId
    if (controller) controller.abort()
    controller = new AbortController()
    bot.cmdSeq = (bot.cmdSeq || 0) + 1 // signal long-running tools to bail
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
    try { bot.stopDigging() } catch {}
    try { if (bot.defaultMovements) bot.pathfinder.setMovements(bot.defaultMovements) } catch {}
    return handle(text, from, myRunId, controller.signal).catch((e) => {
      if (myRunId === runId) console.error('[ollama error]', e.message)
    })
  }

  return { processInstruction }
}

module.exports = { createAgent }
