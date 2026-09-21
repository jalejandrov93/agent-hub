import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { getDispatchReservation } from '../src/storage/index.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-reservation-race-'))
}

const storageModuleUrl = new URL('../src/storage/index.mjs', import.meta.url).href

// A real cross-process race: every child busy-waits on the same deadline and
// then reserves the same key at the same instant. Exactly one may win.
//
// The JSON backend is the default (AGENT_HUB_STORE unset), so this is the path
// production actually takes.
const childScript = `
import { reserveDispatchKey } from ${JSON.stringify(storageModuleUrl)}
const deadline = Number(process.env.RACE_DEADLINE)
while (Date.now() < deadline) { /* barrier: release every child together */ }
let out
try {
  out = reserveDispatchKey({ backend: 'json', stateHome: process.env.AGENT_HUB_HOME }, { dispatchKey: process.env.RACE_KEY, jobId: process.env.RACE_JOB })
} catch (err) {
  out = { error: String(err && err.message ? err.message : err) }
}
process.stdout.write(JSON.stringify(out))
`

function runChild(home, deadline, key, jobId) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', childScript],
      {
        env: { ...process.env, AGENT_HUB_HOME: home, RACE_DEADLINE: String(deadline), RACE_KEY: key, RACE_JOB: jobId },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('close', (code) => {
      let parsed = null
      try { parsed = JSON.parse(stdout) } catch { /* leave null */ }
      resolve({ code, parsed, stdout, stderr, jobId })
    })
  })
}

test('T3: reserveDispatchKey is atomic across OS processes in the JSON backend', async () => {
  const home = tmpHome()
  const key = 'race-dispatch-key'
  const children = 8

  // Give every child time to spawn, then release them together.
  const deadline = Date.now() + 1500
  const results = await Promise.all(
    Array.from({ length: children }, (_, i) => runChild(home, deadline, key, `job-${i}`))
  )

  const errored = results.filter((r) => r.code !== 0 || !r.parsed || r.parsed.error)
  assert.deepEqual(
    errored.map((r) => ({ code: r.code, parsed: r.parsed, stderr: r.stderr.slice(0, 200) })),
    [],
    'every child must complete without error'
  )

  const winners = results.filter((r) => r.parsed.reserved === true)
  assert.equal(winners.length, 1, `exactly one child may reserve the key, got ${winners.length}`)

  const row = getDispatchReservation({ backend: 'json', stateHome: home }, key)
  assert.ok(row, 'the winning reservation must be persisted')
  assert.equal(row.job_id, winners[0].jobId, 'the persisted row must be the winner')

  const losers = results.filter((r) => r.parsed.reserved === false)
  assert.equal(losers.length, children - 1)
  for (const loser of losers) {
    assert.equal(loser.parsed.existingJobId, row.job_id, 'every loser must see the winning job')
  }
})
