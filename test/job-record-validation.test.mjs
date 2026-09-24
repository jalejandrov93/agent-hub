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

/**
 * job-project-branch: `repo` is optional/nullable so existing records (and a
 * remote job with no local cwd) still validate, but when present it must
 * carry the shape the dashboard's Project column reads.
 */
test('JobRecord validates a job with a repo field, without it, and with it explicitly null', async () => {
  const { JobRecord } = await import('../src/schemas.mjs?t=' + Date.now() + Math.random())

  const base = {
    jobId: 'j1',
    agent: 'agy',
    model: 'm',
    title: null,
    cwd: '/tmp/repo',
    mode: 'write',
    status: 'succeeded',
    errorKind: null,
    error: null,
    timeoutS: null,
    variant: null,
    sessionId: null,
    parentJobId: null,
    tokens: null,
    costUsd: null,
    pid: null,
    pgid: null,
    createdAt: '2026-09-21T00:00:00.000Z',
    updatedAt: '2026-09-21T00:00:00.000Z',
  }

  const withRepo = JobRecord.safeParse({ ...base, repo: { root: '/tmp/repo', name: 'repo', branch: 'main' } })
  assert.equal(withRepo.success, true)

  const withNullBranch = JobRecord.safeParse({ ...base, repo: { root: '/tmp/repo', name: 'repo', branch: null } })
  assert.equal(withNullBranch.success, true)

  const withNullRepo = JobRecord.safeParse({ ...base, repo: null })
  assert.equal(withNullRepo.success, true)

  const withoutRepo = JobRecord.safeParse({ ...base })
  assert.equal(withoutRepo.success, true)

  // A malformed repo shape must actually be rejected -- proves `repo` has a
  // real schema, not just passthrough acceptance of whatever's there.
  const withInvalidRepo = JobRecord.safeParse({ ...base, repo: { root: 123, name: 'repo', branch: 'main' } })
  assert.equal(withInvalidRepo.success, false)
})
