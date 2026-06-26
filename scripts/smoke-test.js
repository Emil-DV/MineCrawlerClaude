// Non-destructive smoke test: connects a throwaway bot and calls each action
// directly (no LLM). Destructive tools are exercised via safe guard inputs so
// the world is not modified. Run with: node scripts/smoke-test.js
require('dotenv').config()
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const actions = require('../src/minecraft-actions')

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || 'localhost',
  port: Number(process.env.MC_PORT || 25565),
  username: 'SmokeBot',
  version: process.env.MC_VERSION || '1.21.4',
  auth: 'offline',
})

bot.loadPlugin(pathfinder)

const results = []
async function run(label, fn) {
  try {
    const r = await fn()
    results.push(`PASS  ${label} -> ${r}`)
  } catch (e) {
    results.push(`ERROR ${label} -> ${e.message}`)
  }
}

bot.once('spawn', async () => {
  bot.pathfinder.setMovements(new Movements(bot))
  const p = bot.entity.position
  const X = Math.round(p.x)
  const Y = Math.round(p.y)
  const Z = Math.round(p.z)

  // Genuinely executed (harmless / read-only)
  await run('observe', () => actions.observe(bot))
  await run('chat', () => actions.chat(bot, { message: 'smoke test running' }))
  await run('lookDirection', () => actions.lookDirection(bot, { direction: 'north' }))
  await run('lookAt', () => actions.lookAt(bot, { x: X + 1, y: Y, z: Z }))
  await run('collectItems', () => actions.collectItems(bot, { range: 6 }))
  await run('findBlocks(stone)', () => actions.findBlocks(bot, { blockName: 'stone', range: 16, count: 3 }))
  await run('findBlocks(bad-name)', () => actions.findBlocks(bot, { blockName: 'notarealblock' }))
  await run('eat(no-food)', () => actions.eat(bot, {}))
  await run('useItem(empty-hand)', () => actions.useItem(bot, {}))

  // Executed against the world but non-destructive (targets air / no inventory)
  await run('mineArea(air-above)', () => actions.mineArea(bot, { x1: X, y1: Y + 4, z1: Z, x2: X, y2: Y + 4, z2: Z }))
  await run('placeBlock(no-item)', () => actions.placeBlock(bot, { blockName: 'dirt', x: X + 2, y: Y, z: Z }))
  await run('fillArea(no-item)', () => actions.fillArea(bot, { blockName: 'dirt', x1: X + 2, y1: Y, z1: Z + 2, x2: X + 2, y2: Y, z2: Z + 2 }))

  // Destructive tools exercised via safe guard inputs (early return, no world change)
  await run('mineNearestBlock(bad-name)', () => actions.mineNearestBlock(bot, { blockName: 'notarealblock' }))
  await run('attackEntity(no-target)', () => actions.attackEntity(bot, { target: 'nonexistent_mob_xyz' }))
  await run('craftItem(unknown)', () => actions.craftItem(bot, { itemName: 'notarealitem' }))
  await run('depositToChest(no-item-guard)', () => actions.depositToChest(bot, { x: X, y: Y, z: Z, itemName: 'dirt' }))
  await run('withdrawFromChest(unknown-item-guard)', () => actions.withdrawFromChest(bot, { x: X, y: Y, z: Z, itemName: 'notarealitem' }))

  console.log('\n===== SMOKE TEST RESULTS =====')
  for (const line of results) console.log(line)
  const errors = results.filter((r) => r.startsWith('ERROR')).length
  console.log(`\n${results.length - errors}/${results.length} passed, ${errors} error(s).`)
  bot.quit()
  process.exit(errors ? 1 : 0)
})

bot.on('kicked', (r) => { console.log('KICKED:', r); process.exit(1) })
bot.on('error', (e) => { console.log('ERROR:', e.message); process.exit(1) })
