import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-eventlog-'))
}

test('appendEvent writes exactly one JSON line per call', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { appendEvent, readTail } = await import('../src/eventlog.mjs?t=' + Date.now())

  appendEvent({ kind: 'job.queued', agent: 'agy', model: 'gemini-3.8-flash-low', cwd: '/tmp', title: 't1' })
  appendEvent({ kind: 'job.started', agent: 'agy', model: 'gemini-3.8-flash-low', cwd: '/tmp', title: 't1' })

  const events = readTail({ n: 10 })
  assert.equal(events.length, 2)
  assert.equal(events[0].kind, 'job.queued')
  assert.equal(events[1].kind, 'job.started')
  assert.ok(events[0].ts, 'event gets a timestamp')
  assert.equal(events[0].source, 'hub')
})

test('appendEvent fills required fields and caps summary under 4KB per line', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { appendEvent, readTail } = await import('../src/eventlog.mjs?t=' + Date.now())

  const hugeSummary = 'x'.repeat(10000)
  appendEvent({ kind: 'job.finished', agent: 'copilot', model: 'gpt-5-mini', cwd: '/tmp', title: 'huge', summary: hugeSummary })

  const raw = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8')
  const lines = raw.split('\n').filter(Boolean)
  assert.equal(lines.length, 1)
  assert.ok(Buffer.byteLength(lines[0] + '\n', 'utf8') < 4096, 'line must stay under 4KB')

  const events = readTail({ n: 1 })
  assert.ok(events[0].summary.length < hugeSummary.length, 'summary got truncated')
})

test('readTail respects n and returns newest-last order', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { appendEvent, readTail } = await import('../src/eventlog.mjs?t=' + Date.now())

  for (let i = 0; i < 5; i++) {
    appendEvent({ kind: 'job.finished', agent: 'agy', model: 'x', cwd: '/tmp', title: `t${i}` })
  }
  const events = readTail({ n: 3 })
  assert.equal(events.length, 3)
  assert.equal(events[2].title, 't4')
  assert.equal(events[0].title, 't2')
})

test('readTail tolerates a malformed trailing line without throwing', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { appendEvent, readTail } = await import('../src/eventlog.mjs?t=' + Date.now())
  appendEvent({ kind: 'job.finished', agent: 'agy', model: 'x', cwd: '/tmp', title: 'ok' })
  fs.appendFileSync(path.join(home, 'events.jsonl'), 'not-json\n')

  const events = readTail({ n: 10 })
  assert.equal(events.length, 1)
  assert.equal(events[0].title, 'ok')
})

test('N concurrent child processes each appending M events produce N*M valid JSON lines with no corruption', async () => {
  const home = tmpHome()
  const N = 8
  const M = 25
  const worker = path.join(HERE, 'helpers', 'eventlog-append-worker.mjs')

  const children = Array.from({ length: N }, (_, i) => {
    return new Promise((resolve, reject) => {
      const child = fork(worker, [String(M), String(i)], {
        env: { ...process.env, AGENT_HUB_HOME: home },
        stdio: 'inherit',
      })
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${i} exited ${code}`))))
      child.on('error', reject)
    })
  })

  await Promise.all(children)

  const raw = fs.readFileSync(path.join(home, 'events.jsonl'), 'utf8')
  const lines = raw.split('\n').filter(Boolean)
  assert.equal(lines.length, N * M, `expected ${N * M} lines, got ${lines.length}`)

  for (const line of lines) {
    const parsed = JSON.parse(line) // throws on corruption/interleaving
    assert.ok(typeof parsed.workerId === 'number')
    assert.ok(typeof parsed.seq === 'number')
  }
})
