// The think/act loop: hand an instruction to Claude, run the tools it asks for,
// feed results back until it stops calling tools.
const Anthropic = require('@anthropic-ai/sdk')
const { tools, dispatch } = require('./tools')

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6'
const client = new Anthropic() // reads ANTHROPIC_API_KEY from the environment

const SYSTEM = `You control a character in a Minecraft world through a bot.
You receive instructions from players (or the server console) and act using the
provided tools. Guidelines:
- When a situation is unclear, call "observe" before acting.
- Talk to players with the "chat" tool; do not narrate to yourself.
- Take actions to fulfill the instruction, then stop. Keep chat messages short.
- If you cannot do something, say so briefly in chat.`

// Circuit breaker: cap API calls per rolling minute so a runaway loop can't burn
// tokens unbounded. Configurable via AI_MAX_CALLS_PER_MIN.
const MAX_CALLS_PER_MIN = Number(process.env.AI_MAX_CALLS_PER_MIN || 30)

function createAgent(bot) {
  const history = []
  let runId = 0 // bumped on every new instruction; an older run sees its id go stale and bails
  let controller = null // aborts the in-flight API call when a new instruction preempts it
  let callTimes = [] // timestamps of recent API calls, for the rate limiter

  function overRateLimit() {
    const now = Date.now()
    callTimes = callTimes.filter((t) => now - t < 60000)
    if (callTimes.length >= MAX_CALLS_PER_MIN) return true
    callTimes.push(now)
    return false
  }

  function trim() {
    // Keep history bounded; cut at a real instruction boundary so we never
    // orphan a tool_use/tool_result pair.
    if (history.length <= 40) return
    for (let i = history.length - 40; i < history.length; i++) {
      if (history[i].role === 'user' && typeof history[i].content === 'string') {
        history.splice(0, i)
        return
      }
    }
  }

  function rollbackToStable() {
    // An interrupted run can leave a dangling turn (an instruction with no reply,
    // or tool_results with no following assistant). Strip back to a clean assistant
    // turn (or empty) so the next API call stays valid and roles still alternate.
    while (history.length) {
      const last = history[history.length - 1]
      if (last.role === 'user') {
        history.pop()
        continue
      }
      const hasToolUse = Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_use')
      if (hasToolUse) {
        history.pop()
        continue
      }
      break
    }
  }

  async function handle(text, from, myRunId, signal) {
    rollbackToStable()
    trim()
    history.push({ role: 'user', content: `${from} says: ${text}` })

    while (true) {
      if (myRunId !== runId) return // a newer instruction took over
      if (overRateLimit()) {
        console.error(`[agent] rate limit reached (${MAX_CALLS_PER_MIN} API calls/min) — pausing to avoid runaway token use.`)
        return
      }
      let response
      try {
        response = await client.messages.create(
          { model: MODEL, max_tokens: 1024, system: SYSTEM, tools, messages: history },
          { signal }
        )
      } catch (e) {
        if (myRunId !== runId) return // aborted by the newer instruction; stay quiet
        throw e
      }
      if (myRunId !== runId) return

      const toolUses = response.content.filter((b) => b.type === 'tool_use')
      if (toolUses.length === 0) {
        history.push({ role: 'assistant', content: response.content })
        const said = response.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join(' ')
          .trim()
        if (said) console.log('[claude]', said)
        return
      }

      // Run the tools before committing this turn, so an interrupt mid-tool leaves
      // no orphaned tool_use in history.
      const results = []
      for (const tu of toolUses) {
        if (myRunId !== runId) return
        let out
        try {
          out = await dispatch(bot, tu.name, tu.input)
        } catch (e) {
          out = `Error running ${tu.name}: ${e.message}`
        }
        if (myRunId !== runId) return // abandoned; discard this result
        console.log(`[tool] ${tu.name}(${JSON.stringify(tu.input)}) -> ${out}`)
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: String(out) })
      }
      if (myRunId !== runId) return
      history.push({ role: 'assistant', content: response.content })
      history.push({ role: 'user', content: results })
    }
  }

  function processInstruction(text, from) {
    // Preempt: abandon whatever is running and act on this instruction instead.
    runId += 1
    const myRunId = runId
    if (controller) controller.abort() // cancel the previous run's in-flight API call
    controller = new AbortController()

    // Unblock any in-progress movement/digging so a stuck action returns at once.
    bot.cmdSeq = (bot.cmdSeq || 0) + 1 // signal long-running tools to bail
    try { bot.pathfinder.setGoal(null) } catch {}
    try { bot.clearControlStates() } catch {}
    try { bot.stopDigging() } catch {}

    return handle(text, from, myRunId, controller.signal).catch((e) => {
      if (myRunId === runId) console.error('[agent error]', e.message)
    })
  }

  return { processInstruction }
}

module.exports = { createAgent }
