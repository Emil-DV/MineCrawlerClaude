// Starts the local Minecraft server. Requires a JDK (Java 21+ for 1.20.5 and newer).
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

if (!existsSync('server/server.jar')) {
  console.error('server/server.jar not found. Run:  npm run server:setup')
  process.exit(1)
}

// Detect the installed Java major version ("1.8.0" -> 8, "21.0.1" -> 21).
function javaMajor() {
  const r = spawnSync('java', ['-version'])
  if (r.error) return null
  const m = (r.stderr?.toString() || r.stdout?.toString() || '').match(/version "(\d+)(?:\.(\d+))?/)
  if (!m) return null
  const major = Number(m[1])
  return major === 1 ? Number(m[2]) : major
}

const java = javaMajor()
if (java === null) {
  console.error('Java not found on PATH. Install a JDK (Java 21+) — see README "Prerequisites".')
  process.exit(1)
}
if (java < 21) {
  console.warn(
    `Detected Java ${java}. Minecraft 1.20.5+ requires Java 21+; the server may refuse to start.`
  )
}

const mem = process.env.MC_MEMORY || '2G'
const child = spawn('java', [`-Xmx${mem}`, `-Xms${mem}`, '-jar', 'server.jar', 'nogui'], {
  cwd: 'server',
  stdio: 'inherit',
})

child.on('error', (e) => {
  console.error('Failed to start Java. Is a JDK installed and on PATH?', e.message)
  process.exit(1)
})
child.on('exit', (code) => process.exit(code ?? 0))
