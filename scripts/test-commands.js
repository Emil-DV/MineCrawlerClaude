// Functional test of every tool. Connects a throwaway bot, and (if the server
// puts it in creative) loads an inventory so happy-paths run for real in a small
// work area near spawn. Destructive/environment tools use safe inputs.
//
// Run with the server up:  node scripts/test-commands.js
require('dotenv').config()
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const mcDataLoader = require('minecraft-data')
const actions = require('../src/minecraft-actions')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || 'localhost',
  port: Number(process.env.MC_PORT || 25565),
  username: 'TestBot',
  version: process.env.MC_VERSION || '1.21.4',
  auth: 'offline',
})
bot.loadPlugin(pathfinder)

const results = []
async function run(label, fn) {
  try {
    const r = await fn()
    results.push({ ok: true, label, info: String(r).replace(/\s+/g, ' ').slice(0, 90) })
  } catch (e) {
    results.push({ ok: false, label, info: e.message })
  }
}

bot.on('kicked', (r) => { console.log('KICKED:', JSON.stringify(r)); process.exit(1) })
bot.on('error', (e) => { console.log('ERROR:', e.message); process.exit(1) })

bot.once('spawn', async () => {
  bot.pathfinder.setMovements(new Movements(bot))
  await sleep(800)
  const data = mcDataLoader(bot.version)
  const Item = require('prismarine-item')(bot.version)
  const mode = bot.game.gameMode
  const creative = mode === 'creative'
  const sp = bot.entity.position
  console.log(`TestBot spawned at (${Math.round(sp.x)}, ${Math.round(sp.y)}, ${Math.round(sp.z)}); gameMode=${mode}`)

  // Load a hotbar inventory so item-dependent tools have something to work with.
  if (creative && bot.creative) {
    const give = async (name, count, slot) => {
      const it = data.itemsByName[name]
      if (it) await bot.creative.setInventorySlot(slot, new Item(it.id, count))
    }
    try {
      await give('dirt', 64, 36)
      await give('cobblestone', 64, 37)
      await give('oak_log', 64, 38)
      await give('bread', 16, 39)
      await give('stone_pickaxe', 1, 40)
      await give('chest', 4, 41)
      await sleep(400)
      console.log('Loaded test inventory.')
    } catch (e) {
      console.log('Inventory load failed:', e.message)
    }
  } else {
    console.log('Not creative — item-dependent tools will report empty inventory.')
  }

  // Teleport to the nearest other character so the test runs where someone is.
  const others = Object.values(bot.players).filter((pl) => pl.username !== bot.username)
  if (others.length) {
    const withEntity = others.filter((pl) => pl.entity)
    const target = (withEntity.length
      ? withEntity.sort((a, b) => bot.entity.position.distanceTo(a.entity.position) - bot.entity.position.distanceTo(b.entity.position))[0]
      : others[0]).username
    const before = bot.entity.position.clone()
    bot.chat(`/tp ${bot.username} ${target}`)
    await sleep(1200)
    if (bot.entity.position.distanceTo(before) > 2) {
      console.log(`Teleported to ${target}.`)
    } else {
      console.log(`/tp to ${target} had no effect (TestBot may not be opped) — walking there instead.`)
      await actions.goToPlayer(bot, { username: target, range: 2 }).catch((e) => console.log('walk failed:', e.message))
    }
  } else {
    console.log('No other players online — testing at spawn.')
  }

  // Base + work coordinates, taken AFTER any teleport. Ground assumed at by-1.
  const bp = bot.entity.position
  const bx = Math.round(bp.x), by = Math.round(bp.y), bz = Math.round(bp.z)
  const wx = bx + 2, wz = bz
  const cx = bx + 3, cz = bz // chest spot

  // --- perception / harmless ---
  await run('observe', () => actions.observe(bot))
  await run('chat', () => actions.chat(bot, { message: 'running command test' }))
  await run('lookDirection', () => actions.lookDirection(bot, { direction: 'south' }))
  await run('lookAt', () => actions.lookAt(bot, { x: bx + 1, y: by, z: bz }))
  await run('turn', () => actions.turn(bot, { direction: 'left' }))
  await run('findBlocks', () => actions.findBlocks(bot, { blockName: 'stone', range: 24, count: 3 }))

  // --- inventory / equip ---
  await run('equipItem', () => actions.equipItem(bot, { itemName: 'stone_pickaxe' }))

  // Clear the work area (wx..cx, by..by+1, wz..wz+1) so placements have empty space.
  await actions.mineArea(bot, { x1: wx, y1: by, z1: wz, x2: cx, y2: by + 1, z2: wz + 1 }).catch(() => {})
  await sleep(300)

  // --- build then mine (real, in the cleared work area) ---
  await run('placeBlock', () => actions.placeBlock(bot, { blockName: 'dirt', x: wx, y: by, z: wz }))
  await run('digBlock', () => actions.digBlock(bot, { x: wx, y: by, z: wz }))
  await run('buildWall', () => actions.buildWall(bot, { blockName: 'cobblestone', x: wx, y: by, z: wz, direction: 'z', length: 2, height: 1 }))
  await run('mineArea', () => actions.mineArea(bot, { x1: wx, y1: by, z1: wz, x2: wx, y2: by, z2: wz + 1 }))
  await run('fillArea', () => actions.fillArea(bot, { blockName: 'dirt', x1: wx, y1: by, z1: wz, x2: wx, y2: by, z2: wz + 1 }))
  await actions.mineArea(bot, { x1: wx, y1: by, z1: wz, x2: wx, y2: by, z2: wz + 1 }).catch(() => {})

  // --- movement ---
  await run('move(forward)', () => actions.move(bot, { direction: 'forward', distance: 1 }))
  await run('move(back)', () => actions.move(bot, { direction: 'back', distance: 1 }))
  await run('goTo', () => actions.goTo(bot, { x: bx, y: by, z: bz }))
  await run('goToPlayer(guard)', () => actions.goToPlayer(bot, { username: '__nobody__' }))
  await run('followPlayer(guard)', () => actions.followPlayer(bot, { username: '__nobody__' }))
  await run('stop', () => actions.stop(bot))

  // --- items on the ground ---
  await run('dropItem', () => actions.dropItem(bot, { itemName: 'dirt', count: 1 }))
  await run('collectItems', () => actions.collectItems(bot, { range: 8 }))

  // --- chest I/O (place a chest, deposit, withdraw, activate, remove) ---
  await run('placeBlock(chest)', () => actions.placeBlock(bot, { blockName: 'chest', x: cx, y: by, z: cz }))
  await run('depositToChest', () => actions.depositToChest(bot, { x: cx, y: by, z: cz, itemName: 'dirt', count: 2 }))
  await run('withdrawFromChest', () => actions.withdrawFromChest(bot, { x: cx, y: by, z: cz, itemName: 'dirt', count: 1 }))
  await run('activateBlock', () => actions.activateBlock(bot, { x: cx, y: by, z: cz }))

  // --- survival / interaction ---
  await run('eat', () => actions.eat(bot, { foodName: 'bread' }))
  await run('useItem', () => actions.useItem(bot, {}))
  await run('craftItem', () => actions.craftItem(bot, { itemName: 'oak_planks', count: 1 }))

  // --- destructive: safe guard inputs ---
  await run('mineNearestBlock(guard)', () => actions.mineNearestBlock(bot, { blockName: 'notarealblock' }))
  await run('attackEntity(guard)', () => actions.attackEntity(bot, { target: '__nomob__' }))

  // --- cleanup the chest we placed ---
  await run('cleanup digBlock(chest)', () => actions.digBlock(bot, { x: cx, y: by, z: cz }))

  // Report
  console.log('\n===== COMMAND TEST RESULTS =====')
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.label.padEnd(24)} ${r.info}`)
  const fails = results.filter((r) => !r.ok)
  console.log(`\n${results.length - fails.length}/${results.length} ran without throwing.`)
  if (fails.length) console.log('Threw:', fails.map((f) => f.label).join(', '))
  bot.quit()
  process.exit(0)
})
