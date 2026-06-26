// Downloads a vanilla Minecraft Java server.jar and configures it for local bot use.
// Usage: node scripts/setup-server.mjs [version]   (defaults to MC_VERSION or 1.21.4)
import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const version = process.argv[2] || process.env.MC_VERSION || '1.21.4'
const dir = 'server'
const jarPath = `${dir}/server.jar`

await mkdir(dir, { recursive: true })

if (!existsSync(jarPath)) {
  console.log('Fetching Mojang version manifest...')
  const manifest = await (await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json')).json()
  const entry = manifest.versions.find((v) => v.id === version)
  if (!entry) {
    console.error(`Version "${version}" not found in the manifest.`)
    process.exit(1)
  }
  const meta = await (await fetch(entry.url)).json()
  const url = meta.downloads?.server?.url
  if (!url) {
    console.error(`No server download available for ${version}.`)
    process.exit(1)
  }
  console.log(`Downloading server ${version}...`)
  const res = await fetch(url)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(jarPath))
  console.log(`Saved ${jarPath}`)
} else {
  console.log('server/server.jar already exists, skipping download.')
}

// Accept the EULA (you are agreeing to https://aka.ms/MinecraftEULA).
await writeFile(`${dir}/eula.txt`, 'eula=true\n')

// online-mode=false lets the offline bot (and you) join without Microsoft auth.
// Keep this server on your LAN only.
if (!existsSync(`${dir}/server.properties`)) {
  await writeFile(
    `${dir}/server.properties`,
    [
      'online-mode=false',
      'motd=Claude Minecraft Bot Server',
      'max-players=5',
      'spawn-protection=0',
      'difficulty=easy',
      'gamemode=survival',
      'view-distance=8',
      '',
    ].join('\n')
  )
  console.log('Wrote server.properties (online-mode=false).')
} else {
  console.log('server.properties exists — leaving it. Ensure online-mode=false.')
}

console.log('\nDone. Start the server with:  npm run server')
