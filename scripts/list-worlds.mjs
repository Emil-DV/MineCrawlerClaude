// List the server's worlds and their properties. Reads each world's level.dat for
// its actual difficulty/gamemode, and falls back to the worlds.json profile for
// worlds that don't exist on disk yet. Marks the active world (server level-name).
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import nbt from 'prismarine-nbt'

const DIFF = ['peaceful', 'easy', 'normal', 'hard']
const MODE = ['survival', 'creative', 'adventure', 'spectator']

const props = existsSync('server/server.properties') ? readFileSync('server/server.properties', 'utf8') : ''
const active = (props.match(/^level-name=(.*)$/m) || [])[1]?.trim()
const profiles = existsSync('worlds.json') ? JSON.parse(readFileSync('worlds.json', 'utf8')) : {}

const folders = existsSync('server')
  ? readdirSync('server', { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(`server/${d.name}/level.dat`)).map((d) => d.name)
  : []
const names = [...new Set([...Object.keys(profiles), ...folders])].sort()

async function propsOf(name) {
  const p = profiles[name] || {}
  if (folders.includes(name)) {
    try {
      const { parsed } = await nbt.parse(readFileSync(`server/${name}/level.dat`))
      const data = parsed.value.Data.value
      return {
        difficulty: DIFF[data.Difficulty?.value] ?? p.difficulty ?? '?',
        gamemode: MODE[data.GameType?.value] ?? p.gamemode ?? '?',
        hardcore: !!data.hardcore?.value,
        exists: true,
      }
    } catch { /* fall through to profile */ }
  }
  return { difficulty: p.difficulty ?? '?', gamemode: p.gamemode ?? '?', hardcore: false, exists: folders.includes(name) }
}

if (!names.length) { console.log('No worlds found.'); process.exit(0) }
console.log(`\nWorlds (${names.length}):`)
for (const name of names) {
  const w = await propsOf(name)
  const mark = name === active ? ' *ACTIVE*' : ''
  const tags = [w.difficulty, w.gamemode, w.hardcore ? 'hardcore' : null, w.exists ? null : 'not created yet'].filter(Boolean).join(', ')
  console.log(`  ${name}${mark} — ${tags}`)
}
console.log(`\nStart one with:  ./scripts/start-server.sh <world>\n`)
