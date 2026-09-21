import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-job-record-'))
}

async function loadJobstore() {
  return import('../src/jobstore.mjs?t=' + Date.now() + Math.random())
}

/**
 * A job record is the `JobRecord` contract (src/schemas.mjs). `agent` and
 * `model` are required strings. A record that violates it does not just fail
 * on its own: the dashboard validates `/api/state` as one payload, so a single
 * malformed record blanked EVERY job-list view (observed live: two `queued`
 * records with no agent/model, written by a caller that omitted them).
 */
test('createJob rejects a record without agent or model', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { createJob } = await loadJobstore()

  assert.throws(() => createJob({ model: 'm', task: 't', cwd: '/tmp', env }), /agent/)
  assert.throws(() => createJob({ agent: 'agy', task: 't', cwd: '/tmp', env }), /model/)
  assert.throws(() => createJob({ agent: '', model: 'm', task: 't', cwd: '/tmp', env }), /agent/)
  assert.throws(() => createJob({ agent: 'agy', model: '', task: 't', cwd: '/tmp', env }), /model/)
  assert.throws(() => createJob({ agent: null, model: 'm', task: 't', cwd: '/tmp', env }), /agent/)

  // Rejected before any directory is allocated: no half-written job is left behind.
  const runs = path.join(home, 'runs')
  assert.ok(!fs.existsSync(runs) || fs.readdirSync(runs).length === 0)
})

test('buildState drops a malformed job record instead of blanking the whole payload', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  // A real, contract-complete job record.
  const { createJob } = await loadJobstore()
  const good = createJob({ agent: 'agy', model: 'gemini-3.8-flash-low', task: 't', cwd: '/tmp', title: 'good', env })

  // A record as a buggy caller used to write it: no agent/model at all.
  const badDir = path.join(home, 'runs', '2026-09-21T00-05-38-177Z-badbadbad')
  fs.mkdirSync(badDir, { recursive: true })
  fs.writeFileSync(
    path.join(badDir, 'result.json'),
    JSON.stringify({ jobId: '2026-09-21T00-05-38-177Z-badbadbad', status: 'queued', mode: 'read', createdAt: '2026-09-21T00:05:38.184Z', updatedAt: '2026-09-21T00:05:38.184Z' })
  )

  const { buildState } = await import('../src/dashboard.mjs?t=' + Date.now() + Math.random())
  const state = buildState({ env })
  const ids = state.jobs.map((j) => j.jobId)

  assert.ok(ids.includes(good.jobId), 'the valid job must survive')
  assert.ok(!ids.includes('2026-09-21T00-05-38-177Z-badbadbad'), 'the malformed record must not reach the client')

  // The whole payload still satisfies the contract the dashboard parses.
  const { StateResponse } = await import('../src/schemas.mjs?t=' + Date.now() + Math.random())
  assert.equal(StateResponse.safeParse(state).success, true)
})
