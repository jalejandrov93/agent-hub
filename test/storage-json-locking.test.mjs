import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { listJobIds, listAgentMessages } from '../src/storage/index.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-json-locking-'))
}

const storageModuleUrl = new URL('../src/storage/index.mjs', import.meta.url).href

// Every JSON mutation is a read-modify-write of the WHOLE store: without one
// critical section per mutation, concurrent processes lose each other's writes
// (the last writer wins and drops whatever it did not read).
const childScript = `
import { insertAgentMessage, upsertJob } from ${JSON.stringify(storageModuleUrl)}

const deadline = Number(process.env.RACE_DEADLINE)
while (Date.now() < deadline) { /* barrier: release every child together */ }

const ctx = { backend: 'json', stateHome: process.env.AGENT_HUB_HOME }
const tag = process.env.RACE_TAG
try {
  for (let i = 0; i < 5; i++) {
    upsertJob(ctx, { job_id: 'job-' + tag + '-' + i, result_json: JSON.stringify({ tag, i }) })
    insertAgentMessage(ctx, {
      root_execution_id: 'root',
      from_agent: 'sender-' + tag,
      to_agent: 'receiver',
      kind: 'note',
      text: tag + '-' + i,
    })
  }
  process.stdout.write(JSON.stringify({ ok: true }))
} catch (err) {
  process.stdout.write(JSON.stringify({ error: String(err && err.message ? err.message : err) }))
}
`

function runChild(home, deadline, tag) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
      env: { ...process.env, AGENT_HUB_HOME: home, RACE_DEADLINE: String(deadline), RACE_TAG: tag },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('close', (code) => {
      let parsed = null
      try { parsed = JSON.parse(stdout) } catch { /* leave null */ }
      resolve({ code, parsed, stdout, stderr })
    })
  })
}

test('T8: concurrent JSON writers do not lose store updates from each other', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const ctx = { backend: 'json', stateHome: home }
  const children = 4
  const perChild = 5

  const deadline = Date.now() + 1500
  const tags = ['a', 'b', 'c', 'd']
  const results = await Promise.all(tags.map((tag) => runChild(home, deadline, tag)))

  const errored = results.filter((r) => r.code !== 0 || !r.parsed || r.parsed.error)
  assert.deepEqual(
    errored.map((r) => ({ code: r.code, parsed: r.parsed, stderr: r.stderr.slice(0, 300) })),
    [],
    'every child must complete without error'
  )

  const jobIds = listJobIds(ctx)
  assert.equal(
    jobIds.length,
    children * perChild,
    `every job write must survive (expected ${children * perChild}, got ${jobIds.length})`
  )

  const messages = listAgentMessages(ctx, {})
  assert.equal(
    messages.length,
    children * perChild,
    `every message write must survive (expected ${children * perChild}, got ${messages.length})`
  )

  // The reader must also never see a half-written store: it parses, or the
  // counts above would already have collapsed to zero (readJsonStore falls back
  // to the empty default on a parse error).
  const raw = fs.readFileSync(path.join(home, 'storage.json'), 'utf8')
  assert.doesNotThrow(() => JSON.parse(raw))
  assert.equal(Object.keys(JSON.parse(raw).jobs).length, children * perChild)
})

test('T8: an unlocked reader never observes a truncated store', async () => {
  const home = tmpHome()
  const ctx = { backend: 'json', stateHome: home }

  const { upsertJob } = await import('../src/storage/index.mjs')
  const { readJsonSafe } = await import('../src/fsutil.mjs')
  const file = path.join(home, 'storage.json')

  // The atomic writer must never leave a partially written target behind: a
  // parse failure would silently degrade to the empty default store.
  for (let i = 0; i < 50; i++) {
    upsertJob(ctx, { job_id: `job-${i}`, result_json: JSON.stringify({ i }) })
    const parsed = readJsonSafe(file, { jobs: {} })
    assert.equal(Object.keys(parsed.jobs).length, i + 1, `store must stay valid after write ${i}`)
  }
})
