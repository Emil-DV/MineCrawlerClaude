// Concrete things the bot can do in the world. Each returns a short string
// that gets fed back to Claude as the tool result, so keep them descriptive.
const { goals } = require('mineflayer-pathfinder')
const { Vec3 } = require('vec3')
const fs = require('fs')
const path = require('path')

// Unit offsets to the six neighbours of a block.
const FACES = [
  new Vec3(0, -1, 0),
  new Vec3(0, 1, 0),
  new Vec3(-1, 0, 0),
  new Vec3(1, 0, 0),
  new Vec3(0, 0, -1),
  new Vec3(0, 0, 1),
]

function mcData(bot) {
  return require('minecraft-data')(bot.version)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Reject if a promise (a goto/place/look) hasn't settled in time, so one stuck
// navigation can't hang a whole build.
const withTimeout = (p, ms) => Promise.race([p, sleep(ms).then(() => { throw new Error('timeout') })])

// Standalone/AI preemption: a long-running action records bot.cmdSeq at the start
// and bails when it changes (a newer command or "stop" arrived). Outside the modes
// that set bot.cmdSeq it stays undefined, so this is a harmless no-op.
const startSeq = (bot) => bot.cmdSeq
const preempted = (bot, seq) => bot.cmdSeq !== seq

// Blocks a player can build into — placing here replaces them rather than being blocked.
const REPLACEABLE = new Set([
  'air', 'cave_air', 'void_air', 'water', 'lava',
  'short_grass', 'grass', 'tall_grass', 'fern', 'large_fern',
  'seagrass', 'tall_seagrass', 'snow', 'fire', 'vine',
])

// Structures worth surfacing in ambient awareness (ores are matched separately).
const STRUCTURES = new Set([
  'chest', 'trapped_chest', 'ender_chest', 'barrel',
  'crafting_table', 'furnace', 'blast_furnace', 'smoker',
  'spawner', 'anvil', 'enchanting_table', 'brewing_stand', 'beacon',
])
const isNotable = (b) => !!b && (b.name.includes('ore') || b.name.includes('_bed') || STRUCTURES.has(b.name))

// Nearby notable blocks (ores, chests, crafting stations, beds) for ambient awareness.
function nearbyNotableBlocks(bot) {
  let positions = []
  try {
    positions = bot.findBlocks({ matching: isNotable, maxDistance: 10, count: 6 })
  } catch {
    return []
  }
  return positions.map((p) => {
    const b = bot.blockAt(p)
    return {
      block: b ? b.name : 'block',
      at: { x: p.x, y: p.y, z: p.z },
      distance: Math.round(bot.entity.position.distanceTo(p)),
    }
  })
}

// Mineflayer yaw radians per cardinal direction. NOTE: in Mineflayer yaw=0 faces
// NORTH (-z), increasing clockwise (π/2=west, π=south, 3π/2=east). Getting this
// backwards makes "forward" point behind the bot on the north/south axis.
const YAW_BY_DIR = { north: 0, west: Math.PI / 2, south: Math.PI, east: (3 * Math.PI) / 2 }
const FORWARD_BY_DIR = { south: { x: 0, z: 1 }, west: { x: -1, z: 0 }, north: { x: 0, z: -1 }, east: { x: 1, z: 0 } }

function cardinalFromYaw(yaw) {
  const deg = (((yaw * 180) / Math.PI) % 360 + 360) % 360
  return ['north', 'west', 'south', 'east'][Math.round(deg / 90) % 4]
}

// Map the bot's yaw to a cardinal facing and the unit step "forward".
function facing(bot) {
  const card = cardinalFromYaw(bot.entity.yaw)
  return { cardinal: card, forward: FORWARD_BY_DIR[card], yaw: Math.round((((bot.entity.yaw * 180) / Math.PI) % 360 + 360) % 360) }
}

// Resolve forward/back/left/right (and f/b/l/r) to a horizontal unit vector,
// relative to a "forward" vector F = {x, z}. Left = (F.z, -F.x), right = -left.
function relDir(d) {
  return {
    f: 'forward', forward: 'forward',
    b: 'backward', back: 'backward', backward: 'backward', backwards: 'backward',
    l: 'left', left: 'left',
    r: 'right', right: 'right',
  }[String(d).toLowerCase()] || null
}
const REL_VEC = {
  forward: (F) => ({ x: F.x, z: F.z }),
  backward: (F) => ({ x: -F.x, z: -F.z }),
  left: (F) => ({ x: F.z, z: -F.x }),
  right: (F) => ({ x: -F.z, z: F.x }),
}

function observe(bot) {
  const pos = bot.entity.position
  const inventory = bot.inventory.items().map((i) => `${i.name} x${i.count}`)
  const nearby = Object.values(bot.entities)
    .filter((e) => e !== bot.entity && e.position && bot.entity.position.distanceTo(e.position) < 24)
    .map((e) => {
      const info = {
        name: e.username || e.name || e.displayName || e.kind || 'entity',
        distance: Math.round(bot.entity.position.distanceTo(e.position)),
      }
      // For players, report which way they face so "my left/right" can be resolved.
      if (e.username && e.yaw != null) info.facing = cardinalFromYaw(e.yaw)
      return info
    })
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 10)

  return JSON.stringify(
    {
      position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
      facing: facing(bot),
      health: bot.health,
      food: bot.food,
      dimension: bot.game?.dimension,
      timeOfDay: bot.time?.timeOfDay,
      heldItem: bot.heldItem?.name ?? 'nothing',
      inventory: inventory.length ? inventory : 'empty',
      nearbyEntities: nearby,
      notableBlocks: nearbyNotableBlocks(bot),
    },
    null,
    2
  )
}

function chat(bot, { message }) {
  bot.chat(message)
  return `Said in chat: "${message}"`
}

// Pause for a number of seconds — handy between ";"-separated commands. Cut short
// if a new command comes in.
async function wait(bot, { seconds = 1 }) {
  const seq = startSeq(bot)
  const total = Math.max(0, Math.min(Number(seconds) || 0, 300)) // cap at 5 min
  const end = Date.now() + total * 1000
  while (Date.now() < end) {
    if (preempted(bot, seq)) return `Waited — interrupted by a new command.`
    await sleep(Math.min(200, end - Date.now()))
  }
  return `Waited ${total}s.`
}

function healthStatus(bot) {
  const hp = Math.round(bot.health ?? 0)
  const food = Math.round(bot.food ?? 0)
  const mood = hp >= 18 && food >= 16 ? 'Feeling great' : hp >= 10 ? 'Doing okay' : 'Not great'
  return `${mood} — health ${hp}/20, hunger ${food}/20.`
}

function inventory(bot) {
  const items = bot.inventory.items()
  const total = (bot.inventory.inventoryEnd - bot.inventory.inventoryStart) || 36 // main inventory slots
  const used = items.length
  const pct = Math.round((used / total) * 100)
  if (!items.length) return `Inventory is empty (0% full).`
  // Consolidate stacks: sum counts per item name.
  const counts = {}
  for (const i of items) counts[i.name] = (counts[i.name] || 0) + i.count
  const list = Object.entries(counts).map(([n, c]) => `${n} x${c}`)
  return `Inventory ${used}/${total} slots (${pct}% full), ${list.length} type${list.length === 1 ? '' : 's'}: ${list.join(', ')}.`
}

async function goTo(bot, { x, y, z }) {
  try {
    await bot.pathfinder.goto(new goals.GoalBlock(x, y, z))
  } catch (e) {
    return `Couldn't walk to (${x}, ${y}, ${z}) — no clear path without breaking or placing blocks.`
  }
  const p = bot.entity.position
  return `Arrived near (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}).`
}

// Instant teleport (vs. goTo which walks there). Needs the bot to be opped.
function tpXYZ(bot, { x, y, z }) {
  bot.chat(`/tp ${bot.username} ${x} ${y} ${z}`)
  return `Teleporting to (${x}, ${y}, ${z}).`
}

async function goToPlayer(bot, { username, range = 2 }) {
  const target = bot.players[username]?.entity
  if (!target) return `Can't see player "${username}".`
  // Come without modifying the world: no digging or block placing.
  if (bot.followMovements) bot.pathfinder.setMovements(bot.followMovements)
  const p = target.position
  try {
    await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, range))
  } catch (e) {
    return `Couldn't reach ${username} on foot — no clear path without breaking or placing blocks.`
  }
  // Let summoned bots gather: pause personal-space briefly so the bot doesn't
  // shove off another bot that arrives next to it.
  bot.gatherUntil = Date.now() + 8000
  return `Reached ${username}.`
}

function followPlayer(bot, { username, range = 2 }) {
  const target = bot.players[username]?.entity
  if (!target) return `Can't see player "${username}".`
  // Follow without modifying the world: no digging or block placing.
  if (bot.followMovements) bot.pathfinder.setMovements(bot.followMovements)
  bot.pathfinder.setGoal(new goals.GoalFollow(target, range), true)
  bot.gatherUntil = Date.now() + 8000
  return `Now following ${username} (without breaking or placing blocks).`
}

function stop(bot) {
  bot.pathfinder.setGoal(null)
  bot.clearControlStates()
  return 'Stopped moving.'
}

async function lookDirection(bot, { direction }) {
  if (!(direction in YAW_BY_DIR)) return `Unknown direction "${direction}". Use north, south, east, or west.`
  await bot.look(YAW_BY_DIR[direction], 0, true)
  return `Now facing ${direction}.`
}

async function digTestTunnel(bot, { depth = 5 }) {
  const fwd = FORWARD_BY_DIR[cardinalFromYaw(bot.entity.yaw)]
  const startY = Math.floor(bot.entity.position.y)
  const frontBlock = (y) => {
    const bx = Math.floor(bot.entity.position.x)
    const bz = Math.floor(bot.entity.position.z)
    return bot.blockAt(new Vec3(bx + fwd.x, y, bz + fwd.z))
  }
  const stepForward = () => {
    const bx = Math.floor(bot.entity.position.x)
    const bz = Math.floor(bot.entity.position.z)
    return bot.pathfinder.goto(new goals.GoalBlock(bx + fwd.x, startY, bz + fwd.z)).then(() => true).catch(() => false)
  }

  // Walk forward until a wall is directly ahead (or give up after a while).
  for (let i = 0; i < 32; i++) {
    const ahead = frontBlock(startY)
    if (ahead && ahead.name !== 'air') break
    if (!(await stepForward())) break
  }

  // Left/right unit vectors relative to facing.
  const left = { x: fwd.z, z: -fwd.x }
  const right = { x: -fwd.z, z: fwd.x }

  // Place a wall torch on the upper (head-level) side wall, in the already-mined
  // cell behind the bot, on the given side. Restores the digging tool. Returns
  // true if placed.
  const placeWallTorch = async (side) => {
    const torch = bot.inventory.items().find((i) => i.name === 'torch')
    if (!torch) return false
    const dir = side === 'left' ? left : right
    const bx = Math.floor(bot.entity.position.x), bz = Math.floor(bot.entity.position.z)
    const cellX = bx - fwd.x, cellZ = bz - fwd.z, y = startY + 1 // mined cell behind, upper block
    const cell = bot.blockAt(new Vec3(cellX, y, cellZ))
    const wall = bot.blockAt(new Vec3(cellX + dir.x, y, cellZ + dir.z)) // side wall to attach to
    if ((cell && cell.name !== 'air') || !wall || wall.boundingBox !== 'block') return false
    const tool = bot.heldItem
    try {
      await bot.equip(torch, 'hand')
      // Place against the wall's inner face: new block lands at wall - dir = the cell.
      await bot.placeBlock(wall, new Vec3(-dir.x, 0, -dir.z))
      if (tool) await bot.equip(tool, 'hand') // restore the pickaxe
      return true
    } catch {
      return false
    }
  }

  // Classify a block the tunnel is about to mine into: open space or liquid stops it.
  const stopKind = (b) => {
    if (!b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') return 'air'
    if (b.name === 'water' || b.name === 'bubble_column') return 'water'
    if (b.name === 'lava') return 'lava'
    return null
  }

  // Mine a 1-wide, 2-high tunnel `depth` blocks deep, staying at the same level.
  const seq = startSeq(bot)
  let mined = 0
  let torches = 0
  let stopped = null
  for (let i = 0; i < depth; i++) {
    if (preempted(bot, seq)) { stopped = 'stop'; break }
    const head = frontBlock(startY + 1)
    const feet = frontBlock(startY)
    // Abort if the next blocks are open space or liquid (broke into a cave/water/lava).
    const hit = stopKind(head) || stopKind(feet)
    if (hit) { stopped = hit; break }
    for (const b of [head, feet]) {
      if (b && bot.canDigBlock(b)) { await bot.dig(b); mined++ }
    }
    await stepForward()
    // A torch every 10 blocks, alternating left/right upper walls.
    if ((i + 1) % 10 === 0) { if (await placeWallTorch(torches % 2 === 0 ? 'left' : 'right')) torches++ }
  }
  const p = bot.entity.position
  const note = stopped === 'stop' ? ' Stopped.' : stopped ? ` Stopped early — hit ${stopped} ahead.` : ''
  return `Tunnel dug ${mined ? Math.ceil(mined / 2) : 0} deep at y=${startY} (mined ${mined} blocks, placed ${torches} torch(es)).${note} Now at (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}).`
}

const flooredPos = (bot) => new Vec3(Math.floor(bot.entity.position.x), Math.floor(bot.entity.position.y), Math.floor(bot.entity.position.z))

// Mine the block at pos if it's solid and diggable (right tool auto-equipped).
// Returns true if the cell ends up air. Leaves air/liquid/bedrock alone.
async function mineAt(bot, pos) {
  const b = bot.blockAt(pos)
  if (!b) return false
  if (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air') return true
  if (b.name === 'water' || b.name === 'lava' || b.name === 'bedrock') return false
  await equipBestToolForBlock(bot, b)
  if (!bot.canDigBlock(b)) return false
  try { await bot.dig(b) } catch { return false }
  return true
}

// Place a WALL torch at head height beside `pos` (overhead of the step, not on the
// tread you walk on), lighting the path. Best-effort; restores the held tool.
async function dropTorch(bot, pos) {
  const torch = bot.inventory.items().find((i) => i.name === 'torch')
  if (!torch) return false
  const cell = pos.offset(0, 1, 0) // head-level air cell above the step
  const here = bot.blockAt(cell)
  if (here && here.name !== 'air') return false
  const held = bot.heldItem
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const wall = bot.blockAt(cell.offset(dx, 0, dz))
    if (!wall || wall.boundingBox !== 'block') continue // need a solid side wall to hang on
    try {
      await bot.equip(torch, 'hand')
      await bot.placeBlock(wall, new Vec3(-dx, 0, -dz)) // torch clings to the wall's inner face
      if (held && (!bot.heldItem || bot.heldItem.type !== held.type)) { try { await bot.equip(held, 'hand') } catch { /* ignore */ } }
      return true
    } catch { /* try another wall */ }
  }
  return false
}

// Dig a descending spiral staircase: each step is one block forward and one down,
// turning north→east→south→west every 4 blocks, for `depth` blocks. Places a torch
// every few steps (needs torches). Lays a tread if it opens into a void.
async function mineDownshaft(bot, { depth = 16 }) {
  const n = Math.max(1, Math.min(Math.floor(Number(depth) || 0), 128))
  const LEGS = ['north', 'east', 'south', 'west']
  const seq = startSeq(bot)
  if (bot.defaultMovements) bot.pathfinder.setMovements(bot.defaultMovements)
  let feet = flooredPos(bot)
  let mined = 0, torches = 0, stuck = 0
  for (let step = 0; step < n; step++) {
    if (preempted(bot, seq)) return `Dug ${step} step(s) down — stopped.`
    const dir = FORWARD_BY_DIR[LEGS[Math.floor(step / 4) % 4]]
    const front = feet.offset(dir.x, 0, dir.z)
    const newFeet = front.offset(0, -1, 0)
    // Clear a 2-high descending passage: front head, front, and the step down.
    for (const p of [front.offset(0, 1, 0), front, newFeet]) if (await mineAt(bot, p)) mined++
    // Something to stand on at the new step; lay a block if it's a void.
    const tread = newFeet.offset(0, -1, 0), tb = bot.blockAt(tread)
    if (!tb || tb.boundingBox !== 'block') await placeOne(bot, pickFillBlock(bot) || 'cobblestone', tread)
    try { await bot.pathfinder.goto(new goals.GoalBlock(newFeet.x, newFeet.y, newFeet.z)) } catch { /* keep going */ }
    if (step % 4 === 0 && await dropTorch(bot, feet)) torches++
    const now = flooredPos(bot)
    if (now.y >= feet.y) { if (++stuck >= 3) return `Dug ${step} step(s) down, then got stuck (mined ${mined}, ${torches} torch(es)).` } else stuck = 0
    feet = now
  }
  await faceCommander(bot)
  return `Dug a spiral staircase down ${n} block(s) (mined ${mined}, placed ${torches} torch(es)).`
}

// Dig a straight ascending staircase in the direction the bot faces: each step is
// one block forward and one up, for `height` blocks. Clears headroom, lays a tread
// where the ground is missing, and drops a torch every few steps (needs torches).
async function mineStairwell(bot, { height = 8 }) {
  const n = Math.max(1, Math.min(Math.floor(Number(height) || 0), 128))
  const dir = FORWARD_BY_DIR[cardinalFromYaw(bot.entity.yaw)]
  const seq = startSeq(bot)
  if (bot.defaultMovements) bot.pathfinder.setMovements(bot.defaultMovements)
  let feet = flooredPos(bot)
  let mined = 0, torches = 0, stuck = 0
  for (let step = 0; step < n; step++) {
    if (preempted(bot, seq)) return `Dug ${step} step(s) up — stopped.`
    const front = feet.offset(dir.x, 0, dir.z)
    const newFeet = front.offset(0, 1, 0)
    // Clear headroom: the block ABOVE the bot's head (so it can rise), the new step,
    // and above the new step. (feet+1 is the bot's own head space — already air.)
    for (const p of [feet.offset(0, 2, 0), newFeet, newFeet.offset(0, 1, 0)]) if (await mineAt(bot, p)) mined++
    // A tread to step onto (front, same level); lay a block if it's not solid.
    const tb = bot.blockAt(front)
    if (!tb || tb.boundingBox !== 'block') await placeOne(bot, pickFillBlock(bot) || 'cobblestone', front)
    try { await bot.pathfinder.goto(new goals.GoalBlock(newFeet.x, newFeet.y, newFeet.z)) } catch { /* keep going */ }
    if (step % 4 === 0 && await dropTorch(bot, feet)) torches++
    const now = flooredPos(bot)
    if (now.y <= feet.y) { if (++stuck >= 3) return `Dug ${step} step(s) up, then got stuck (mined ${mined}, ${torches} torch(es)).` } else stuck = 0
    feet = now
  }
  await faceCommander(bot)
  return `Dug a staircase up ${n} block(s) (mined ${mined}, placed ${torches} torch(es)).`
}

// Nearest other player's entity (or null).
function nearestPlayer(bot) {
  const ps = Object.values(bot.players).filter((p) => p.username !== bot.username && p.entity)
  if (!ps.length) return null
  ps.sort((a, b) => bot.entity.position.distanceTo(a.entity.position) - bot.entity.position.distanceTo(b.entity.position))
  return ps[0].entity
}

// Tool tiers, best first, for picking the highest-grade tool of a kind.
const TOOL_TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden']

// Which tool best breaks a block — axe for wood, shovel for soil, pickaxe for
// stone/ore/metal. null = bare hand is fine (leaves, plants, wool, etc.).
function toolCategoryForBlock(name) {
  if (/_log$|_wood$|_planks$|_stem$|_hyphae$|_fence$|_fence_gate$|_door$|_trapdoor$|_sign$|_pressure_plate$|_button$|bookshelf|^chest$|trapped_chest|^barrel$|crafting_table|ladder|bamboo_block|note_block|jukebox|loom|composter|cartography_table|fletching_table|smithing_table|lectern|beehive|bee_nest|mangrove_roots|campfire|^wooden_|_boat$/.test(name)) return 'axe'
  if (/dirt|grass_block|^sand$|red_sand|gravel|^clay$|soul_sand|soul_soil|^mud$|muddy_mangrove_roots|snow|farmland|dirt_path|podzol|mycelium|coarse_dirt|rooted_dirt/.test(name)) return 'shovel'
  if (/stone|_ore$|cobble|deepslate|granite|diorite|andesite|obsidian|netherrack|brick|concrete|terracotta|basalt|blackstone|tuff|calcite|amethyst|raw_iron|raw_gold|raw_copper|furnace|anvil|^rail$|_block$|smoker|grindstone|^bell$|cauldron|hopper|spawner|end_stone|purpur|prismarine|magma_block|glowstone|sandstone|quartz|nether_brick|froglight|sculk|copper|ancient_debris/.test(name)) return 'pickaxe'
  return null
}

// Equip the best tool of a category ('axe'|'pickaxe'|'shovel'|'sword') if the bot
// has one and isn't already holding it. Returns whether a tool of that kind exists.
async function equipBestOfCategory(bot, cat) {
  const suffix = '_' + cat
  const tools = bot.inventory.items().filter((i) => i.name.endsWith(suffix))
  if (!tools.length) return false
  tools.sort((a, b) => TOOL_TIERS.indexOf(a.name.split('_')[0]) - TOOL_TIERS.indexOf(b.name.split('_')[0]))
  const best = tools[0]
  if (!bot.heldItem || bot.heldItem.name !== best.name) {
    try { await bot.equip(best, 'hand') } catch { /* ignore */ }
  }
  return true
}

// Auto-equip the right tool for a block before digging it.
async function equipBestToolForBlock(bot, block) {
  if (!block) return
  const cat = toolCategoryForBlock(block.name)
  if (cat) await equipBestOfCategory(bot, cat)
}

// Armor material ranking (defence / upgrade order) and the four armor slots
// (5=head, 6=torso, 7=legs, 8=feet in the player inventory window).
const ARMOR_RANK = { leather: 0, golden: 1, chainmail: 2, turtle: 2, iron: 3, diamond: 4, netherite: 5 }
const ARMOR_SLOTS = [
  { dest: 'head', suffix: '_helmet', idx: 5 },
  { dest: 'torso', suffix: '_chestplate', idx: 6 },
  { dest: 'legs', suffix: '_leggings', idx: 7 },
  { dest: 'feet', suffix: '_boots', idx: 8 },
]
const armorRank = (name) => (name ? (ARMOR_RANK[name.split('_')[0]] ?? -1) : -1)

// Put on any armor piece the bot is carrying that beats what it's wearing (by
// material). Returns the names of pieces it upgraded to (possibly empty). Safe to
// call repeatedly; skips while a container window is open so it won't fight a chest.
async function equipBetterArmor(bot) {
  if (!bot.entity || !bot.inventory || bot.currentWindow) return []
  const upgraded = []
  for (const slot of ARMOR_SLOTS) {
    const worn = bot.inventory.slots[slot.idx]
    const wornRank = worn ? armorRank(worn.name) : -1
    const cands = bot.inventory.items().filter((i) => i.name.endsWith(slot.suffix))
    if (!cands.length) continue
    cands.sort((a, b) => armorRank(b.name) - armorRank(a.name))
    if (armorRank(cands[0].name) > wornRank) {
      try { await bot.equip(cands[0], slot.dest); upgraded.push(cands[0].name) } catch { /* couldn't equip */ }
    }
  }
  return upgraded
}

async function mineNearestBlock(bot, { blockName, count = 4096 }) {
  const block = mcData(bot).blocksByName[blockName]
  if (!block) return `Unknown block type "${blockName}".`

  const seq = startSeq(bot)
  // Only target blocks the bot can actually see (clear line of sight) — no x-ray.
  const scan = () => bot.findBlocks({ matching: block.id, maxDistance: 48, count: 64, useExtraInfo: (b) => bot.canSeeBlock(b) })

  let mined = 0
  let approaches = 0 // times we've walked toward hidden ore without mining — a loop backstop
  for (let i = 0; i < count; i++) {
    if (preempted(bot, seq)) return `Mined ${mined} ${blockName} — stopped.`
    // Re-scanned each loop, so blocks exposed by earlier digging become eligible.
    let positions = scan()
    if (!positions.length) {
      // Look around in every direction (cardinals + up + down) before giving up,
      // then re-scan once. Visibility is line-of-sight from the bot's eyes, so the
      // turning is a survey gesture; the re-scan also catches blocks whose chunks
      // just finished loading as the bot pauses at each heading.
      const headings = [[0, 0], [Math.PI / 2, 0], [Math.PI, 0], [(3 * Math.PI) / 2, 0], [bot.entity.yaw, -1.0], [bot.entity.yaw, 1.0]]
      for (const [yaw, pitch] of headings) {
        if (preempted(bot, seq)) return `Mined ${mined} ${blockName} — stopped.`
        await bot.look(yaw, pitch, true)
        await sleep(200)
      }
      positions = scan()
      if (!positions.length) {
        // Nothing in sight even after looking. If there's ore we can detect but not
        // see (buried/behind blocks), walk as close as the terrain allows — without
        // digging — to try to expose it, then re-scan. Give up only when we can't
        // get any nearer (or after too many fruitless approaches).
        const hidden = bot.findBlocks({ matching: block.id, maxDistance: 48, count: 64 })
        if (!hidden.length || ++approaches > 20) break
        hidden.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b))
        const h = hidden[0]
        const before = bot.entity.position.distanceTo(h)
        for (const r of [2, 8]) { // smallest reachable range = as close as possible
          if (preempted(bot, seq)) return `Mined ${mined} ${blockName} — stopped.`
          try { await bot.pathfinder.goto(new goals.GoalNear(h.x, h.y, h.z, r)); break } catch { /* try wider */ }
        }
        if (preempted(bot, seq)) return `Mined ${mined} ${blockName} — stopped.`
        positions = scan()
        if (!positions.length) {
          if (before - bot.entity.position.distanceTo(h) < 1) break // couldn't get closer
          continue // got closer — re-scan next loop (it may be visible now)
        }
      }
    }

    // Always take the closest block from where the bot stands, and clear one row
    // before drifting to the next — so it works outward steadily instead of
    // meandering toward far-off blocks. Near-ties break by staying on the same
    // height/row (stable axis order) to keep the path smooth.
    positions.sort((a, b) => {
      const da = bot.entity.position.distanceTo(a)
      const db = bot.entity.position.distanceTo(b)
      if (Math.abs(da - db) > 0.5) return da - db
      return (a.y - b.y) || (a.x - b.x) || (a.z - b.z)
    })

    const pos = positions[0]
    const target = bot.blockAt(pos)
    if (!target) break
    await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true) // look toward it as it goes
    await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2)).catch(() => {})
    await equipBestToolForBlock(bot, target) // pickaxe/axe/shovel to suit the block
    if (!bot.canDigBlock(target)) return `Mined ${mined}; can't dig the next ${blockName} (wrong tool?).`
    await bot.dig(target)
    mined++
  }
  // Done — nothing left to mine (or count reached). Turn to face the commander.
  await faceCommander(bot)
  if (mined > 0) return `Mined ${mined} ${blockName}.`
  return `No visible ${blockName} found within range (any nearby may be hidden behind blocks).`
}

async function digBlock(bot, { x, y, z }) {
  const block = bot.blockAt(new Vec3(x, y, z))
  if (!block || block.name === 'air') return `Nothing to mine at (${x}, ${y}, ${z}) (it's air).`
  await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3)).catch(() => {})
  await equipBestToolForBlock(bot, block) // pickaxe/axe/shovel to suit the block
  if (!bot.canDigBlock(block)) return `Can't dig ${block.name} at (${x}, ${y}, ${z}) — wrong tool or out of reach.`
  try {
    await bot.dig(block)
  } catch (e) {
    return `Couldn't mine ${block.name} at (${x}, ${y}, ${z}): ${e.message}`
  }
  return `Mined ${block.name} at (${x}, ${y}, ${z}).`
}

async function equipItem(bot, { itemName }) {
  const items = bot.inventory.items()
  // Prefer an exact name match (so "beetroot" doesn't grab "beetroot_seeds");
  // fall back to a partial match only if there's no exact one.
  const item = items.find((i) => i.name === itemName) || items.find((i) => i.name.includes(itemName))
  if (!item) { bot.missingItem = itemName; return `No "${itemName}" in inventory.` }
  await bot.equip(item, 'hand')
  return `Equipped ${item.name}.`
}

async function dropItem(bot, { itemName, count }) {
  const items = bot.inventory.items()
  // Exact name match first (so "beetroot" isn't read as "beetroot_seeds").
  const item = items.find((i) => i.name === itemName) || items.find((i) => i.name.includes(itemName))
  if (!item) return `No "${itemName}" in inventory.`
  const toDrop = count ? Math.min(count, item.count) : item.count
  await bot.toss(item.type, null, toDrop)
  return `Dropped ${toDrop} ${item.name}.`
}

// Largest number of blocks one bulk-build call will place.
const MAX_BLOCKS = 512

// How long to keep a chest visibly open (ms) so the open/close looks deliberate.
const CHEST_PAUSE = 600

// Place one block at a target Vec3. Returns a status code, not a message,
// so callers can loop over many placements and summarise the result.
async function placeOne(bot, blockName, target) {
  const item = bot.inventory.items().find((i) => i.name === blockName || i.name.includes(blockName))
  if (!item) { bot.missingItem = blockName; return 'no-item' }
  const existing = bot.blockAt(target)
  if (existing && !REPLACEABLE.has(existing.name)) return 'occupied'

  // Place against a solid neighbour; the new block lands at reference + faceVector.
  let reference = null
  let faceVector = null
  for (const dir of FACES) {
    const ref = bot.blockAt(target.minus(dir))
    if (ref && ref.boundingBox === 'block') {
      reference = ref
      faceVector = dir
      break
    }
  }
  if (!reference) return 'no-support'

  // Placing may need to dig/scaffold to reach the spot, so use build movements for
  // positioning (the default is non-destructive). If there's no path, try to place
  // from where we are anyway.
  if (bot.buildMovements) bot.pathfinder.setMovements(bot.buildMovements)
  await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 3)).catch(() => {})
  if (bot.defaultMovements) bot.pathfinder.setMovements(bot.defaultMovements) // back to non-destructive once positioned
  await bot.equip(item, 'hand')
  try {
    await bot.placeBlock(reference, faceVector)
  } catch (e) {
    // Placement can be rejected or its confirmation event can time out (common in
    // water). The block often did land, so verify before giving up; either way,
    // return a status instead of throwing so a bulk fill continues past this cell.
    const now = bot.blockAt(target)
    if (now && (now.name === item.name || now.name.includes(blockName))) return 'placed'
    return 'failed'
  }
  return 'placed'
}

async function placeBlock(bot, { blockName, x, y, z }) {
  // No coordinates given → place in the cell just in front of the bot (foot level).
  if (x == null || y == null || z == null) {
    const fwd = FORWARD_BY_DIR[cardinalFromYaw(bot.entity.yaw)]
    x = Math.floor(bot.entity.position.x) + fwd.x
    y = Math.floor(bot.entity.position.y)
    z = Math.floor(bot.entity.position.z) + fwd.z
  }
  const r = await placeOne(bot, blockName, new Vec3(x, y, z))
  if (r === 'no-item') return `No "${blockName}" in inventory to place.`
  if (r === 'occupied') return `(${x}, ${y}, ${z}) is already occupied.`
  if (r === 'no-support') return `Nothing solid next to (${x}, ${y}, ${z}) to place against.`
  if (r === 'failed') return `Couldn't place at (${x}, ${y}, ${z}) — placement was rejected or timed out.`
  return `Placed ${blockName} at (${x}, ${y}, ${z}).`
}

// Place a block at every cell in `cells`, retrying ones that fail (occupied by a
// player/bot, or temporarily unsupported) in further passes until a pass makes no
// progress. Cells that are already non-fillable (solid) count as skipped, not missing.
// --- Creative fast-build ---------------------------------------------------
// When the bot is in creative mode AND opped, whole regions can be laid with
// /fill instead of walking and placing each block by hand. Build commands try
// this path first; if it doesn't apply (survival, or not opped) they fall back
// to their normal hand-placement.
const inCreative = (bot) => bot.game?.gameMode === 'creative'
const cleanName = (name) => String(name).replace(/^minecraft:/, '')

// True only if the bot is in creative and its commands actually take effect.
// Probed by setting a throwaway block high in the air and checking it applied,
// then clearing it — so a creative-but-not-opped bot falls back to hand-placing.
async function canOpBuild(bot) {
  if (!inCreative(bot)) return false
  // Probe an already-air cell above the bot so the test never destroys anything.
  const bx = Math.floor(bot.entity.position.x), bz = Math.floor(bot.entity.position.z)
  let p = null
  for (let dy = 30; dy <= 40; dy++) {
    const c = new Vec3(bx, Math.min(Math.floor(bot.entity.position.y) + dy, 318), bz)
    if (bot.blockAt(c)?.name === 'air') { p = c; break }
  }
  if (!p) return false // no safe spot to probe — fall back to hand-placement
  bot.chat(`/setblock ${p.x} ${p.y} ${p.z} minecraft:obsidian`)
  await sleep(400)
  const ok = bot.blockAt(p)?.name === 'obsidian'
  if (ok) bot.chat(`/setblock ${p.x} ${p.y} ${p.z} minecraft:air`) // restore the air cell
  return ok
}

// Fill an inclusive box with /fill, split into <=32768-block Y-slabs (the vanilla
// per-command cap). mode is '', 'keep' (air only), 'hollow', 'outline', etc.
async function opFill(bot, a, b, blockName, mode = '') {
  const block = cleanName(blockName)
  const lo = new Vec3(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z))
  const hi = new Vec3(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z))
  const layers = Math.max(1, Math.floor(32768 / ((hi.x - lo.x + 1) * (hi.z - lo.z + 1))))
  for (let y = lo.y; y <= hi.y; y += layers) {
    const y2 = Math.min(hi.y, y + layers - 1)
    bot.chat(`/fill ${lo.x} ${y} ${lo.z} ${hi.x} ${y2} ${hi.z} minecraft:${block}${mode ? ' ' + mode : ''}`)
  }
  await sleep(300) // let the change propagate back before the caller reads the world
}

async function placeCells(bot, blockName, cells) {
  const seq = startSeq(bot)
  let placed = 0
  let pending = cells
  let skipped = 0
  let ranOut = false
  for (let pass = 0; pass < 5 && pending.length; pass++) {
    const retry = []
    let progress = 0
    for (const c of pending) {
      if (preempted(bot, seq)) return { placed, skipped, missing: pending.length, ranOut, stopped: true }
      const r = await placeOne(bot, blockName, c)
      if (r === 'placed') { placed++; progress++ }
      else if (r === 'no-item') { ranOut = true; break }
      else if (r === 'occupied') skipped++ // already solid — not missing
      else retry.push(c) // 'failed' or 'no-support' — try again next pass
    }
    if (ranOut) break
    pending = retry
    if (progress === 0) break // no cell could be placed this pass — give up
  }
  return { placed, skipped, missing: pending.length, ranOut }
}

async function fillArea(bot, { blockName, x1, y1, z1, x2, y2, z2 }) {
  const [xa, xb] = [Math.min(x1, x2), Math.max(x1, x2)]
  const [ya, yb] = [Math.min(y1, y2), Math.max(y1, y2)]
  const [za, zb] = [Math.min(z1, z2), Math.max(z1, z2)]
  const volume = (xb - xa + 1) * (yb - ya + 1) * (zb - za + 1)
  if (volume > MAX_BLOCKS) return `That region is ${volume} blocks; max ${MAX_BLOCKS} per call. Use a smaller area.`

  if (await canOpBuild(bot)) { // creative + opped: fill it instantly
    await opFill(bot, new Vec3(xa, ya, za), new Vec3(xb, yb, zb), blockName)
    return `Filled the ${volume}-block area with ${cleanName(blockName)} via /fill (creative).`
  }

  const cells = []
  for (let y = ya; y <= yb; y++) // bottom-up so each layer can support the next
    for (let x = xa; x <= xb; x++)
      for (let z = za; z <= zb; z++) cells.push(new Vec3(x, y, z))

  const { placed, skipped, missing, ranOut, stopped } = await placeCells(bot, blockName, cells)
  if (stopped) return `Filled ${placed} ${blockName} — stopped.`
  if (ranOut) return `Filled ${placed} ${blockName}, then ran out.`
  return `Filled ${placed} ${blockName} (${skipped} already solid${missing ? `, ${missing} unfillable: occupied by a player or no support` : ''}).`
}

async function buildWall(bot, { blockName, x, y, z, direction = 'x', length, height = 1 }) {
  const dx = direction === 'z' ? 0 : 1
  const dz = direction === 'z' ? 1 : 0
  const volume = length * height
  if (volume > MAX_BLOCKS) return `That wall is ${volume} blocks; max ${MAX_BLOCKS} per call. Use a smaller wall.`

  if (await canOpBuild(bot)) { // creative + opped: fill the whole plane at once
    const end = new Vec3(x + dx * (length - 1), y + height - 1, z + dz * (length - 1))
    await opFill(bot, new Vec3(x, y, z), end, blockName)
    return `Built the ${length}x${height} ${cleanName(blockName)} wall via /fill (creative).`
  }

  const cells = []
  for (let h = 0; h < height; h++) // bottom-up so lower blocks support the row above
    for (let l = 0; l < length; l++) cells.push(new Vec3(x + dx * l, y + h, z + dz * l))

  const { placed, skipped, missing, ranOut, stopped } = await placeCells(bot, blockName, cells)
  if (stopped) return `Built ${placed} ${blockName} — stopped.`
  if (ranOut) return `Built ${placed} ${blockName}, then ran out.`
  return `Built a ${blockName} wall: ${placed} placed (${skipped} already solid${missing ? `, ${missing} unfillable` : ''}).`
}

async function fillPit(bot) {
  const fx = Math.floor(bot.entity.position.x)
  const fy = Math.floor(bot.entity.position.y) // feet level (air the bot occupies)
  const fz = Math.floor(bot.entity.position.z)

  const floor = bot.blockAt(new Vec3(fx, fy - 1, fz))
  if (!floor || REPLACEABLE.has(floor.name)) return `Not standing on a solid block — nothing to match.`
  const fillName = floor.name
  if (!bot.inventory.items().some((i) => i.name === fillName || i.name.includes(fillName))) {
    bot.missingItem = fillName
    return `No "${fillName}" in inventory to fill the pit with.`
  }

  const isOpen = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return !b || REPLACEABLE.has(b.name) }
  const isSolid = (x, y, z) => { const b = bot.blockAt(new Vec3(x, y, z)); return b && b.boundingBox === 'block' }

  // Flood-fill the enclosed open cells at feet level to map the pit footprint.
  const MAX_FOOTPRINT = 256
  const key = (x, z) => `${x},${z}`
  const footprint = new Map([[key(fx, fz), [fx, fz]]])
  const queue = [[fx, fz]]
  while (queue.length && footprint.size <= MAX_FOOTPRINT) {
    const [x, z] = queue.shift()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz
      if (footprint.has(key(nx, nz))) continue
      if (isOpen(nx, fy, nz)) { footprint.set(key(nx, nz), [nx, nz]); queue.push([nx, nz]) }
    }
  }
  if (footprint.size > MAX_FOOTPRINT) return `Pit is too large (>${MAX_FOOTPRINT} wide) to fill in one call.`

  // Find the surrounding ground height from the wall columns around the footprint.
  const ringTops = []
  for (const [x, z] of footprint.values()) {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz
      if (footprint.has(key(nx, nz))) continue
      for (let y = fy + 12; y >= fy - 1; y--) {
        if (isSolid(nx, y, nz) && isOpen(nx, y + 1, nz)) { ringTops.push(y); break }
      }
    }
  }
  if (!ringTops.length) return `Doesn't look like a pit — no walls around you.`
  // Fill up to the most common rim height (the ground level).
  const counts = {}
  for (const y of ringTops) counts[y] = (counts[y] || 0) + 1
  const topY = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0])
  if (topY < fy) return `You're already at or above ground level — no pit to fill.`

  // Fill bottom-up, skipping the bot's own column (can't place where it stands).
  const seq = startSeq(bot)
  let placed = 0, skipped = 0, failed = 0
  const selfCol = key(fx, fz)
  for (let y = fy; y <= topY; y++) {
    if (preempted(bot, seq)) return `Filled ${placed} ${fillName} — stopped.`
    for (const [k, [x, z]] of footprint) {
      if (k === selfCol) continue
      const r = await placeOne(bot, fillName, new Vec3(x, y, z))
      if (r === 'placed') placed++
      else if (r === 'no-item') return `Filled ${placed} ${fillName}, then ran out.`
      else if (r === 'failed') failed++
      else skipped++
    }
  }

  // Fill the bot's own column by pillar-jumping up it, which also lifts the bot out.
  bot.setControlState('jump', false)
  for (let y = fy; y <= topY; y++) {
    const item = bot.inventory.items().find((i) => i.name === fillName || i.name.includes(fillName))
    if (!item) break
    if (!isOpen(fx, y, fz)) continue
    await bot.equip(item, 'hand')
    bot.setControlState('jump', true)
    await sleep(170) // rise off the current floor
    const ref = bot.blockAt(new Vec3(fx, y - 1, fz))
    try {
      if (ref && ref.boundingBox === 'block') { await bot.placeBlock(ref, new Vec3(0, 1, 0)); placed++ }
    } catch { failed++ }
    bot.setControlState('jump', false)
    await sleep(320) // settle onto the new block
  }
  bot.setControlState('jump', false)

  return `Filled the pit with ${placed} ${fillName} up to y=${topY} (${skipped} already solid, ${failed} failed).`
}

// Ground the bot can hoe straight to farmland.
const HOEABLE = new Set(['grass_block', 'dirt'])

// Crop name → the item you actually plant. Carrots/potatoes plant as the crop
// item itself, so they need no entry; only the "_seeds" crops are remapped.
const SEED_ALIASES = {
  wheat: 'wheat_seeds', beetroot: 'beetroot_seeds', beetroots: 'beetroot_seeds',
  pumpkin: 'pumpkin_seeds', pumpkins: 'pumpkin_seeds', melon: 'melon_seeds', melons: 'melon_seeds',
}
const normalizeSeed = (name) => SEED_ALIASES[String(name || '').toLowerCase()] || name

async function plantField(bot, { seedName }) {
  seedName = normalizeSeed(seedName) // "plant beetroot" → beetroot_seeds
  // Use the best hoe the bot owns (netherite > diamond > iron > stone > gold > wood).
  const hoes = bot.inventory.items().filter((i) => i.name.endsWith('_hoe'))
  if (!hoes.length) return `No hoe in inventory.`
  hoes.sort((a, b) => TOOL_TIERS.indexOf(a.name.split('_')[0]) - TOOL_TIERS.indexOf(b.name.split('_')[0]))
  const hoe = hoes[0]
  if (!bot.inventory.items().some((i) => i.name === seedName || i.name.includes(seedName))) {
    bot.missingItem = seedName
    return `No "${seedName}" in inventory.`
  }

  // Walk the field non-destructively — never let pathfinding dig through stones or
  // flowers to reach a cell (that drops cobblestone/peonies). Don't inherit a
  // build-movement a previous command may have left active.
  if (bot.followMovements) bot.pathfinder.setMovements(bot.followMovements)

  const fy = Math.floor(bot.entity.position.y) // feet level
  const floorY = fy - 1 // the ground the bot stands on
  const floorName = (x, z) => bot.blockAt(new Vec3(x, floorY, z))?.name
  // A wall is anything solid at feet level — it blocks the bot's path and bounds the field.
  const blocksPath = (x, z) => { const b = bot.blockAt(new Vec3(x, fy, z)); return !!b && b.boundingBox === 'block' }
  // A field cell: plantable ground below, and walkable (not walled off at feet level).
  const isField = (x, z) => {
    const fn = floorName(x, z)
    return (HOEABLE.has(fn) || fn === 'farmland') && !blocksPath(x, z)
  }

  // Flood-fill the flat area at the bot's feet, bounded by path-blocking walls.
  const MAX = 256
  const bx = Math.floor(bot.entity.position.x), bz = Math.floor(bot.entity.position.z)
  if (!isField(bx, bz)) return `Stand on the field (plantable ground enclosed by walls) first.`
  const key = (x, z) => `${x},${z}`
  const field = new Map([[key(bx, bz), [bx, bz]]])
  const queue = [[bx, bz]]
  while (queue.length && field.size <= MAX) {
    const [x, z] = queue.shift()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz
      if (field.has(key(nx, nz))) continue
      if (isField(nx, nz)) { field.set(key(nx, nz), [nx, nz]); queue.push([nx, nz]) }
    }
  }
  if (field.size > MAX) return `Field is too large (>${MAX} cells) to plant in one call.`

  // The four corners (bounding box of the field).
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity
  for (const [x, z] of field.values()) {
    minx = Math.min(minx, x); maxx = Math.max(maxx, x)
    minz = Math.min(minz, z); maxz = Math.max(maxz, z)
  }

  // Work the field row by row in a back-and-forth (boustrophedon) raster.
  const seq = startSeq(bot)
  let tilled = 0, planted = 0, skipped = 0
  for (let x = minx; x <= maxx; x++) {
    const forward = (x - minx) % 2 === 0
    for (let i = 0; i <= maxz - minz; i++) {
      if (preempted(bot, seq)) return `Hoed ${tilled}, planted ${planted} ${seedName} — stopped.`
      const z = forward ? minz + i : maxz - i
      if (!field.has(key(x, z))) continue
      const pos = new Vec3(x, floorY, z)
      let above = bot.blockAt(new Vec3(x, floorY + 1, z))
      if (above && !REPLACEABLE.has(above.name)) { skipped++; continue } // no room to plant

      // Stand on a NEIGHBOURING field cell, never the target square itself — standing
      // on the square we're planting makes the seed placement fail (our feet occupy it).
      const nb = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => [x + dx, z + dz]).find(([nx, nz]) => field.has(key(nx, nz)))
      if (nb) await bot.pathfinder.goto(new goals.GoalNear(nb[0], fy, nb[1], 0)).catch(() => {})
      else await bot.pathfinder.goto(new goals.GoalNear(x, floorY, z, 1)).catch(() => {})

      // Clear the block above (tall grass/flowers we may replace); retry — the block
      // update can lag a tick behind the dig.
      above = bot.blockAt(new Vec3(x, floorY + 1, z))
      for (let t = 0; t < 3 && above && above.name !== 'air' && REPLACEABLE.has(above.name); t++) {
        try { await bot.dig(above) } catch { /* ignore */ }
        await sleep(120)
        above = bot.blockAt(new Vec3(x, floorY + 1, z))
      }
      if (above && above.name !== 'air') { skipped++; continue } // still blocked

      // Till to farmland; retry — a single hoe-use or the block update can miss.
      await bot.equip(hoe, 'hand')
      let ground = bot.blockAt(pos)
      for (let t = 0; t < 3 && (!ground || ground.name !== 'farmland'); t++) {
        await bot.lookAt(pos.offset(0.5, 1, 0.5), true)
        try { await bot.activateBlock(bot.blockAt(pos)) } catch { /* ignore */ }
        await sleep(250)
        ground = bot.blockAt(pos)
      }
      if (!ground || ground.name !== 'farmland') { skipped++; continue }
      tilled++

      // Plant the seed; retry and verify a crop actually appeared on the farmland.
      const seed = bot.inventory.items().find((i) => i.name === seedName || i.name.includes(seedName))
      if (!seed) { bot.missingItem = seedName; return `Hoed ${tilled}, planted ${planted}, then ran out of ${seedName}.` }
      await bot.equip(seed, 'hand')
      let ok = false
      for (let t = 0; t < 3 && !ok; t++) {
        await bot.lookAt(pos.offset(0.5, 1, 0.5), true)
        try { await bot.placeBlock(ground, new Vec3(0, 1, 0)) } catch { /* ignore */ }
        await sleep(160)
        const crop = bot.blockAt(new Vec3(x, floorY + 1, z))
        ok = !!crop && crop.name !== 'air'
      }
      if (ok) planted++; else skipped++
    }
  }
  const w = maxx - minx + 1, h = maxz - minz + 1
  return `Worked the ${w}x${h} field (${field.size} cells): hoed ${tilled}, planted ${planted} ${seedName} (${skipped} skipped).`
}

// Replace the floor of a field (the flat area at the bot's feet enclosed by
// path-blocking walls — same boundary logic as plantField) with another block:
// dig each floor cell and place the new block in its place.
async function replaceField(bot, { blockName }) {
  if (!mcData(bot).blocksByName[blockName]) return `Unknown block "${blockName}".`
  if (!bot.inventory.items().some((i) => i.name === blockName || i.name.includes(blockName))) {
    bot.missingItem = blockName
    return `No "${blockName}" in inventory to place.`
  }

  const fy = Math.floor(bot.entity.position.y) // feet level
  const floorY = fy - 1 // the ground the bot stands on
  const blocksPath = (x, z) => { const b = bot.blockAt(new Vec3(x, fy, z)); return !!b && b.boundingBox === 'block' }
  // Field cell: any solid floor you can stand on that isn't walled off. Same
  // wall boundary as plantField; here any floor block counts (we're replacing it).
  const isCell = (x, z) => {
    const floor = bot.blockAt(new Vec3(x, floorY, z))
    return !!floor && floor.boundingBox === 'block' && !blocksPath(x, z)
  }

  const MAX = 256
  const bx = Math.floor(bot.entity.position.x), bz = Math.floor(bot.entity.position.z)
  if (!isCell(bx, bz)) return `Stand on the area (flat floor enclosed by walls) first.`
  const key = (x, z) => `${x},${z}`
  const field = new Map([[key(bx, bz), [bx, bz]]])
  const queue = [[bx, bz]]
  while (queue.length && field.size <= MAX) {
    const [x, z] = queue.shift()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz
      if (field.has(key(nx, nz))) continue
      if (isCell(nx, nz)) { field.set(key(nx, nz), [nx, nz]); queue.push([nx, nz]) }
    }
  }
  if (field.size > MAX) return `Area is too large (>${MAX} cells) to replace in one call.`

  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity
  for (const [x, z] of field.values()) {
    minx = Math.min(minx, x); maxx = Math.max(maxx, x)
    minz = Math.min(minz, z); maxz = Math.max(maxz, z)
  }

  const seq = startSeq(bot)
  let replaced = 0, skipped = 0
  for (let x = minx; x <= maxx; x++) {
    const forward = (x - minx) % 2 === 0
    for (let i = 0; i <= maxz - minz; i++) {
      if (preempted(bot, seq)) return `Replaced ${replaced} block(s) — stopped.`
      const z = forward ? minz + i : maxz - i
      if (!field.has(key(x, z))) continue
      const pos = new Vec3(x, floorY, z)
      const cur = bot.blockAt(pos)
      if (cur && (cur.name === blockName || cur.name.includes(blockName))) { skipped++; continue }

      // Stand on a neighbouring field cell (never this one) so digging the floor
      // block doesn't drop the bot into the hole it just made.
      const stand = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .map(([dx, dz]) => [x + dx, z + dz])
        .find(([nx, nz]) => field.has(key(nx, nz)))
      if (stand) await bot.pathfinder.goto(new goals.GoalNear(stand[0], fy, stand[1], 0)).catch(() => {})
      else await bot.pathfinder.goto(new goals.GoalNear(x, floorY, z, 2)).catch(() => {})

      // Bail on this cell if we'd be digging the block under our own feet.
      if (Math.floor(bot.entity.position.x) === x && Math.floor(bot.entity.position.z) === z) { skipped++; continue }

      if (cur && cur.name !== 'air') {
        // Equip the right tool for THIS block every time — the previous placeOne
        // left the replacement block in hand, which would dig the next cell slowly.
        await equipBestToolForBlock(bot, cur)
        try { await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true); await bot.dig(cur) } catch { /* ignore */ }
      }
      const r = await placeOne(bot, blockName, pos)
      if (r === 'placed') replaced++
      else skipped++
    }
  }
  const w = maxx - minx + 1, h = maxz - minz + 1
  return `Replaced ${replaced} floor block(s) in the ${w}x${h} area with ${blockName} (${skipped} skipped).`
}

// Blocks preferred for filling holes / building a simple wall, best-liked first.
const FILL_PREFERENCE = ['dirt', 'cobblestone', 'stone', 'deepslate', 'netherrack', 'sandstone', 'sand', 'gravel']

// Pick a fill/build block: an explicit name if the bot has it (exact then partial),
// else the first preferred earthy block in inventory. Returns a block name or null.
function pickFillBlock(bot, name) {
  const items = bot.inventory.items()
  if (name) {
    const it = items.find((i) => i.name === name) || items.find((i) => i.name.includes(name))
    return it ? it.name : name // fall back to the requested name so fetch-missing can grab it
  }
  for (const n of FILL_PREFERENCE) if (items.some((i) => i.name === n)) return n
  const any = items.find((i) => /dirt|stone|cobble|gravel|_sand$|^sand$|netherrack/.test(i.name))
  return any ? any.name : null
}

// How high above the target level to mow away blocks in each column.
const MOW_UP = 8

// Level a width x length rectangle to the height of the block the bot stands on.
// The near corner is the cell to the bot's right; the rectangle runs `width` cells
// to the right and `length` cells forward (the way the bot faces). Mounds are mown
// down and holes filled with dirt/stone so the whole footprint is flat at one level.
// Remembers the footprint on bot.lastRect so a follow-up "wall" can enclose it.
async function levelArea(bot, { width, length, fillName }) {
  const w = Math.max(1, Math.floor(Number(width) || 0))
  const l = Math.max(1, Math.floor(Number(length) || 0))
  if (w * l > 256) return `That area is ${w}x${l} (${w * l} cells); max 256 per call. Use a smaller size.`

  const F = FORWARD_BY_DIR[cardinalFromYaw(bot.entity.yaw)]
  const R = { x: -F.z, z: F.x } // unit step to the bot's right
  const bx = Math.floor(bot.entity.position.x), bz = Math.floor(bot.entity.position.z)
  const floorY = Math.floor(bot.entity.position.y) - 1 // the surface the bot stands on
  const sx = bx + R.x, sz = bz + R.z // near corner: the cell to the bot's right

  // Every cell of the footprint (world-axis-aligned, since R and F are cardinal).
  const cells = []
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity
  for (let a = 0; a < w; a++) {
    for (let b = 0; b < l; b++) {
      const x = sx + R.x * a + F.x * b
      const z = sz + R.z * a + F.z * b
      cells.push([x, z])
      minx = Math.min(minx, x); maxx = Math.max(maxx, x)
      minz = Math.min(minz, z); maxz = Math.max(maxz, z)
    }
  }

  if (await canOpBuild(bot)) { // creative + opped: mow to air and fill holes with /fill
    await opFill(bot, new Vec3(minx, floorY + 1, minz), new Vec3(maxx, floorY + MOW_UP, maxz), 'air')
    await opFill(bot, new Vec3(minx, floorY, minz), new Vec3(maxx, floorY, maxz), cleanName(fillName || 'dirt'), 'keep')
    bot.lastRect = { minx, maxx, minz, maxz, floorY }
    await faceCommander(bot)
    return `Levelled the ${w}x${l} area at y=${floorY} via /fill (creative).`
  }

  const fill = pickFillBlock(bot, fillName)

  const seq = startSeq(bot)
  let mown = 0, filled = 0, leftover = 0, ranOut = false
  for (const [x, z] of cells) {
    if (preempted(bot, seq)) { if (bot.defaultMovements) bot.pathfinder.setMovements(bot.defaultMovements); return `Levelling stopped (mown ${mown}, filled ${filled}).` }
    // Positioning over uneven ground needs build movements; stand beside the column
    // at the target level so we can reach it.
    if (bot.buildMovements) bot.pathfinder.setMovements(bot.buildMovements)
    await bot.pathfinder.goto(new goals.GoalNear(x, floorY + 1, z, 3)).catch(() => {})

    // Mow: remove solid blocks above the target level, top-down.
    for (let y = floorY + MOW_UP; y >= floorY + 1; y--) {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b || b.boundingBox !== 'block') continue
      const p = bot.entity.position // never dig the block holding the bot up
      if (Math.floor(p.x) === x && Math.floor(p.z) === z && Math.floor(p.y) - 1 === y) continue
      await equipBestToolForBlock(bot, b)
      if (!bot.canDigBlock(b)) { leftover++; continue }
      try { await bot.dig(b); mown++ } catch { leftover++ }
    }

    // Fill: if the target-level block is a hole (air/liquid/plant), lay fill.
    const floor = bot.blockAt(new Vec3(x, floorY, z))
    if (!floor || floor.boundingBox !== 'block') {
      if (!fill) { ranOut = true; bot.missingItem = 'dirt'; continue }
      const r = await placeOne(bot, fill, new Vec3(x, floorY, z))
      if (r === 'placed') filled++
      else if (r === 'no-item') { ranOut = true; continue }
    }
  }
  if (bot.defaultMovements) bot.pathfinder.setMovements(bot.defaultMovements)

  bot.lastRect = { minx, maxx, minz, maxz, floorY }
  await faceCommander(bot)
  const note = ranOut ? ` Ran short on fill (${fill || 'dirt'}).` : ''
  return `Levelled a ${w}x${l} area at y=${floorY}: mown ${mown} block(s), filled ${filled} hole(s)${leftover ? `, ${leftover} left (unreachable/wrong tool)` : ''}.${note}`
}

// The perimeter cells of a rectangle in a continuous loop order (no repeats), so
// the bot walks a tidy lap instead of hopping between scattered cells.
function perimeterRing(minx, maxx, minz, maxz) {
  const ring = [], seen = new Set()
  const push = (x, z) => { const k = x + ',' + z; if (!seen.has(k)) { seen.add(k); ring.push([x, z]) } }
  for (let x = minx; x <= maxx; x++) push(x, minz)
  for (let z = minz; z <= maxz; z++) push(maxx, z)
  for (let x = maxx; x >= minx; x--) push(x, maxz)
  for (let z = maxz; z >= minz; z--) push(minx, z)
  return ring
}

// Place one wall block while standing on the ground beside its column — no digging,
// no scaffolding, no climbing onto the wall. standCells are preferred (interior)
// spots to stand on. Returns a status like placeOne. Timeouts guard stuck pathing.
async function placeWallFromGround(bot, blockName, target, standCells, feetY) {
  const existing = bot.blockAt(target)
  if (existing && !REPLACEABLE.has(existing.name)) return 'occupied'
  const item = bot.inventory.items().find((i) => i.name === blockName || i.name.includes(blockName))
  if (!item) { bot.missingItem = blockName; return 'no-item' }
  if (bot.followMovements) bot.pathfinder.setMovements(bot.followMovements) // non-destructive
  let stood = false
  for (const [sx, sz] of standCells) {
    try { await withTimeout(bot.pathfinder.goto(new goals.GoalNear(sx, feetY, sz, 0)), 8000); stood = true; break } catch { /* try next */ }
  }
  if (!stood) { try { await withTimeout(bot.pathfinder.goto(new goals.GoalNear(target.x, feetY, target.z, 2)), 8000) } catch { /* place from here */ } }
  // Reference the block directly below (bottom-up guarantees it), else a solid neighbour.
  let reference = bot.blockAt(target.offset(0, -1, 0)), faceVector = new Vec3(0, 1, 0)
  if (!reference || reference.boundingBox !== 'block') {
    reference = null
    for (const dir of FACES) { const ref = bot.blockAt(target.minus(dir)); if (ref && ref.boundingBox === 'block') { reference = ref; faceVector = dir; break } }
  }
  if (!reference) return 'no-support'
  await bot.equip(item, 'hand')
  try {
    await withTimeout(bot.lookAt(target.offset(0.5, 0.5, 0.5), true), 2500)
    await withTimeout(bot.placeBlock(reference, faceVector), 4000)
  } catch {
    const now = bot.blockAt(target)
    if (now && (now.name === item.name || now.name.includes(blockName))) return 'placed'
    return 'failed'
  }
  return 'placed'
}

// Courses the bot can reliably place from the ground (survival reach). Taller walls
// need elevation for the courses above this.
const WALL_GROUND_COURSES = 5

// Build a wall around the rectangle most recently levelled (levelArea's footprint),
// `height` blocks tall, from stone/dirt. The bot walks the perimeter course by
// course on the ground, placing without digging or scaffolding (no chaotic
// climbing). For walls taller than it can reach from the ground, the upper courses
// are placed with the scaffolding placer.
async function buildRectWall(bot, { height = 1, blockName }) {
  const rect = bot.lastRect
  if (!rect) return `No levelled area to wall yet — run "level <width> <length>" first.`
  const h = Math.max(1, Math.min(Math.floor(Number(height) || 1), 24))
  const { minx, maxx, minz, maxz, floorY } = rect
  rect.wallTop = floorY + h // remember the top course so "ceiling" can roof at this level

  if (await canOpBuild(bot)) { // creative + opped: fill the four wall planes at once
    const cb = cleanName(blockName || 'stone')
    const y0 = floorY + 1, y1 = floorY + h
    await opFill(bot, new Vec3(minx, y0, minz), new Vec3(minx, y1, maxz), cb) // west
    await opFill(bot, new Vec3(maxx, y0, minz), new Vec3(maxx, y1, maxz), cb) // east
    await opFill(bot, new Vec3(minx, y0, minz), new Vec3(maxx, y1, minz), cb) // north
    await opFill(bot, new Vec3(minx, y0, maxz), new Vec3(maxx, y1, maxz), cb) // south
    await faceCommander(bot)
    return `Built a ${h}-high ${cb} wall around the ${maxx - minx + 1}x${maxz - minz + 1} area via /fill (creative).`
  }

  const block = pickFillBlock(bot, blockName)
  if (!block) { bot.missingItem = 'stone'; return `No stone/dirt in inventory to build the wall with.` }

  const ring = perimeterRing(minx, maxx, minz, maxz)
  const inRect = (x, z) => x >= minx && x <= maxx && z >= minz && z <= maxz
  const isPerim = (x, z) => inRect(x, z) && (x === minx || x === maxx || z === minz || z === maxz)
  if (ring.length * h > MAX_BLOCKS) return `That wall is ${ring.length * h} blocks; max ${MAX_BLOCKS} per call. Use fewer courses or a smaller area.`
  const restore = () => { if (bot.defaultMovements) bot.pathfinder.setMovements(bot.defaultMovements) }

  const feetY = floorY + 1 // the bot stands here, on top of the levelled floor
  const seq = startSeq(bot)
  let placed = 0, skipped = 0, ranOut = false

  // Ground build: walk the perimeter course by course, placing non-destructively.
  const groundCourses = Math.min(h, WALL_GROUND_COURSES)
  for (let dy = 0; dy < groundCourses && !ranOut; dy++) {
    const y = floorY + 1 + dy
    for (const [x, z] of ring) {
      if (preempted(bot, seq)) { restore(); return `Built ${placed} block(s) — stopped.` }
      const stand = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .map(([dx, dz]) => [x + dx, z + dz])
        .filter(([nx, nz]) => !isPerim(nx, nz))
        .sort((a, b) => (inRect(a[0], a[1]) ? 0 : 1) - (inRect(b[0], b[1]) ? 0 : 1)) // interior first
      const r = await placeWallFromGround(bot, block, new Vec3(x, y, z), stand, feetY)
      if (r === 'placed') placed++
      else if (r === 'no-item') { ranOut = true; break }
      else skipped++
    }
  }

  // Tall walls: courses above ground reach need elevation — place them with the
  // scaffolding placer (bottom-up, retried).
  let tallNote = ''
  if (h > WALL_GROUND_COURSES && !ranOut) {
    const upper = []
    for (let dy = WALL_GROUND_COURSES; dy < h; dy++) for (const [x, z] of ring) upper.push(new Vec3(x, floorY + 1 + dy, z))
    const res = await placeCells(bot, block, upper)
    placed += res.placed; skipped += res.skipped
    if (res.ranOut) ranOut = true
    tallNote = ` Top ${h - WALL_GROUND_COURSES} course(s) needed scaffolding to reach.`
  }

  restore()
  await faceCommander(bot)
  const dims = `${maxx - minx + 1}x${maxz - minz + 1}`
  if (ranOut) return `Built ${placed} ${block} of the ${dims} wall, then ran out.${tallNote}`
  return `Built a ${h}-high ${block} wall around the ${dims} area — walked the perimeter course by course (${placed} placed${skipped ? `, ${skipped} skipped` : ''}).${tallNote}`
}

// Cells of a rectangle in inward-spiral order (outer ring first, each ring a
// continuous loop), so a bot filling them walks a smooth path — consecutive cells
// are always adjacent — instead of hopping between opposite edges.
function spiralCells(x0, x1, z0, z1) {
  const out = []
  while (x0 <= x1 && z0 <= z1) {
    for (let x = x0; x <= x1; x++) out.push([x, z0])                  // top edge →
    for (let z = z0 + 1; z <= z1; z++) out.push([x1, z])              // right edge ↓
    if (z1 > z0) for (let x = x1 - 1; x >= x0; x--) out.push([x, z1]) // bottom edge ←
    if (x1 > x0) for (let z = z1 - 1; z > z0; z--) out.push([x0, z])  // left edge ↑
    x0++; x1--; z0++; z1--
  }
  return out
}

// Flood-fill the open floor area the bot is standing in, bounded by path-blocking
// walls (the same enclosure logic as plantField). Returns the interior cells, their
// bounding box, the floor level, and the surrounding wall's top height — or { error }.
function enclosureAtFeet(bot) {
  const fy = Math.floor(bot.entity.position.y) // feet level
  const floorY = fy - 1
  const blocksPath = (x, z) => { const b = bot.blockAt(new Vec3(x, fy, z)); return !!b && b.boundingBox === 'block' }
  const hasFloor = (x, z) => { const b = bot.blockAt(new Vec3(x, floorY, z)); return !!b && b.boundingBox === 'block' }
  const isOpen = (x, z) => hasFloor(x, z) && !blocksPath(x, z)

  const bx = Math.floor(bot.entity.position.x), bz = Math.floor(bot.entity.position.z)
  if (!isOpen(bx, bz)) return { error: `Stand inside the walled area (on its floor) and run ceiling — or run "level" first.` }
  const MAX = 256, key = (x, z) => `${x},${z}`
  const interior = new Map([[key(bx, bz), [bx, bz]]])
  const queue = [[bx, bz]]
  while (queue.length && interior.size <= MAX) {
    const [x, z] = queue.shift()
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz
      if (interior.has(key(nx, nz))) continue
      if (isOpen(nx, nz)) { interior.set(key(nx, nz), [nx, nz]); queue.push([nx, nz]) }
    }
  }
  if (interior.size > MAX) return { error: `The area isn't enclosed (or is too big) — I couldn't find surrounding walls. Wall it in, or run "level" first.` }

  // Bounding box + wall-top height (scan up the wall columns that border the interior).
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity
  const tops = {}
  for (const [x, z] of interior.values()) {
    minx = Math.min(minx, x); maxx = Math.max(maxx, x); minz = Math.min(minz, z); maxz = Math.max(maxz, z)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz
      if (interior.has(key(nx, nz)) || !blocksPath(nx, nz)) continue // only wall neighbours
      let top = null
      for (let y = fy; y < fy + 40; y++) { const b = bot.blockAt(new Vec3(nx, y, nz)); if (b && b.boundingBox === 'block') top = y; else if (top != null) break }
      if (top != null) tops[top] = (tops[top] || 0) + 1
    }
  }
  const entries = Object.entries(tops)
  if (!entries.length) return { error: `I couldn't find walls around you — wall the area in, or run "level" first.` }
  const topY = Number(entries.sort((a, b) => b[1] - a[1])[0][0]) // most common wall-top height
  return { cells: [...interior.values()], minx, maxx, minz, maxz, floorY, topY }
}

// Roof the walled area: fill it at the top of the wall with a block, capping the
// enclosure. Uses the last levelled/walled footprint if there is one; otherwise it
// finds the walls the bot is standing inside (like plantField) and roofs that. The
// bot places from the floor, outer cells first, so each new ceiling block has a
// solid neighbour (the wall, then placed ceiling) to rest against.
async function ceiling(bot, { blockName }) {
  const rect = bot.lastRect
  let minx, maxx, minz, maxz, floorY, topY, cells, fullRect = false

  if (rect) {
    ;({ minx, maxx, minz, maxz, floorY } = rect)
    topY = rect.wallTop
    if (!topY) { // no wall built this session — detect the top of a corner column
      for (let y = floorY + 1; y < floorY + 40; y++) {
        const b = bot.blockAt(new Vec3(minx, y, minz))
        if (b && b.boundingBox === 'block') topY = y; else if (topY) break
      }
      if (!topY) return `I don't know the roof height — build a wall first ("wall <height>"), then run ceiling.`
    }
    // Whole footprint in spiral order; the wall ring is already solid (skipped fast).
    cells = spiralCells(minx, maxx, minz, maxz)
    fullRect = true
  } else {
    // No level/wall memory — roof the enclosure the bot is standing inside.
    const found = enclosureAtFeet(bot)
    if (found.error) return found.error
    ;({ minx, maxx, minz, maxz, floorY, topY } = found)
    // Spiral the interior as a continuous path (skip bbox cells that aren't interior).
    const inside = new Set(found.cells.map(([x, z]) => `${x},${z}`))
    cells = spiralCells(minx, maxx, minz, maxz).filter(([x, z]) => inside.has(`${x},${z}`))
    fullRect = found.cells.length === (maxx - minx + 1) * (maxz - minz + 1) // rectangular room
  }

  // Creative + opped: a rectangular ceiling is one flat /fill. (Irregular rooms
  // fall through to hand-placement so we don't drop blocks outside the walls.)
  if (fullRect && await canOpBuild(bot)) {
    const cb = cleanName(blockName || 'stone')
    await opFill(bot, new Vec3(minx, topY, minz), new Vec3(maxx, topY, maxz), cb)
    await faceCommander(bot)
    return `Roofed the ${maxx - minx + 1}x${maxz - minz + 1} area at y=${topY} with ${cb} via /fill (creative).`
  }

  const block = pickFillBlock(bot, blockName)
  if (!block) { bot.missingItem = 'stone'; return `No stone/dirt in inventory to build the ceiling with.` }
  if (cells.length > MAX_BLOCKS) return `That ceiling is ${cells.length} blocks; max ${MAX_BLOCKS} per call. Use a smaller area.`

  // Cells are already in inward-spiral order (outer ring first), so each rests on
  // the wall or an already-placed neighbour, and the bot walks a smooth spiral.

  const feetY = floorY + 1
  const seq = startSeq(bot)
  let placed = 0, skipped = 0, ranOut = false
  const retry = []
  for (const [x, z] of cells) {
    if (preempted(bot, seq)) { if (bot.defaultMovements) bot.pathfinder.setMovements(bot.defaultMovements); return `Placed ${placed} ceiling block(s) — stopped.` }
    const stand = [[x, z], [x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]]
    const r = await placeWallFromGround(bot, block, new Vec3(x, topY, z), stand, feetY)
    if (r === 'placed') placed++
    else if (r === 'occupied') skipped++
    else if (r === 'no-item') { ranOut = true; break }
    else retry.push(new Vec3(x, topY, z))
  }
  // Cells too high to reach from the floor — scaffold them in.
  let tallNote = ''
  if (!ranOut && retry.length) {
    const res = await placeCells(bot, block, retry)
    placed += res.placed; skipped += res.skipped
    if (res.ranOut) ranOut = true
    if (res.placed) tallNote = ` (${res.placed} placed with scaffolding to reach the height)`
  }

  if (bot.defaultMovements) bot.pathfinder.setMovements(bot.defaultMovements)
  await faceCommander(bot)
  const dims = `${maxx - minx + 1}x${maxz - minz + 1}`
  if (ranOut) return `Roofed part of the ${dims} area (${placed} placed), then ran out of ${block}.`
  return `Roofed the ${dims} area at y=${topY} with ${block}: ${placed} placed${skipped ? `, ${skipped} already solid` : ''}${tallNote}.`
}

async function mineArea(bot, { x1, y1, z1, x2, y2, z2, blockName }) {
  const [xa, xb] = [Math.min(x1, x2), Math.max(x1, x2)]
  const [ya, yb] = [Math.min(y1, y2), Math.max(y1, y2)]
  const [za, zb] = [Math.min(z1, z2), Math.max(z1, z2)]
  const volume = (xb - xa + 1) * (yb - ya + 1) * (zb - za + 1)
  if (volume > MAX_BLOCKS) return `That region is ${volume} blocks; max ${MAX_BLOCKS} per call. Use a smaller area.`

  const onlyId = blockName ? mcData(bot).blocksByName[blockName]?.id : null
  if (blockName && onlyId == null) return `Unknown block type "${blockName}".`

  // Cells to clear, top-down so the bot never digs the ground from under itself.
  let pending = []
  for (let y = yb; y >= ya; y--)
    for (let x = xa; x <= xb; x++)
      for (let z = za; z <= zb; z++) pending.push(new Vec3(x, y, z))

  const seq = startSeq(bot)
  let mined = 0
  let empty = 0
  let missing = 0
  // Retry leftover solid cells in further passes — a block can become reachable
  // once the ones around/above it are gone.
  for (let pass = 0; pass < 4 && pending.length; pass++) {
    const retry = []
    let progress = 0
    for (const p of pending) {
      if (preempted(bot, seq)) { missing = pending.length; return `Mined ${mined} block(s) — stopped.` }
      const block = bot.blockAt(p)
      if (!block || block.name === 'air') { if (pass === 0) empty++; continue }
      if (onlyId != null && block.type !== onlyId) continue
      await bot.pathfinder.goto(new goals.GoalNear(p.x, p.y, p.z, 3)).catch(() => {})
      await equipBestToolForBlock(bot, block) // pickaxe/axe/shovel to suit the block
      if (!bot.canDigBlock(block)) { retry.push(p); continue }
      await bot.dig(block).catch(() => {})
      if (bot.blockAt(p)?.name === 'air') { mined++; progress++ } else retry.push(p)
    }
    pending = retry
    if (progress === 0) break
  }
  missing = pending.length
  if (mined === 0 && missing === 0) {
    return `Mined nothing: no solid blocks in that box (${empty} air/empty cells). Check the coordinates and Y. Note: your feet sit one Y above the floor, and already-cleared areas read as air.`
  }
  return `Mined ${mined} block(s) (${missing ? `${missing} left: wrong tool or unreachable, ` : ''}${empty} were empty).`
}

// The bot and the nearest player mark two opposite corners of a rectangle.
// groundY = the surface the bot stands on; feet level is groundY + 1.
function spanRect(bot) {
  const pl = nearestPlayer(bot)
  if (!pl) return null
  const b = bot.entity.position, p = pl.position
  return {
    ax: Math.floor(b.x), az: Math.floor(b.z),
    bx: Math.floor(p.x), bz: Math.floor(p.z),
    groundY: Math.floor(b.y) - 1,
    who: Object.values(bot.players).find((q) => q.entity === pl)?.username || 'player',
  }
}

async function fillSpan(bot, { blockName, height = 1 }) {
  const r = spanRect(bot)
  if (!r) return 'No other player nearby to mark the far corner.'
  // Fill from feet level (groundY+1) up, so blocks lay on top of the marked ground.
  const base = r.groundY + 1
  return fillArea(bot, { blockName, x1: r.ax, y1: base, z1: r.az, x2: r.bx, y2: base + height - 1, z2: r.bz })
}

async function mineSpan(bot, { depth = 1 }) {
  const r = spanRect(bot)
  if (!r) return 'No other player nearby to mark the far corner.'
  // Mine from the ground you stand on (groundY) downward.
  return mineArea(bot, { x1: r.ax, y1: r.groundY - depth + 1, z1: r.az, x2: r.bx, y2: r.groundY, z2: r.bz })
}

async function wallSpan(bot, { blockName, height = 1 }) {
  const r = spanRect(bot)
  if (!r) return 'No other player nearby to mark the far corner.'
  const dx = Math.abs(r.bx - r.ax), dz = Math.abs(r.bz - r.az)
  const base = r.groundY + 1 // wall sits on the ground
  // Build a straight wall between the two corners along the longer axis.
  if (dx >= dz) {
    return buildWall(bot, { blockName, x: Math.min(r.ax, r.bx), y: base, z: r.az, direction: 'x', length: dx + 1, height })
  }
  return buildWall(bot, { blockName, x: r.ax, y: base, z: Math.min(r.az, r.bz), direction: 'z', length: dz + 1, height })
}

async function lookAt(bot, { x, y, z }) {
  await bot.lookAt(new Vec3(x, y, z), true)
  return `Looking at (${x}, ${y}, ${z}).`
}

async function lookAtMe(bot, { username }) {
  const target = (username && bot.players[username]?.entity) || nearestPlayer(bot)
  if (!target) return `Can't see any player to look at.`
  await bot.lookAt(target.position.offset(0, target.eyeHeight || 1.62, 0), true)
  return `Looking at ${target.username || 'you'}.`
}

async function chitchat(bot, { durationSec = 30, username }) {
  const dur = Math.min(Math.max(durationSec, 3), 120) * 1000
  const lookAtEntity = async (e) => {
    if (e && e.isValid) await bot.lookAt(e.position.offset(0, e.eyeHeight || 1.62, 0), true)
  }
  const others = () => Object.values(bot.players).filter((p) => p.entity && p.username !== bot.username)

  const seq = startSeq(bot)
  const start = Date.now()
  let glances = 0
  while (Date.now() - start < dur) {
    if (preempted(bot, seq)) return `Stopped chitchatting after ${glances} glances.`
    const list = others()
    if (!list.length) break
    const me = username ? list.find((p) => p.username === username)?.entity : null
    const peers = list.filter((p) => p.username !== username).map((p) => p.entity)
    // Glance at a peer (the other bot), then at "me" — back and forth.
    const peer = peers.length ? peers[glances % peers.length] : (me || list[0].entity)
    await lookAtEntity(peer)
    await sleep(2000 + (glances % 2) * 800) // a few seconds, slightly varied so bots desync
    if (Date.now() - start >= dur) break
    if (me) { await lookAtEntity(me); await sleep(2200 + (glances % 2) * 700) }
    glances++
  }
  return `Chitchatted for ${Math.round((Date.now() - start) / 1000)}s (${glances} glances).`
}

async function move(bot, { direction, distance = 1 }) {
  const dir = relDir(direction)
  if (!dir) return `Unknown direction "${direction}". Use forward/back/left/right (f/b/l/r).`
  const v = REL_VEC[dir](FORWARD_BY_DIR[cardinalFromYaw(bot.entity.yaw)])
  const p = bot.entity.position
  // Floor (the block the bot stands in) so distance is symmetric regardless of
  // sign — Math.round on an X.5 position would bias the target by half a block.
  const tx = Math.floor(p.x) + v.x * distance
  const tz = Math.floor(p.z) + v.z * distance
  const ty = Math.floor(p.y)
  await bot.pathfinder.goto(new goals.GoalNear(tx, ty, tz, 1)).catch(() => {})
  const np = bot.entity.position
  return `Moved ${dir} ${distance} → (${Math.round(np.x)}, ${Math.round(np.y)}, ${Math.round(np.z)}).`
}

async function turn(bot, { direction }) {
  const dir = relDir(direction)
  if (!dir) return `Unknown direction "${direction}". Use forward/back/left/right (f/b/l/r).`
  const v = REL_VEC[dir](FORWARD_BY_DIR[cardinalFromYaw(bot.entity.yaw)])
  await bot.look(Math.atan2(-v.x, -v.z), 0, true)
  return `Turned ${dir}; now facing ${cardinalFromYaw(bot.entity.yaw)}.`
}

async function jump(bot, { direction }) {
  const dir = relDir(direction)
  if (!dir) return `Unknown direction "${direction}". Use forward/back/left/right (f/b/l/r).`
  // Face the relative direction first, so the reliable "forward" control carries
  // the hop that way (and lands a one-block step up if there is one). The forward
  // movement control needs yaw = atan2(-vx, -vz) to head toward vector v.
  const v = REL_VEC[dir](FORWARD_BY_DIR[cardinalFromYaw(bot.entity.yaw)])
  await bot.look(Math.atan2(-v.x, -v.z), 0, true)
  await sleep(150)
  bot.setControlState('forward', true)
  bot.setControlState('jump', true)
  await sleep(280) // brief hop — up and ~one block over
  bot.setControlState('forward', false)
  bot.setControlState('jump', false)
  for (let i = 0; i < 20 && !bot.entity.onGround; i++) await sleep(100) // wait to land
  const p = bot.entity.position
  return `Jumped ${dir} → (${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}).`
}

function findBlocks(bot, { blockName, range = 32, count = 8 }) {
  const q = blockName.toLowerCase()
  const ids = Object.values(mcData(bot).blocksByName)
    .filter((b) => b.name === q || b.name.includes(q))
    .map((b) => b.id)
  if (!ids.length) return `No block type matching "${blockName}".`

  // Only report blocks the bot can actually see (clear line of sight) — no x-ray.
  const positions = bot.findBlocks({ matching: ids, maxDistance: range, count, useExtraInfo: (b) => bot.canSeeBlock(b) })
  if (!positions.length) return `No visible ${blockName} within ${range} blocks (any nearby may be hidden behind blocks).`

  const list = positions.map((p) => {
    const b = bot.blockAt(p)
    return `${b ? b.name : 'block'} (${p.x}, ${p.y}, ${p.z}) [${Math.round(bot.entity.position.distanceTo(p))}m]`
  })
  return `Found ${positions.length} ${blockName}: ${list.join('; ')}.`
}

async function attackEntity(bot, { target }) {
  const pick = () =>
    target
      ? bot.nearestEntity((e) => e !== bot.entity && (e.name === target || e.username === target || e.displayName === target))
      : bot.nearestEntity((e) => e !== bot.entity && (e.type === 'hostile' || e.type === 'mob'))

  let victim = pick()
  if (!victim) return `No ${target || 'mob'} nearby to attack.`
  await equipBestOfCategory(bot, 'sword') // wield the best sword for the fight
  const id = victim.id
  const name = victim.name || victim.username || 'entity'

  const seq = startSeq(bot)
  let hits = 0
  while (victim && victim.isValid && hits < 25) {
    if (preempted(bot, seq)) return `Attacked ${name} (${hits} hit${hits === 1 ? '' : 's'}) — stopped.`
    if (bot.entity.position.distanceTo(victim.position) > 3) {
      await bot.pathfinder.goto(new goals.GoalNear(victim.position.x, victim.position.y, victim.position.z, 2)).catch(() => {})
    }
    await bot.lookAt(victim.position.offset(0, 1, 0), true)
    bot.attack(victim)
    hits++
    await sleep(600)
    victim = bot.entities[id] && bot.entities[id].isValid ? bot.entities[id] : null
  }
  return `Attacked ${name} (${hits} hit${hits === 1 ? '' : 's'}).`
}

async function eat(bot, { foodName }) {
  const foods = mcData(bot).foodsByName // keyed by item name (foods[] is keyed by a food id, not item id)
  const item = foodName
    ? bot.inventory.items().find((i) => i.name === foodName || i.name.includes(foodName))
    : bot.inventory.items().find((i) => foods[i.name])
  if (!item) return foodName ? `No "${foodName}" in inventory.` : 'No food in inventory.'
  await bot.equip(item, 'hand')
  try {
    await bot.consume()
  } catch (e) {
    return `Couldn't eat ${item.name}: ${e.message}`
  }
  return `Ate ${item.name}. Food level now ${bot.food}.`
}

// Launch the held firework rocket. Unlike food/potions/bows, a rocket does nothing
// on a bare air right-click (that path is only the elytra boost) — from the ground
// it must be "used" against a block. Fire it against the ground under the bot, or
// an adjacent block if there's no floor. Returns whether it launched.
async function launchFirework(bot) {
  const p = bot.entity.position
  const bx = Math.floor(p.x), by = Math.floor(p.y), bz = Math.floor(p.z)
  // (reference block, face vector) candidates: ground first, then the four sides.
  const cands = [[new Vec3(bx, by - 1, bz), new Vec3(0, 1, 0)]]
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    cands.push([new Vec3(bx + dx, by, bz + dz), new Vec3(-dx, 0, -dz)]) // beside, inner face
  }
  for (const [pos, face] of cands) {
    const ref = bot.blockAt(pos)
    if (!ref || ref.boundingBox !== 'block') continue
    try { await bot._genericPlace(ref, face, { swingArm: 'right' }); return true } catch { /* try next */ }
  }
  return false
}

async function useItem(bot) {
  const held = bot.heldItem?.name ?? 'nothing'
  if (held === 'nothing') return 'Nothing held to use. Equip an item first.'
  // A firework rocket won't fire from an air right-click — launch it off a block.
  if (held === 'firework_rocket') {
    return (await launchFirework(bot))
      ? 'Launched a firework rocket.'
      : `Couldn't launch the firework — no solid block nearby to fire it from.`
  }
  bot.activateItem()
  await sleep(300)
  bot.deactivateItem()
  return `Used ${held}.`
}

// Launch firework rockets straight up, count times. Equips a rocket (fetching from
// a nearby chest if the bot has none), then fires with a short gap between each.
async function firework(bot, { count = 1 }) {
  const n = Math.max(1, Math.min(Math.floor(Number(count) || 1), 64))
  let have = bot.inventory.items().find((i) => i.name === 'firework_rocket')
  if (!have) {
    const got = await withdrawFromChest(bot, { itemName: 'firework_rocket', count: n })
    have = bot.inventory.items().find((i) => i.name === 'firework_rocket')
    if (!have) { bot.missingItem = 'firework_rocket'; return `No firework_rocket in inventory or nearby chests. ${got}` }
  }
  await bot.equip(have, 'hand')

  const seq = startSeq(bot)
  let fired = 0
  for (let i = 0; i < n; i++) {
    if (preempted(bot, seq)) return `Launched ${fired} firework(s) — stopped.`
    const cur = bot.inventory.items().find((it) => it.name === 'firework_rocket')
    if (!cur) { bot.missingItem = 'firework_rocket'; break } // ran out mid-show
    if (bot.heldItem?.name !== 'firework_rocket') await bot.equip(cur, 'hand')
    if (await launchFirework(bot)) fired++
    await sleep(700)
  }
  await faceCommander(bot)
  if (fired === 0) return `Couldn't launch a firework — no solid block underfoot to fire from.`
  return `Launched ${fired} firework${fired === 1 ? '' : 's'}.`
}

// A blast-proof "water-charge" TNT cannon, built with /setblock and fired with
// /summon (both need op). An obsidian trough with water shrugs off the charge blast;
// a cluster of short-fuse charge TNT launches a full-fuse projectile TNT dozens of
// blocks downrange (the way the bot faces). Fires `count` times with the bot acting
// as the auto-loader/clock; "stop" halts it. `power` = charge TNT per shot (range).
async function tntCannon(bot, { count = 3, power = 8 }) {
  const shots = Math.max(1, Math.min(Math.floor(Number(count) || 1), 20))
  const nCharge = Math.max(1, Math.min(Math.floor(Number(power) || 8), 12))
  const F = FORWARD_BY_DIR[cardinalFromYaw(bot.entity.yaw)]
  const S = { x: -F.z, z: F.x } // bot's right; the 1-wide trough runs along forward
  const fx = Math.floor(bot.entity.position.x)
  const fy = Math.floor(bot.entity.position.y) // channel (feet) level; floor is fy-1
  const fz = Math.floor(bot.entity.position.z)
  // Block coords for a trough-relative offset (f forward, s side, dy up from feet).
  const W = (f, s, dy) => ({ x: fx + F.x * f + S.x * s, y: fy + dy, z: fz + F.z * f + S.z * s })
  const cc = (v) => `${v.x} ${v.y} ${v.z}`
  const fill = (f0, f1, s0, s1, y0, y1, block) => bot.chat(`/fill ${cc(W(f0, s0, y0))} ${cc(W(f1, s1, y1))} minecraft:${block}`)

  // Op probe: set one emplacement block and verify it applied.
  const probe = W(2, 0, 0)
  bot.chat(`/setblock ${cc(probe)} minecraft:obsidian`)
  await sleep(500)
  if (bot.blockAt(new Vec3(probe.x, probe.y, probe.z))?.name !== 'obsidian') {
    return `I need to be opped to build a TNT cannon (it uses /setblock and /summon). Op me — add ${bot.username} to the server's ops, or run /op ${bot.username} from the console — then try again.`
  }

  const buildTrough = async () => {
    fill(2, 8, -1, 1, -1, -1, 'obsidian') // floor
    fill(2, 8, -1, -1, 0, 1, 'obsidian')  // left wall
    fill(2, 8, 1, 1, 0, 1, 'obsidian')    // right wall
    fill(2, 2, 0, 0, 0, 1, 'obsidian')    // back wall
    fill(3, 8, 0, 0, 0, 1, 'air')         // clear the channel
    await sleep(250)
    bot.chat(`/setblock ${cc(W(3, 0, 0))} minecraft:water`) // water fills the channel
    await sleep(700)
  }

  const proj = W(6, 0, 0), chg = W(5, 0, 0)
  const fireShot = () => {
    // Full-fuse projectile at the muzzle, then a cluster of short-fuse charge TNT
    // just behind+below it — the charge blast flings the projectile out the front.
    bot.chat(`/summon minecraft:tnt ${proj.x + 0.5} ${fy + 0.5} ${proj.z + 0.5} {fuse:80}`)
    for (let k = 0; k < nCharge; k++) bot.chat(`/summon minecraft:tnt ${chg.x + 0.5} ${fy + 0.1} ${chg.z + 0.5} {fuse:18}`)
  }

  const seq = startSeq(bot)
  await buildTrough()
  let fired = 0
  for (let i = 0; i < shots; i++) {
    if (preempted(bot, seq)) break
    if (i > 0) await buildTrough() // reload: the blast clears the water/channel
    if (preempted(bot, seq)) break
    fireShot()
    fired++
    for (let t = 0; t < 14; t++) { if (preempted(bot, seq)) break; await sleep(200) } // let the shot clear
  }
  await faceCommander(bot)
  const dir = cardinalFromYaw(bot.entity.yaw)
  return `Fired ${fired} TNT ${dir} from the cannon (${nCharge} charge each). The obsidian emplacement stays put — "stop" halts an auto-repeat. Keep clear of the muzzle!`
}

async function collectItems(bot, { range = 16 }) {
  const seq = startSeq(bot)
  let collected = 0
  // Count actual pickups, not visits — so the report is accurate and incidental
  // pickups (a cluster grabbed at once) are counted too.
  const onCollect = (collector) => { if (collector === bot.entity) collected++ }
  bot.on('playerCollect', onCollect)
  try {
    const tried = new Set() // items we walked to but couldn't pick up — don't loop on them
    for (let i = 0; i < 400; i++) { // safety bound
      if (preempted(bot, seq)) break
      const drop = bot.nearestEntity(
        (e) => e.name === 'item' && !tried.has(e.id) && bot.entity.position.distanceTo(e.position) <= range
      )
      if (!drop) break
      const id = drop.id
      // Stand on the item (range 0) so it's actually picked up, not just approached.
      await bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0)).catch(() => {})
      await sleep(200)
      if (bot.entities[id]) tried.add(id) // still on the ground — unreachable; skip it
    }
  } finally {
    bot.removeListener('playerCollect', onCollect)
  }
  if (preempted(bot, seq)) return `Collected ${collected} item stack(s) — stopped.`
  return collected ? `Collected ${collected} item stack(s).` : `No reachable dropped items within ${range} blocks.`
}

// Harvest in one step: mine all nearby blocks of a type (the bot walks over most
// drops and auto-picks them up), then sweep up whatever's left on the ground.
// Harvestable crop blocks, by their block-state name.
const CROP_BLOCKS = ['wheat', 'carrots', 'potatoes', 'beetroots', 'pumpkin', 'melon', 'nether_wart', 'cocoa', 'sweet_berry_bush']

// The block name of the nearest visible crop (any type), or null if none in range.
function findNearestCrop(bot) {
  const data = mcData(bot)
  const ids = CROP_BLOCKS.map((n) => data.blocksByName[n]?.id).filter((id) => id != null)
  const pos = bot.findBlocks({ matching: ids, maxDistance: 48, count: 1, useExtraInfo: (b) => bot.canSeeBlock(b) })[0]
    || bot.findBlocks({ matching: ids, maxDistance: 48, count: 1 })[0]
  return pos ? (bot.blockAt(pos)?.name || null) : null
}

async function harvestAndCollect(bot, { blockName, count = 4096 }) {
  const seq = startSeq(bot)
  if (!blockName) { // no type given → harvest whatever crop is nearest
    blockName = findNearestCrop(bot)
    if (!blockName) return 'No crops in sight to harvest.'
  }
  const mined = await mineNearestBlock(bot, { blockName, count })
  if (preempted(bot, seq)) return mined // a new command took over — don't keep collecting
  const collected = await collectItems(bot, { range: 24 })
  return `${mined} ${collected}`
}

async function activateBlock(bot, { x, y, z }) {
  const block = bot.blockAt(new Vec3(x, y, z))
  if (!block) return `No block at (${x}, ${y}, ${z}).`
  await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3)).catch(() => {})
  await bot.activateBlock(block)
  return `Activated ${block.name} at (${x}, ${y}, ${z}).`
}

async function craftItem(bot, { itemName, count = 1 }) {
  const data = mcData(bot)
  const item = data.itemsByName[itemName]
  if (!item) return `Unknown item "${itemName}".`

  const table = bot.findBlock({ matching: data.blocksByName.crafting_table.id, maxDistance: 16 })
  const recipes = bot.recipesFor(item.id, null, count, table)
  if (!recipes.length) {
    return table
      ? `No craftable recipe for ${itemName} (missing ingredients?).`
      : `Can't craft ${itemName}: need a crafting table nearby, or missing ingredients.`
  }
  if (table) {
    await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 3)).catch(() => {})
    try { await bot.lookAt(table.position.offset(0.5, 0.5, 0.5), true) } catch { /* face the table */ }
    await sleep(1000) // work at the table a beat so it looks like the bot is crafting
  }
  try {
    await bot.craft(recipes[0], count, table || undefined)
  } catch (e) {
    return `Couldn't craft ${itemName}: ${e.message}`
  }
  return `Crafted ${count} ${itemName}.`
}

// How many items one unit of a given fuel smelts (0 = not a fuel).
function smeltsPerFuel(name) {
  const m = { lava_bucket: 100, coal_block: 80, dried_kelp_block: 20, blaze_rod: 12, coal: 8, charcoal: 8, stick: 0.5, bamboo: 0.25 }
  if (m[name] != null) return m[name]
  if (/_planks$|_log$|_wood$|_stem$|_hyphae$|_slab$|_stairs$|_fence$|_button$|_sapling$|_door$|sapling$/.test(name)) return 1.5
  return 0
}

// Pick a fuel from inventory — the named one if given, else the best available.
function findFuel(bot, fuelName) {
  const items = bot.inventory.items()
  if (fuelName) return items.find((i) => i.name === fuelName) || items.find((i) => i.name.includes(fuelName))
  for (const p of ['coal', 'charcoal', 'coal_block', 'blaze_rod', 'dried_kelp_block']) {
    const it = items.find((i) => i.name === p)
    if (it) return it
  }
  return items.find((i) => smeltsPerFuel(i.name) > 0)
}

// If an open furnace is mid-smelt but out of fuel, add enough fuel to finish —
// from inventory, or from a chest if the bot has none. Returns true if it added.
async function topUpFuel(bot, furnace) {
  const cooking = furnace.inputItem()
  if (!cooking) return false // nothing to finish
  const fuelSlot = furnace.fuelItem()
  if (fuelSlot && fuelSlot.count > 0) return false // already fuelled
  const fuel = findFuel(bot, null) // uses on-hand fuel (smeltItem pre-fetches a buffer)
  if (!fuel) return false
  const per = smeltsPerFuel(fuel.name) || 8
  const need = Math.min(fuel.count, Math.max(1, Math.ceil(cooking.count / per)))
  try { await furnace.putFuel(fuel.type, null, need); return true } catch { return false }
}

async function smeltItem(bot, { inputName, count = 1, fuelName }) {
  const data = mcData(bot)
  const input = bot.inventory.items().find((i) => i.name === inputName) || bot.inventory.items().find((i) => i.name.includes(inputName))
  if (!input) { bot.missingItem = inputName; return `No "${inputName}" in inventory to smelt.` }
  count = Math.min(count, input.count)

  // Ensure enough fuel up front — for our smelt and to top up other furnaces —
  // grabbing more from a chest if short. Done here (not mid-loop) because opening a
  // chest would close an open furnace window.
  const want = Math.max(1, Math.ceil(count / 8)) + 4 // smelt fuel + a buffer for top-ups
  const onHand = findFuel(bot, fuelName)
  if (!onHand || onHand.count < want) {
    await withdrawFromChest(bot, { itemName: fuelName || 'coal', count: want - (onHand ? onHand.count : 0) })
  }

  const ids = ['furnace', 'blast_furnace', 'smoker'].map((n) => data.blocksByName[n]?.id).filter((v) => v != null)
  const positions = bot.findBlocks({ matching: ids, maxDistance: 32, count: 16 })
  if (!positions.length) return `No furnace nearby.`
  positions.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b))

  const seq = startSeq(bot)
  let busy = 0, toppedUp = 0
  for (let i = 0; i < positions.length && i < 8; i++) {
    if (preempted(bot, seq)) return `Smelting stopped.`
    const pos = positions[i]
    await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2)).catch(() => {})
    try { await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true) } catch { /* face it */ }
    let furnace
    try { furnace = await bot.openFurnace(bot.blockAt(pos)) } catch { continue }
    await sleep(CHEST_PAUSE)

    // Whatever this furnace is cooking, keep it fed so it can finish.
    if (await topUpFuel(bot, furnace)) toppedUp++

    // Occupied (full) — leave it running and try another furnace.
    if (furnace.inputItem()) { furnace.close(); busy++; await sleep(200); continue }

    // Free furnace — load and smelt our item here.
    const fuel = findFuel(bot, fuelName)
    if (!fuel) { furnace.close(); return `No fuel available (need coal, charcoal, planks…) and none in nearby chests.` }
    const per = smeltsPerFuel(fuel.name)
    if (per <= 0) { furnace.close(); return `"${fuel.name}" can't be used as fuel.` }
    const fuelNeeded = Math.min(fuel.count, Math.ceil(count / per))
    try {
      await furnace.putFuel(fuel.type, null, fuelNeeded)
      await furnace.putInput(input.type, null, count)
    } catch (e) { furnace.close(); return `Couldn't load the furnace: ${e.message}` }

    // Smelting takes ~10s per item (blast furnace/smoker are faster). Wait for the
    // input to be consumed, bailing on a new command or a generous timeout.
    const deadline = Date.now() + Math.min(count * 11000 + 15000, 360000)
    while (Date.now() < deadline) {
      if (preempted(bot, seq)) break
      await sleep(1000)
      if (!furnace.inputItem()) { await sleep(500); break }
    }
    let out = null
    try { out = await furnace.takeOutput() } catch { /* nothing ready */ }
    furnace.close()
    const extra = toppedUp ? ` (refuelled ${toppedUp} busy furnace${toppedUp === 1 ? '' : 's'})` : ''
    if (out && out.count > 0) return `Smelted ${out.count} ${out.name}${extra}.`
    return `Loaded a furnace (${count} ${input.name} + ${fuelNeeded} ${fuel.name}); still cooking${extra}.`
  }
  return `All ${busy} nearby furnace${busy === 1 ? '' : 's'} busy smelting${toppedUp ? ` (refuelled ${toppedUp} that needed it)` : ''} — try again once one frees up.`
}

// Play a music disc in the nearest jukebox: fetch the disc from a chest if the bot
// isn't already carrying it, eject and collect any disc already in the jukebox,
// then insert the requested one.
async function playDisc(bot, { disc }) {
  const data = mcData(bot)
  let name = disc.startsWith('music_disc_') ? disc : 'music_disc_' + disc
  let def = data.itemsByName[name] || data.itemsArray.find((i) => i.name.startsWith('music_disc_') && i.name.includes(disc))
  if (!def) return `Unknown music disc "${disc}".`
  name = def.name

  // Make sure the bot is holding the disc — grab it from a nearby chest if not.
  let have = bot.inventory.items().find((i) => i.name === name)
  if (!have) {
    await withdrawFromChest(bot, { itemName: name, count: 1 })
    have = bot.inventory.items().find((i) => i.name === name)
    if (!have) return `Couldn't find ${name} in inventory or nearby chests.`
  }

  const jukebox = bot.findBlock({ matching: data.blocksByName.jukebox?.id, maxDistance: 32 })
  if (!jukebox) return `No jukebox nearby.`
  await bot.pathfinder.goto(new goals.GoalNear(jukebox.position.x, jukebox.position.y, jukebox.position.z, 2)).catch(() => {})
  await bot.lookAt(jukebox.position.offset(0.5, 0.5, 0.5), true)

  // If it already holds a disc, eject it and pick the old one up off the ground.
  const props = jukebox.getProperties ? jukebox.getProperties() : {}
  if (props.has_record === true || props.has_record === 'true') {
    try { await bot.activateBlock(bot.blockAt(jukebox.position)) } catch { /* ignore */ }
    await sleep(700)
    await collectItems(bot, { range: 6 }) // this walks off to grab the popped disc...
    await bot.pathfinder.goto(new goals.GoalNear(jukebox.position.x, jukebox.position.y, jukebox.position.z, 2)).catch(() => {}) // ...so return to the jukebox
    await bot.lookAt(jukebox.position.offset(0.5, 0.5, 0.5), true)
  }

  // Insert the requested disc.
  await bot.equip(have, 'hand')
  try { await bot.activateBlock(bot.blockAt(jukebox.position)) } catch (e) { return `Couldn't load the disc: ${e.message}` }
  return `Playing "${name.replace('music_disc_', '')}" in the jukebox.`
}

// Trade with a nearby villager or wandering trader. With no item, lists the
// offers; with an item name, buys it `times` times (paying from inventory).
async function trade(bot, { itemName, times = 1 }) {
  const trader = bot.nearestEntity((e) => (e.name === 'villager' || e.name === 'wandering_trader') && bot.entity.position.distanceTo(e.position) <= 12)
  if (!trader) return 'No villager or wandering trader nearby.'
  await bot.pathfinder.goto(new goals.GoalNear(trader.position.x, trader.position.y, trader.position.z, 2)).catch(() => {})
  let villager
  // mineflayer's openVillager asserts the entity is a "villager"; a wandering
  // trader uses the same merchant window, so spoof the type past that one check.
  const villagerType = mcData(bot).entitiesByName.villager?.id
  const origType = trader.entityType
  if (villagerType != null) trader.entityType = villagerType
  try { villager = await bot.openVillager(trader) }
  catch (e) { return `Couldn't open the trader: ${e.message}` }
  finally { trader.entityType = origType }
  const trades = villager.trades || []
  const fmt = (it) => (it && it.type != null ? `${it.count} ${it.name}` : null)
  const costOf = (t) => [t.inputItem1, t.hasItem2 ? t.inputItem2 : null].map(fmt).filter(Boolean).join(' + ')

  // No item → just report what's on offer.
  if (!itemName) {
    villager.close()
    if (!trades.length) return 'The trader has no trades.'
    return `Trader offers: ${trades.map((t) => `${fmt(t.outputItem)} for ${costOf(t)}${t.tradeDisabled ? ' (out of stock)' : ''}`).join('; ')}.`
  }

  // Find the trade selling itemName (exact name first, then partial), still in stock.
  let idx = trades.findIndex((t) => t.outputItem && t.outputItem.name === itemName && !t.tradeDisabled)
  if (idx < 0) idx = trades.findIndex((t) => t.outputItem && t.outputItem.name.includes(itemName) && !t.tradeDisabled)
  if (idx < 0) {
    villager.close()
    const exists = trades.some((t) => t.outputItem && t.outputItem.name.includes(itemName))
    return exists ? `The trader's "${itemName}" trade is out of stock.` : `The trader doesn't sell "${itemName}".`
  }
  const t = trades[idx]
  const avail = t.maximumNbTradeUses != null && t.nbTradeUses != null ? t.maximumNbTradeUses - t.nbTradeUses : times
  times = Math.max(1, Math.min(times, avail))

  // Make sure we can pay for it.
  const costs = [t.inputItem1, t.hasItem2 ? t.inputItem2 : null].filter((x) => x && x.type != null)
  for (const c of costs) {
    const have = bot.inventory.items().filter((i) => i.type === c.type).reduce((s, i) => s + i.count, 0)
    if (have < c.count * times) { villager.close(); return `Not enough ${c.name}: need ${c.count * times}, have ${have}.` }
  }
  try {
    await bot.trade(villager, idx, times)
  } catch (e) {
    villager.close()
    return `Trade failed: ${e.message}`
  }
  villager.close()
  return `Traded for ${t.outputItem.count * times} ${t.outputItem.name} (paid ${costs.map((c) => `${c.count * times} ${c.name}`).join(' + ')}).`
}

function isContainerBlock(block) {
  return !!block && /chest|barrel|shulker_box|furnace|smoker/.test(block.name)
}

async function depositToChest(bot, { x, y, z, itemName, count }) {
  const items = bot.inventory.items()
  // Prefer exact-name stacks (so "beetroot" doesn't deposit "beetroot_seeds");
  // fall back to a partial match only if there's no exact one.
  const exact = items.filter((i) => i.name === itemName)
  const matches = exact.length ? exact : items.filter((i) => i.name.includes(itemName))
  if (!matches.length) return `No "${itemName}" in inventory.`
  const itemType = matches[0].type
  const name = matches[0].name
  const invCount = () => bot.inventory.items().filter((i) => i.type === itemType).reduce((s, i) => s + i.count, 0)
  let remaining = count ? Math.min(count, invCount()) : invCount()

  // Target chests: the given one first (if any), then nearby chests/barrels by distance.
  const data = mcData(bot)
  const ids = ['chest', 'trapped_chest', 'barrel'].map((n) => data.blocksByName[n]?.id).filter((v) => v != null)
  let positions = bot.findBlocks({ matching: ids, maxDistance: 32, count: 24 })
  positions.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b))
  if (x != null && y != null && z != null) {
    positions = positions.filter((p) => !(p.x === x && p.y === y && p.z === z))
    positions.unshift(new Vec3(x, y, z))
  }
  if (!positions.length) return `No chest found nearby.`

  const seq = startSeq(bot)
  let deposited = 0
  let chestsUsed = 0
  for (const pos of positions) {
    if (remaining <= 0 || preempted(bot, seq)) break
    const block = bot.blockAt(pos)
    if (!isContainerBlock(block)) continue
    await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)).catch(() => {})
    try { await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true) } catch { /* face the chest */ }
    let chest
    try { chest = await bot.openContainer(block) } catch { continue }
    await sleep(CHEST_PAUSE) // hold it open a beat so the chest visibly opens
    const before = invCount()
    try { await chest.deposit(itemType, null, remaining) } catch { /* chest filled up; take what fit */ }
    await sleep(CHEST_PAUSE) // pause before closing
    chest.close()
    await sleep(150)
    const moved = before - invCount() // measure what actually transferred (handles full chests)
    if (moved > 0) { deposited += moved; remaining -= moved; chestsUsed++ }
  }

  if (deposited === 0) return `Couldn't deposit any ${name} (chests full or unreachable).`
  if (remaining > 0) return `Deposited ${deposited} ${name} across ${chestsUsed} chest(s); ${remaining} left — chests are full.`
  return `Deposited ${deposited} ${name} across ${chestsUsed} chest(s).`
}

// The single tool/weapon/armor to KEEP per category — the best-tier one — so the bot
// keeps one of each kind and unloads duplicates and lesser copies. Returns a
// Map(itemType -> 1) for each kept type.
function keepBestGear(bot) {
  const catOf = (name) => {
    const m = name.match(/_(pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$/)
    if (m) return m[1]
    if (/^(shears|flint_and_steel|fishing_rod|bow|crossbow|trident|shield|brush|spyglass|elytra)$/.test(name) || /_on_a_stick$/.test(name)) return name
    return null // not a tool/weapon/armor
  }
  const tierRank = (name) => { const t = TOOL_TIERS.indexOf(name.split('_')[0]); return t < 0 ? 99 : t }
  const best = new Map() // category -> highest-tier item
  for (const it of bot.inventory.items()) {
    const cat = catOf(it.name)
    if (!cat) continue
    const cur = best.get(cat)
    if (!cur || tierRank(it.name) < tierRank(cur.name)) best.set(cat, it)
  }
  const keep = new Map()
  for (const it of best.values()) keep.set(it.type, 1) // keep one of the best type per category
  return keep
}

// Store everything into nearby chests EXCEPT one of each tool/weapon/armor (the best
// of each kind) — duplicate and lesser copies get unloaded along with the loot.
// Overflows to the next chest as each fills.
async function unloadInventory(bot) {
  // How many of each item type to unload = total on hand minus the one we keep.
  const unloadAmounts = () => {
    const keep = keepBestGear(bot)
    const byType = new Map()
    for (const i of bot.inventory.items()) byType.set(i.type, (byType.get(i.type) || 0) + i.count)
    const out = new Map()
    for (const [type, total] of byType) { const amt = total - (keep.get(type) || 0); if (amt > 0) out.set(type, amt) }
    return out
  }
  const totalToUnload = () => [...unloadAmounts().values()].reduce((s, n) => s + n, 0)
  if (totalToUnload() === 0) return `Nothing to unload — only one of each tool/weapon/armor on hand.`

  const data = mcData(bot)
  const ids = ['chest', 'trapped_chest', 'barrel'].map((n) => data.blocksByName[n]?.id).filter((v) => v != null)
  const positions = bot.findBlocks({ matching: ids, maxDistance: 32, count: 24 })
  positions.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b))
  if (!positions.length) return `No chest found nearby to unload into.`

  const seq = startSeq(bot)
  const startTotal = totalToUnload()
  let chestsUsed = 0
  for (const pos of positions) {
    if (preempted(bot, seq) || totalToUnload() === 0) break
    const block = bot.blockAt(pos)
    if (!isContainerBlock(block)) continue
    await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)).catch(() => {})
    try { await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true) } catch { /* face it */ }
    let chest
    try { chest = await bot.openContainer(block) } catch { continue }
    await sleep(CHEST_PAUSE) // hold it open a beat so it visibly opens
    const beforeChest = totalToUnload()
    for (const [type, amt] of unloadAmounts()) { // deposit only the surplus of each type
      if (preempted(bot, seq)) break
      try { await chest.deposit(type, null, amt) } catch { /* this chest is full for this item */ }
    }
    await sleep(CHEST_PAUSE) // pause before closing
    chest.close()
    await sleep(200)
    if (beforeChest - totalToUnload() > 0) chestsUsed++ // measure after the window closes
  }

  await faceCommander(bot)
  const deposited = startTotal - totalToUnload()
  const left = totalToUnload()
  if (deposited === 0) return `Couldn't unload anything (chests full or unreachable).`
  if (left > 0) return `Unloaded ${deposited} item(s) into ${chestsUsed} chest(s); ${left} left — chests are full. Kept one of each tool/armor.`
  return `Unloaded ${deposited} item(s) into ${chestsUsed} chest(s). Kept one of each tool/armor.`
}

async function withdrawFromChest(bot, { x, y, z, itemName, count = 1 }) {
  const data = mcData(bot)
  const it = data.itemsByName[itemName] || data.itemsArray.find((i) => i.name.includes(itemName))
  if (!it) return `Unknown item "${itemName}".`
  const itemType = it.id
  const have = () => bot.inventory.items().filter((i) => i.type === itemType).reduce((s, i) => s + i.count, 0)

  // Target containers: the given one first (if any), then nearby ones by distance.
  // Furnaces/smokers are included so we can grab smelted output too.
  const ids = ['chest', 'trapped_chest', 'barrel', 'furnace', 'blast_furnace', 'smoker'].map((n) => data.blocksByName[n]?.id).filter((v) => v != null)
  let positions = bot.findBlocks({ matching: ids, maxDistance: 32, count: 24 })
  positions.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b))
  if (x != null && y != null && z != null) {
    positions = positions.filter((p) => !(p.x === x && p.y === y && p.z === z))
    positions.unshift(new Vec3(x, y, z))
  }
  if (!positions.length) return `No container found nearby.`

  const seq = startSeq(bot)
  let withdrawn = 0
  let remaining = count
  let chestsUsed = 0
  for (const pos of positions) {
    if (remaining <= 0 || preempted(bot, seq)) break
    const block = bot.blockAt(pos)
    if (!isContainerBlock(block)) continue
    await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3)).catch(() => {})
    try { await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true) } catch { /* face the container */ }

    // Furnaces use a different API — take the matching item from the output slot.
    if (/furnace|smoker/.test(block.name)) {
      let furnace
      try { furnace = await bot.openFurnace(block) } catch { continue }
      await sleep(CHEST_PAUSE)
      const before = have()
      const out = furnace.outputItem()
      if (out && out.type === itemType) { try { await furnace.takeOutput() } catch { /* nothing ready */ } }
      await sleep(CHEST_PAUSE)
      furnace.close()
      await sleep(150)
      const got = have() - before
      if (got > 0) { withdrawn += got; remaining -= got; chestsUsed++ }
      continue
    }

    let chest
    try { chest = await bot.openContainer(block) } catch { continue }
    await sleep(CHEST_PAUSE) // hold it open a beat so the chest visibly opens
    const inChest = chest.containerItems().filter((i) => i.type === itemType).reduce((s, i) => s + i.count, 0)
    const take = Math.min(remaining, inChest)
    const before = have()
    if (take > 0) { try { await chest.withdraw(itemType, null, take) } catch { /* take what fit */ } }
    await sleep(CHEST_PAUSE) // pause before closing
    chest.close()
    await sleep(150)
    const got = have() - before // measure after closing — bot.inventory only updates then
    if (got > 0) { withdrawn += got; remaining -= got; chestsUsed++ }
  }

  if (withdrawn === 0) return `Couldn't find any ${it.name} in nearby containers.`
  if (remaining > 0) return `Withdrew ${withdrawn} ${it.name} from ${chestsUsed} container(s); ${remaining} more not found nearby.`
  return `Withdrew ${withdrawn} ${it.name} from ${chestsUsed} container(s).`
}

async function boatTo(bot, { x, z }) {
  const findBoat = () => bot.nearestEntity((e) => /_boat$|^boat$/i.test(e.name || ''))

  // Prefer a nearby placed boat; otherwise place one from inventory onto water.
  let boat = findBoat()
  if (boat && bot.entity.position.distanceTo(boat.position) > 6) {
    await bot.pathfinder.goto(new goals.GoalNear(boat.position.x, boat.position.y, boat.position.z, 2)).catch(() => {})
    boat = findBoat()
  }
  if (!boat) {
    const item = bot.inventory.items().find((i) => /_boat$/.test(i.name))
    if (!item) return `No boat nearby and none in inventory.`
    let water = bot.findBlock({ matching: (b) => b && b.name === 'water', maxDistance: 8 })
    if (!water) return `No water nearby to launch a boat.`
    await bot.pathfinder.goto(new goals.GoalNear(water.position.x, water.position.y, water.position.z, 2)).catch(() => {})
    await bot.equip(item, 'hand')
    // Aim at the surface of the closest water block and right-click to launch it.
    water = bot.findBlock({ matching: (b) => b && b.name === 'water', maxDistance: 5 }) || water
    for (let attempt = 0; attempt < 3 && !boat; attempt++) {
      await bot.lookAt(water.position.offset(0.5, 0.9, 0.5), true)
      await sleep(250)
      bot.activateItem()
      await sleep(700)
      boat = findBoat()
    }
    if (!boat) return `Couldn't place the boat on the water.`
  }

  // Board it.
  if (bot.entity.position.distanceTo(boat.position) > 3) {
    await bot.pathfinder.goto(new goals.GoalNear(boat.position.x, boat.position.y, boat.position.z, 1)).catch(() => {})
  }
  bot.mount(boat)
  await sleep(800)
  if (!bot.vehicle) return `Couldn't board the boat.`

  // Drive the boat toward (x, z) by sending vehicle_move packets (boats are
  // client-authoritative in modern MC, so we set the boat's position directly).
  // Track the position ourselves; bail at the water's edge.
  const seq = startSeq(bot)
  const start = Date.now()
  const bp = bot.vehicle.position
  let cx = bp.x, cz = bp.z
  const boatY = bp.y
  const isWater = (px, pz) => {
    for (const dy of [0, -1]) {
      const b = bot.blockAt(new Vec3(Math.floor(px), Math.floor(boatY) + dy, Math.floor(pz)))
      if (b && b.name === 'water') return true
    }
    return false
  }
  const STEP = 0.5
  let dist = Math.hypot(x - cx, z - cz)
  let dryRun = 0 // consecutive off-water steps (stop only after a sustained run on land)
  while (Date.now() - start < 60000 && dist >= 2) {
    if (preempted(bot, seq)) break
    const dx = x - cx, dz = z - cz
    dist = Math.hypot(dx, dz)
    if (dist < 2) break
    const nx = cx + (dx / dist) * Math.min(STEP, dist)
    const nz = cz + (dz / dist) * Math.min(STEP, dist)
    dryRun = isWater(nx, nz) ? 0 : dryRun + 1
    if (dryRun > 8) break // ~4 blocks over land — the water has run out
    const yawDeg = (Math.atan2(-dx, dz) * 180) / Math.PI
    try {
      bot._client.write('vehicle_move', { x: nx, y: boatY, z: nz, yaw: yawDeg, pitch: 0, onGround: false })
    } catch { break }
    cx = nx; cz = nz
    await sleep(80)
  }
  bot.dismount()
  await sleep(400)
  if (dist < 2) return `Boated to (${Math.round(cx)}, ${Math.round(boatY)}, ${Math.round(cz)}).`
  return `Stopped near (${Math.round(cx)}, ${Math.round(boatY)}, ${Math.round(cz)}) — ${Math.round(dist)} blocks short (water ran out or stuck).`
}

async function sleepInBed(bot) {
  if (bot.isSleeping) return 'Already sleeping.'
  const beds = bot.findBlocks({ matching: (b) => bot.isABed(b), maxDistance: 32, count: 32 })
  if (!beds.length) return 'No bed found within 32 blocks.'
  beds.sort((a, b) => bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b))

  // If a bed is taken, try the next one — at most one bed per online player can be
  // occupied, so cap the search at the player count.
  const maxTries = Math.max(1, Object.keys(bot.players).length)
  let occupied = 0
  for (let i = 0; i < beds.length && i < maxTries; i++) {
    const bed = bot.blockAt(beds[i])
    if (!bed || !bot.isABed(bed)) continue
    const props = bed.getProperties ? bed.getProperties() : {}
    if (props.occupied === true || props.occupied === 'true') { occupied++; continue } // taken — skip
    await bot.pathfinder.goto(new goals.GoalNear(beds[i].x, beds[i].y, beds[i].z, 2)).catch(() => {})
    try {
      await bot.sleep(bed)
      return `Sleeping in the bed at (${beds[i].x}, ${beds[i].y}, ${beds[i].z}).`
    } catch (e) {
      if (!/occupied/i.test(e.message)) return `Found a bed but couldn't sleep: ${e.message}.` // other beds won't help
      occupied++ // someone's in it — try the next bed
    }
  }
  return `Couldn't sleep — every nearby bed (checked ${Math.min(beds.length, maxTries)}) is occupied.`
}

// --- Named waypoints (persisted to waypoints.json) ---
const WAYPOINTS_FILE = path.join(__dirname, '..', 'waypoints.json')
function loadWaypoints() {
  try { return JSON.parse(fs.readFileSync(WAYPOINTS_FILE, 'utf8')) } catch { return {} }
}
function saveWaypoints(wp) {
  // Write to a temp file then rename, so a crash mid-write can't corrupt or
  // truncate the saved waypoints.
  const tmp = WAYPOINTS_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(wp, null, 2) + '\n')
  fs.renameSync(tmp, WAYPOINTS_FILE)
}
// The player whose position waypoints are saved at: the configured commander.
function commanderName() {
  const c = process.env.BOT_COMMANDER
  if (c && c !== '*') return c
  return process.env.MC_OWNER || 'kaikdidk'
}

// Turn to face the commander (falling back to the nearest player) — e.g. as a
// "done, what next?" gesture when a task finishes.
async function faceCommander(bot) {
  const ent = bot.players[commanderName()]?.entity || nearestPlayer(bot)
  if (!ent) return
  try { await bot.lookAt(ent.position.offset(0, ent.eyeHeight || 1.62, 0), true) } catch { /* ignore */ }
}

function saveWaypoint(bot, { name }) {
  const who = commanderName()
  const ent = bot.players[who]?.entity || nearestPlayer(bot)
  if (!ent) return `Can't see ${who} to save their position — stand near the bot and try again.`
  const p = ent.position
  const wp = loadWaypoints()
  const x = Math.round(p.x), y = Math.round(p.y), z = Math.round(p.z)
  wp[name.toLowerCase()] = { name, x, y, z }
  saveWaypoints(wp)
  return `Saved waypoint "${name}" at (${x}, ${y}, ${z}).`
}

async function tpWaypoint(bot, { name }) {
  const w = loadWaypoints()[name.toLowerCase()]
  if (!w) return `No waypoint named "${name}". Use listWaypoints to see saved ones.`
  const before = bot.entity.position.clone()
  bot.chat(`/tp ${bot.username} ${w.x} ${w.y} ${w.z}`)
  await sleep(700)
  if (bot.entity.position.distanceTo(before) > 2) return `Teleported to "${w.name}" (${w.x}, ${w.y}, ${w.z}).`
  return `Couldn't teleport to "${w.name}" — the bot must be opped for /tp (op it in-game or in server/ops.json).`
}

// Walk (not teleport) to a saved waypoint without modifying the world — no
// digging or block placing, same restricted movement as come/follow.
async function gotoWaypoint(bot, { name }) {
  const w = loadWaypoints()[name.toLowerCase()]
  if (!w) return `No waypoint named "${name}". Use listWaypoints to see saved ones.`
  if (bot.followMovements) bot.pathfinder.setMovements(bot.followMovements)
  try {
    await bot.pathfinder.goto(new goals.GoalNear(w.x, w.y, w.z, 1))
  } catch (e) {
    return `Couldn't walk to "${w.name}" (${w.x}, ${w.y}, ${w.z}) — no clear path without breaking or placing blocks.`
  }
  const p = bot.entity.position
  return `Walked to "${w.name}" (now at ${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)}).`
}

async function tpMe(bot, { name, username }) {
  const w = loadWaypoints()[name.toLowerCase()]
  if (!w) return `No waypoint named "${name}". Use listWaypoints to see saved ones.`
  const who = username || commanderName()
  const ent = bot.players[who]?.entity
  const before = ent ? ent.position.clone() : null
  bot.chat(`/tp ${who} ${w.x} ${w.y} ${w.z}`)
  await sleep(700)
  const after = bot.players[who]?.entity
  if (before && after && after.position.distanceTo(before) > 2) {
    return `Teleported ${who} to "${w.name}" (${w.x}, ${w.y}, ${w.z}).`
  }
  return `Sent ${who} to "${w.name}" (${w.x}, ${w.y}, ${w.z}). If nothing happened, the bot needs to be opped (/tp requires op).`
}

function listWaypoints() {
  const list = Object.values(loadWaypoints())
  if (!list.length) return 'No waypoints saved yet. Use saveWaypoint <name>.'
  return 'Waypoints: ' + list.map((w) => `${w.name} (${w.x}, ${w.y}, ${w.z})`).join('; ') + '.'
}

function deleteWaypoint(bot, { name }) {
  const wp = loadWaypoints()
  if (!wp[name.toLowerCase()]) return `No waypoint named "${name}".`
  delete wp[name.toLowerCase()]
  saveWaypoints(wp)
  return `Deleted waypoint "${name}".`
}

module.exports = {
  observe,
  inventory,
  healthStatus,
  wait,
  tpXYZ,
  saveWaypoint,
  tpWaypoint,
  gotoWaypoint,
  tpMe,
  listWaypoints,
  deleteWaypoint,
  boatTo,
  sleep: sleepInBed,
  chat,
  goTo,
  goToPlayer,
  followPlayer,
  stop,
  lookDirection,
  lookAt,
  lookAtMe,
  chitchat,
  move,
  turn,
  jump,
  findBlocks,
  mineNearestBlock,
  digTestTunnel,
  mineDownshaft,
  mineStairwell,
  digBlock,
  equipItem,
  dropItem,
  placeBlock,
  fillArea,
  buildWall,
  fillPit,
  plantField,
  normalizeSeed,
  levelArea,
  buildRectWall,
  ceiling,
  mineArea,
  fillSpan,
  mineSpan,
  wallSpan,
  attackEntity,
  eat,
  useItem,
  firework,
  tntCannon,
  collectItems,
  harvestAndCollect,
  replaceField,
  smeltItem,
  playDisc,
  trade,
  activateBlock,
  craftItem,
  depositToChest,
  unloadInventory,
  withdrawFromChest,
  equipBetterArmor,
}
