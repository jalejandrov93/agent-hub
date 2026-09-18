import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-watch-'))
}

async function load(env) {
  const suffix = `?t=${Date.now()}-${Math.random()}`
  const { appendEvent } = await import(`../src/eventlog.mjs${suffix}`)
  const watch = await import(`../src/notify/watch.mjs${suffix}`)
  return { appendEvent, ...watch }
}

const evt = (kind, title) => ({ kind, agent: 'agy', model: 'm', cwd: '/tmp', title })

test('watcher emits new events and only new events', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const { appendEvent, watchEvents } = await load(env)
  const seen = []
  const handle = watchEvents({ env, onEvent: (e) => seen.push(e) })

  appendEvent(evt('job.finished', 't1'), { env })
  appendEvent(evt('job.failed', 't2'), { env })
  appendEvent(evt('job.finished', 't3'), { env })
  await handle.poll()

  assert.equal(seen.length, 3)
  assert.deepEqual(seen.map((e) => e.title), ['t1', 't2', 't3'])
  handle.close()
})

test('watcher skips malformed lines without stopping or replaying', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const { appendEvent, watchEvents } = await load(env)
  const { eventsFilePath } = await import(`../src/eventlog.mjs?t=${Date.now()}-paths`)
  const seen = []
  const handle = watchEvents({ env, onEvent: (e) => seen.push(e) })

  appendEvent(evt('job.finished', 'ok'), { env })
  fs.appendFileSync(eventsFilePath(env), 'not-json\n', 'utf8')
  await handle.poll()
  assert.equal(seen.length, 1)

  // No replay on the next poll: offset already advanced past the bad line.
  await handle.poll()
  assert.equal(seen.length, 1)
  handle.close()
})

test('reconnect with saved offset delivers no duplicates', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const { appendEvent, watchEvents } = await load(env)

  const first = []
  const h1 = watchEvents({ env, onEvent: (e) => first.push(e) })
  appendEvent(evt('job.finished', 'a'), { env })
  appendEvent(evt('job.finished', 'b'), { env })
  appendEvent(evt('job.finished', 'c'), { env })
  await h1.poll()
  assert.equal(first.length, 3)
  const offset = h1.getOffset()
  h1.close()

  const second = []
  const h2 = watchEvents({ env, sinceOffset: offset, onEvent: (e) => second.push(e) })
  await h2.poll()
  assert.equal(second.length, 0, 'nothing new since the saved offset')

  appendEvent(evt('job.finished', 'd'), { env })
  await h2.poll()
  assert.deepEqual(second.map((e) => e.title), ['d'])
  h2.close()
})

test('watcher fires on fs.watch appends without manual poll', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const { appendEvent, watchEvents } = await load(env)
  const seen = []
  const handle = watchEvents({ env, onEvent: (e) => seen.push(e) })

  appendEvent(evt('job.finished', 'live'), { env })
  const deadline = Date.now() + 3000
  while (seen.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.equal(seen.length, 1)
  assert.equal(seen[0].title, 'live')
  handle.close()
})

test('AbortSignal stops the watcher cleanly', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const { watchEvents } = await load(env)
  const controller = new AbortController()
  const handle = watchEvents({ env, onEvent: () => {}, signal: controller.signal })
  assert.equal(handle.closed, false)
  controller.abort()
  assert.equal(handle.closed, true)
  await handle.poll() // no-op after close, must not throw
})

test('watchEvents requires onEvent', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const { watchEvents } = await load(env)
  assert.throws(() => watchEvents({ env }), /onEvent/)
})
