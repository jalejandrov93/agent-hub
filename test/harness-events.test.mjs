import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { closeDb } from '../src/storage/index.mjs'
import { readTail } from '../src/eventlog.mjs'
import { runWorkflow } from '../src/workflow/engine.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-harness-events-'))
}

test('eventos job.started/job.finished del engine incluyen harness + waitMode', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const result = await runWorkflow({
    workflow: { id: 'wf-harness-ev', name: 'events test', nodes: [{ id: 's1', type: 'delegate', task: 't' }] },
    env,
    dispatchFn: async () => ({ ok: true }),
  })
  assert.equal(result.status, 'succeeded')

  const events = readTail({ n: 20, env })
  const started = events.find((e) => e.kind === 'job.started' && e.step_id === 's1')
  const finished = events.find((e) => e.kind === 'job.finished' && e.step_id === 's1')
  assert.ok(started, 'job.started emitido')
  assert.ok(finished, 'job.finished emitido')
  assert.equal(started.harness, 'generic')
  assert.equal(started.waitMode, 'none')
  assert.equal(finished.harness, 'generic')
  assert.equal(finished.waitMode, 'none')
  closeDb(env)
})

test('eventos job.failed del engine incluyen harness + waitMode', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const result = await runWorkflow({
    workflow: { id: 'wf-harness-ev-fail', name: 'fail events test', nodes: [{ id: 's1', type: 'delegate', task: 't' }] },
    env,
    dispatchFn: async () => { throw new Error('boom') },
  })
  assert.equal(result.status, 'failed')

  const events = readTail({ n: 20, env })
  const failed = events.find((e) => e.kind === 'job.failed' && e.step_id === 's1')
  assert.ok(failed, 'job.failed emitido')
  assert.equal(failed.harness, 'generic')
  assert.equal(failed.waitMode, 'none')
  closeDb(env)
})
