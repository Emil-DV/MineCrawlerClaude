// Point the server at a world and apply its profile from worlds.json to
// server.properties (level-name + difficulty/gamemode/etc). Usage: apply-world <world>
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const world = process.argv[2]
if (!world) { console.error('usage: apply-world <world>'); process.exit(1) }

const PROPS = 'server/server.properties'
const WORLDS = 'worlds.json'
if (!existsSync(PROPS)) { console.error(`${PROPS} not found — run the server once first.`); process.exit(1) }

const profiles = existsSync(WORLDS) ? JSON.parse(readFileSync(WORLDS, 'utf8')) : {}
const profile = profiles[world] || {}
// level-name selects the world folder; profile keys (difficulty, gamemode, …) are
// server.properties keys applied for this world.
const set = { 'level-name': world, ...profile }

const lines = readFileSync(PROPS, 'utf8').split('\n')
for (const [k, v] of Object.entries(set)) {
  const i = lines.findIndex((l) => l.startsWith(k + '='))
  if (i >= 0) lines[i] = `${k}=${v}`
  else lines.push(`${k}=${v}`)
}
writeFileSync(PROPS, lines.join('\n'))

const extra = Object.entries(profile).map(([k, v]) => `${k}=${v}`).join(', ')
console.log(`World set to "${world}"${extra ? ` (${extra})` : ''}.${profiles[world] ? '' : ' (no profile in worlds.json — using current server settings)'}`)
