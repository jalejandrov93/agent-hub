import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnDetached, killProcessGroup, runWithTimeout } from '../src/process.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Poll until a pid is reaped: a just-SIGKILLed pid can stay a zombie for a tick. */
async function waitUntilDead(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
  return !isAlive(pid)
}

test('a child that ignores SIGTERM is SIGKILLed after the grace period, and its grandchild dies with it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-proc-'))
  const pidsFile = path.join(tmp, 'pids.json')

  const child = spawnDetached(process.execPath, [path.join(HERE, 'helpers', 'spawn-tree.mjs'), pidsFile], {
    stdio: 'ignore',
  })

  const deadline = Date.now() + 5000
  while (!fs.existsSync(pidsFile) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
  assert.ok(fs.existsSync(pidsFile), 'child reported its pids before the deadline')
  const { parentPid, childPid } = JSON.parse(fs.readFileSync(pidsFile, 'utf8'))
  assert.ok(isAlive(parentPid), 'sanity: parent alive before kill')
  assert.ok(isAlive(childPid), 'sanity: grandchild alive before kill')

  const start = Date.now()
  await killProcessGroup(child.pid, { graceMs: 300 })
  const elapsed = Date.now() - start

  assert.ok(elapsed >= 300, `expected SIGKILL only after the grace period, took ${elapsed}ms`)
  assert.ok(await waitUntilDead(parentPid), 'ignoring parent was SIGKILLed')
  assert.ok(await waitUntilDead(childPid), 'grandchild was reaped along with the group')
})

test('a well-behaved child that honors SIGTERM exits well before the grace period elapses', async () => {
  const child = spawnDetached(
    process.execPath,
    ['-e', 'process.on("SIGTERM", () => process.exit(0)); setInterval(() => {}, 1000)'],
    { stdio: 'ignore' }
  )
  await new Promise((r) => setTimeout(r, 200)) // let it install the handler

  const start = Date.now()
  await killProcessGroup(child.pid, { graceMs: 3000 })
  const elapsed = Date.now() - start

  assert.ok(elapsed < 2000, `expected an early exit via SIGTERM, took ${elapsed}ms`)
})

test('killProcessGroup on an already-dead pgid does not throw', async () => {
  const child = spawnDetached(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  await new Promise((resolve) => child.on('exit', resolve))
  await assert.doesNotReject(() => killProcessGroup(child.pid, { graceMs: 50 }))
})

test('runWithTimeout kills the process group and reports timedOut when the deadline passes', async () => {
  const child = spawnDetached(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  const { exitPromise } = runWithTimeout(child, { timeoutMs: 200, killGraceMs: 200 })
  const result = await exitPromise
  assert.equal(result.timedOut, true)
  assert.equal(isAlive(child.pid), false)
})

test('runWithTimeout resolves normally for a fast-exiting child, without a timeout', async () => {
  const child = spawnDetached(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const { exitPromise } = runWithTimeout(child, { timeoutMs: 5000 })
  const result = await exitPromise
  assert.equal(result.code, 0)
  assert.equal(result.timedOut, false)
})

test('runWithTimeout captures stdout chunks via the onStdout callback', async () => {
  const child = spawnDetached(process.execPath, ['-e', 'process.stdout.write("hello-world")'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const chunks = []
  const { exitPromise } = runWithTimeout(child, { timeoutMs: 5000, onStdout: (c) => chunks.push(c) })
  await exitPromise
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'hello-world')
})
