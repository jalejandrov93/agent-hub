// Fixture for process.test.mjs: spawns a grandchild and deliberately ignores
// both SIGINT and SIGTERM, so the only way to reap it (and its grandchild)
// is SIGKILL on the whole process group.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const [pidsFile] = process.argv.slice(2)

process.on('SIGINT', () => {
  // Deliberately ignored to force the SIGTERM/SIGKILL path.
})
process.on('SIGTERM', () => {
  // Deliberately ignored to force the SIGKILL path.
})

const grandchild = spawn(process.execPath, [path.join(HERE, 'heartbeat.mjs')], { stdio: 'ignore' })

fs.writeFileSync(pidsFile, JSON.stringify({ parentPid: process.pid, childPid: grandchild.pid }))

setInterval(() => {}, 1000)
