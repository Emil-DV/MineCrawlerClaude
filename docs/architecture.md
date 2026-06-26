# Architecture

How MineCrawler-Claude lets Claude control a Minecraft character.

```mermaid
flowchart TD
    subgraph player["Player"]
        PC["In-game chat (press T)"]
        CON["Terminal console (stdin)"]
    end

    subgraph bot["ClaudeBot process (node src/index.js)"]
        IDX["index.js<br/>creates mineflayer bot,<br/>loads pathfinder,<br/>listens to chat + console"]
        AG["agent.js<br/>think/act loop"]
        TL["tools.js<br/>25 tool definitions + dispatch"]
        ACT["minecraft-actions.js<br/>action implementations"]
        VIEW["prismarine-viewer<br/>localhost:3007"]
    end

    API["Anthropic Messages API<br/>(claude-sonnet-4-6)<br/>system + tools + history"]

    subgraph mc["Minecraft server (server.jar)"]
        WORLD["World / blocks / entities"]
    end

    PC -->|"bot.on('chat')"| IDX
    CON -->|"readline"| IDX
    IDX -->|"processInstruction(text, from)"| AG

    AG -->|"preempt: runId++, abort API call,<br/>pathfinder.setGoal null"| AG
    AG -->|"messages.create(history, tools)"| API
    API -->|"tool_use blocks"| AG
    AG -->|"no tool_use → final text"| OUT["console: [claude] reply"]

    AG -->|"dispatch(bot, name, input)"| TL
    TL --> ACT
    ACT -->|"bot.dig / placeBlock /<br/>pathfinder.goto / chat / attack…"| WORLD
    WORLD -->|"block & entity state<br/>(observe, findBlocks)"| ACT
    ACT -->|"result string"| TL
    TL -->|"tool_result"| AG
    AG -->|"append to history,<br/>loop until no tool_use"| AG

    WORLD -.->|"renders"| VIEW
    AG -->|"chat tool → bot.chat()"| WORLD
    WORLD -.->|"shows reply in chat"| PC
```

## How it works

1. **Two input paths** — in-game chat (`bot.on('chat')`) and the terminal console
   (`readline`), both feeding `agent.processInstruction`.
2. **The think/act loop** (`agent.js → handle`): send conversation history + tool
   definitions to the Anthropic API → it returns `tool_use` requests → `dispatch`
   runs the matching action against the mineflayer bot → the result string goes back
   into history → repeat until the model stops calling tools and emits a final reply.
3. **Preemption**: a new instruction bumps `runId`, aborts the in-flight API call, and
   clears the pathfinder goal — so a new command *abandons* the current one instead of
   queuing behind it. History is committed only as matched `tool_use`/`tool_result`
   pairs, and `rollbackToStable()` cleans any dangling turn left by an interrupt.
4. **Perception** — `observe`/`findBlocks` read world state (position, facing,
   inventory, nearby entities, notable blocks) back *from* the world; actions like
   `digBlock`/`placeBlock`/`pathfinder.goto` write *to* it.
5. **Viewer** — `prismarine-viewer` renders the world at `localhost:3007`, independent
   of the LLM loop.

## Files

| File | Responsibility |
| --- | --- |
| `src/index.js` | Connects the mineflayer bot, wires chat/console input, starts the viewer |
| `src/agent.js` | Anthropic think/act loop, preemption, conversation history |
| `src/tools.js` | Tool schemas exposed to Claude + `dispatch` to actions |
| `src/minecraft-actions.js` | Concrete bot actions (move, mine, build, fill, fight, craft, perceive…) |
| `scripts/start-server.mjs` | Launches the local Minecraft server |
| `scripts/smoke-test.js` | Non-destructive in-world check that every action runs |
</content>
