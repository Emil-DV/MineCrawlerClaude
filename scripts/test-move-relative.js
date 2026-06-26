// Verify that `move` directions are relative to the bot's facing: the SAME
// command ("move forward") should send the bot a DIFFERENT world direction
// depending on which way it faces.
//
// SAFETY: this runs on a temporary floating platform far out in the wilderness
// sky (never on or near anything you've built). It builds the pad in empty air
// and removes it afterward, so it cannot damage existing structures.
//
// Run with the server up:  node scripts/test-move-relative.js
require('dotenv').config()
const mineflayer = require('mineflayer')
const { pathfinder, Movements } = require('mineflayer-pathfinder')
const actions = require('../src/minecraft-actions')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const FORWARD = { south: { x: 0, z: 1 }, north: { x: 0, z: -1 }, east: { x: 1, z: 0 }, west: { x: -1, z: 0 } }

// Remote, high-altitude scratch location — empty air, far from any build.
const SX = 3000, SY = 120, SZ = 3000, R = 5, DIST = 3

const bot = mineflayer.createBot({
  host: process.env.MC_HOST || 'localhost',
  port: Number(process.env.MC_PORT || 25565),
  username: 'TestBot',
  version: process.env.MC_VERSION || '1.21.4',
  auth: 'offline',
})
bot.loadPlugin(pathfinder)
bot.on('kicked', (r) => { console.log('KICKED:', JSON.stringify(r)); process.exit(1) })
bot.on('error', (e) => { console.log('ERROR:', e.message); process.exit(1) })

bot.once('spawn', async () => {
  bot.pathfinder.setMovements(new Movements(bot))
  await sleep(800)

  // Load the scratch chunk, then build a floating floor in the empty sky.
  bot.chat(`/tp TestBot ${SX} ${SY + 1} ${SZ}`)
  await sleep(1500)
  bot.chat(`/fill ${SX - R} ${SY} ${SZ - R} ${SX + R} ${SY} ${SZ + R} cobblestone`)
  await sleep(600)
  console.log(`Floating test pad built at (${SX}, ${SY}, ${SZ}).`)

  const recenter = async () => { bot.chat(`/tp TestBot ${SX} ${SY + 1} ${SZ}`); await sleep(900) }

  const perFacing = []
  for (const dir of ['south', 'north', 'east', 'west']) {
    await recenter()
    await actions.lookDirection(bot, { direction: dir })
    await sleep(300)
    const p0 = bot.entity.position.clone()
    await actions.move(bot, { direction: 'forward', distance: DIST }).catch((e) => console.log('move err:', e.message))
    await sleep(400)
    const p1 = bot.entity.position
    const dx = p1.x - p0.x, dz = p1.z - p0.z
    const e = FORWARD[dir]
    const onX = e.x !== 0
    const along = onX ? dx : dz
    const across = onX ? dz : dx
    const wantSign = onX ? e.x : e.z
    const ok = Math.sign(Math.round(along)) === wantSign && Math.abs(along) >= 1.5 && Math.abs(across) < 1.5
    perFacing.push({ dir, dx: dx.toFixed(1), dz: dz.toFixed(1), want: `${e.x ? 'x' : 'z'}${wantSign > 0 ? '+' : '-'}`, ok })
  }

  const perRel = []
  for (const rel of ['forward', 'back', 'left', 'right']) {
    await recenter()
    await actions.lookDirection(bot, { direction: 'south' })
    await sleep(300)
    const p0 = bot.entity.position.clone()
    await actions.move(bot, { direction: rel, distance: DIST }).catch(() => {})
    await sleep(400)
    const p1 = bot.entity.position
    perRel.push({ rel, dx: (p1.x - p0.x).toFixed(1), dz: (p1.z - p0.z).toFixed(1) })
  }

  // Remove the floating pad — back to empty air (it was void before).
  bot.chat(`/fill ${SX - R} ${SY} ${SZ - R} ${SX + R} ${SY + 2} ${SZ + R} air`)
  await sleep(400)

  console.log('\n=== "move forward 3" under each facing (delta should follow facing) ===')
  for (const r of perFacing) console.log(`${r.ok ? 'PASS' : 'FAIL'}  facing ${r.dir.padEnd(6)} → dx=${r.dx} dz=${r.dz}  (expected ${r.want})`)
  console.log('\n=== relative dirs while facing SOUTH (forward=+z, so: back=-z, left=+x, right=-x) ===')
  for (const r of perRel) console.log(`  ${r.rel.padEnd(8)} → dx=${r.dx} dz=${r.dz}`)

  const fails = perFacing.filter((r) => !r.ok)
  console.log(`\n${perFacing.length - fails.length}/${perFacing.length} facings moved in the correct relative direction.`)
  bot.quit()
  process.exit(fails.length ? 1 : 0)
})
