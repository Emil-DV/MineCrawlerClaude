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

function healthStatus(bot) {
  const hp = Math.round(bot.health ?? 0)
  const food = Math.round(bot.food ?? 0)
  const mood = hp >= 18 && food >= 16 ? 'Feeling great' : hp >= 10 ? 'Doing okay' : 'Not great'
  return `${mood} — health ${hp}/20, hunger ${food}/20.`
}

function inventory(bot) {
  const items = bot.inventory.items()
  if (!items.length) return 'Inventory is empty.'
  // Consolidate stacks: sum counts per item name.
  const counts = {}
  for (const i of items) counts[i.name] = (counts[i.name] || 0) + i.count
  const list = Object.entries(counts).map(([n, c]) => `${n} x${c}`)
  return `Inventory (${list.length} type${list.length === 1 ? '' : 's'}): ${list.join(', ')}.`
}

async function goTo(bot, { x, y, z }) {
  await bot.pathfinder.goto(new goals.GoalBlock(x, y, z))
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

// Nearest other player's entity (or null).
function nearestPlayer(bot) {
  const ps = Object.values(bot.players).filter((p) => p.username !== bot.username && p.entity)
  if (!ps.length) return null
  ps.sort((a, b) => bot.entity.position.distanceTo(a.entity.position) - bot.entity.position.distanceTo(b.entity.position))
  return ps[0].entity
}

// World-space unit vector of where an entity is looking (Mineflayer yaw: forward = -sin/-cos).
function lookVector(e) {
  const yaw = e.yaw || 0
  const pitch = e.pitch || 0
  return new Vec3(-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch))
}

async function mineNearestBlock(bot, { blockName, count = 4096 }) {
  const block = mcData(bot).blocksByName[blockName]
  if (!block) return `Unknown block type "${blockName}".`

  const seq = startSeq(bot)
  // Only target blocks the bot can actually see (clear line of sight) — no x-ray.
  const scan = () => bot.findBlocks({ matching: block.id, maxDistance: 48, count: 64, useExtraInfo: (b) => bot.canSeeBlock(b) })

  let mined = 0
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
      if (!positions.length) break // looked everywhere, still nothing visible
    }

    // Order by alignment with the nearest player's gaze (what they're looking at
    // first, then sweep outward); fall back to nearest if no player is around.
    const player = nearestPlayer(bot)
    if (player) {
      const eye = player.position.offset(0, player.eyeHeight || 1.62, 0)
      const gaze = lookVector(player)
      const align = (p) => {
        const d = p.offset(0.5, 0.5, 0.5).minus(eye)
        return d.dot(gaze) / (d.norm() || 1)
      }
      positions.sort((a, b) => {
        const diff = align(b) - align(a)
        if (Math.abs(diff) > 0.02) return diff
        return bot.entity.position.distanceTo(a) - bot.entity.position.distanceTo(b)
      })
    } // else: findBlocks already returns nearest-first

    const pos = positions[0]
    const target = bot.blockAt(pos)
    if (!target) break
    await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true) // look toward it as it goes
    await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2))
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
  await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3))
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
  if (!item) return `No "${itemName}" in inventory.`
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
  if (!item) return 'no-item'
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

  await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, 3))
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

async function plantField(bot, { seedName }) {
  const hoe = bot.inventory.items().find((i) => i.name === 'iron_hoe')
  if (!hoe) return `No iron_hoe in inventory.`
  if (!bot.inventory.items().some((i) => i.name === seedName || i.name.includes(seedName))) {
    return `No "${seedName}" in inventory.`
  }

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
      const above = bot.blockAt(new Vec3(x, floorY + 1, z))
      if (above && !REPLACEABLE.has(above.name)) { skipped++; continue } // no room to plant
      await bot.pathfinder.goto(new goals.GoalNear(x, floorY, z, 2)).catch(() => {})
      if (above && above.name !== 'air') { try { await bot.dig(above) } catch {} } // clear tall grass

      let ground = bot.blockAt(pos)
      if (ground && ground.name !== 'farmland') {
        await bot.equip(hoe, 'hand')
        await bot.lookAt(pos.offset(0.5, 1, 0.5), true)
        try { await bot.activateBlock(bot.blockAt(pos)) } catch {}
        await sleep(150)
        ground = bot.blockAt(pos)
      }
      if (!ground || ground.name !== 'farmland') { skipped++; continue }
      tilled++

      const seed = bot.inventory.items().find((i) => i.name === seedName || i.name.includes(seedName))
      if (!seed) return `Hoed ${tilled}, planted ${planted}, then ran out of ${seedName}.`
      await bot.equip(seed, 'hand')
      try { await bot.placeBlock(ground, new Vec3(0, 1, 0)); planted++ } catch {}
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
  await bot.pathfinder.goto(new goals.GoalNear(tx, ty, tz, 1))
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
  const foods = mcData(bot).foods
  const item = foodName
    ? bot.inventory.items().find((i) => i.name === foodName || i.name.includes(foodName))
    : bot.inventory.items().find((i) => foods[i.type])
  if (!item) return foodName ? `No "${foodName}" in inventory.` : 'No food in inventory.'
  await bot.equip(item, 'hand')
  try {
    await bot.consume()
  } catch (e) {
    return `Couldn't eat ${item.name}: ${e.message}`
  }
  return `Ate ${item.name}. Food level now ${bot.food}.`
}

async function useItem(bot) {
  const held = bot.heldItem?.name ?? 'nothing'
  if (held === 'nothing') return 'Nothing held to use. Equip an item first.'
  bot.activateItem()
  await sleep(300)
  bot.deactivateItem()
  return `Used ${held}.`
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
async function harvestAndCollect(bot, { blockName, count = 4096 }) {
  const seq = startSeq(bot)
  const mined = await mineNearestBlock(bot, { blockName, count })
  if (preempted(bot, seq)) return mined // a new command took over — don't keep collecting
  const collected = await collectItems(bot, { range: 24 })
  return `${mined} ${collected}`
}

async function activateBlock(bot, { x, y, z }) {
  const block = bot.blockAt(new Vec3(x, y, z))
  if (!block) return `No block at (${x}, ${y}, ${z}).`
  await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 3))
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
    await bot.pathfinder.goto(new goals.GoalNear(table.position.x, table.position.y, table.position.z, 3))
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

async function smeltItem(bot, { inputName, count = 1, fuelName }) {
  const data = mcData(bot)
  const items = bot.inventory.items()
  const input = items.find((i) => i.name === inputName) || items.find((i) => i.name.includes(inputName))
  if (!input) return `No "${inputName}" in inventory to smelt.`
  count = Math.min(count, input.count)

  const fuel = findFuel(bot, fuelName)
  if (!fuel) return `No fuel in inventory (need coal, charcoal, planks, etc.).`
  const perFuel = smeltsPerFuel(fuel.name)
  if (perFuel <= 0) return `"${fuel.name}" can't be used as fuel.`
  const fuelNeeded = Math.min(fuel.count, Math.ceil(count / perFuel))

  const ids = ['furnace', 'blast_furnace', 'smoker'].map((n) => data.blocksByName[n]?.id).filter((v) => v != null)
  const block = bot.findBlock({ matching: ids, maxDistance: 32 })
  if (!block) return `No furnace nearby.`

  await bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2)).catch(() => {})
  try { await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true) } catch { /* face it */ }
  let furnace
  try { furnace = await bot.openFurnace(block) } catch (e) { return `Couldn't open the furnace: ${e.message}` }

  const seq = startSeq(bot)
  try {
    await furnace.putFuel(fuel.type, null, fuelNeeded)
    await furnace.putInput(input.type, null, count)
  } catch (e) {
    furnace.close()
    return `Couldn't load the furnace: ${e.message}`
  }

  // Smelting takes ~10s per item (blast furnace/smoker are faster). Wait for the
  // input to be consumed, bailing on a new command or a generous timeout.
  const deadline = Date.now() + Math.min(count * 11000 + 15000, 360000)
  while (Date.now() < deadline) {
    if (preempted(bot, seq)) break
    await sleep(1000)
    if (!furnace.inputItem()) { await sleep(500); break } // all input smelted
  }

  let out = null
  try { out = await furnace.takeOutput() } catch { /* nothing ready */ }
  furnace.close()
  if (out && out.count > 0) return `Smelted ${out.count} ${out.name}.`
  return `Loaded the furnace (${count} ${input.name} + ${fuelNeeded} ${fuel.name}); still cooking — collect the output later.`
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
  const bed = bot.findBlock({ matching: (b) => bot.isABed(b), maxDistance: 32 })
  if (!bed) return 'No bed found within 32 blocks.'
  await bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2)).catch(() => {})
  try {
    await bot.sleep(bed)
  } catch (e) {
    return `Found a bed at (${bed.position.x}, ${bed.position.y}, ${bed.position.z}) but couldn't sleep: ${e.message}.`
  }
  return `Sleeping in the bed at (${bed.position.x}, ${bed.position.y}, ${bed.position.z}).`
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
  digBlock,
  equipItem,
  dropItem,
  placeBlock,
  fillArea,
  buildWall,
  fillPit,
  plantField,
  mineArea,
  fillSpan,
  mineSpan,
  wallSpan,
  attackEntity,
  eat,
  useItem,
  collectItems,
  harvestAndCollect,
  replaceField,
  smeltItem,
  activateBlock,
  craftItem,
  depositToChest,
  withdrawFromChest,
}
