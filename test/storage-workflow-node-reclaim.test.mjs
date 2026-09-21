import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  initDb,
  resetDbInstances,
  upsertWorkflowNode,
  getWorkflowNode,
  reclaimOrphanedWorkflowNode,
} from '../src/storage/index.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-node-reclaim-'))
}

afterEach(() => {
  resetDbInstances()
})

function sqliteCtx() {
  const ctx = initDb(tmpHome())
  assert.equal(ctx.backend, 'sqlite')
  return ctx
}

function jsonCtx() {
  return { backend: 'json', stateHome: tmpHome() }
}

const backends = [
  ['sqlite', sqliteCtx],
  ['json fallback', jsonCtx],
]

for (const [label, makeCtx] of backends) {
  test(`reclaimOrphanedWorkflowNode (${label}): releases to ready when the observed status/owner/updated_at still match`, () => {
    const ctx = makeCtx()
    const seenUpdatedAt = new Date(Date.now() - 60_000).toISOString()
    upsertWorkflowNode(ctx, {
      workflow_id: 'wf-1',
      step_id: 'a',
      status: 'running',
      attempt: 0,
      claimed_by: 'dead_worker',
      updated_at: seenUpdatedAt,
    })

    const released = reclaimOrphanedWorkflowNode(ctx, {
      workflowId: 'wf-1',
      stepId: 'a',
      expectedStatus: 'running',
      expectedClaimedBy: 'dead_worker',
      expectedUpdatedAt: seenUpdatedAt,
    })

    assert.equal(released, true)
    const row = getWorkflowNode(ctx, 'wf-1', 'a')
    assert.equal(row.status, 'ready')
    assert.equal(row.claimed_by, null)
  })

  test(`reclaimOrphanedWorkflowNode (${label}): a stale observed row (another owner re-claimed) is a no-op and the new claim survives`, () => {
    const ctx = makeCtx()
    const staleUpdatedAt = new Date(Date.now() - 60_000).toISOString()
    upsertWorkflowNode(ctx, {
      workflow_id: 'wf-2',
      step_id: 'a',
      status: 'running',
      attempt: 0,
      claimed_by: 'dead_worker',
      updated_at: staleUpdatedAt,
    })

    // P1 already reclaimed and re-claimed the node before P2's release runs.
    const freshUpdatedAt = new Date().toISOString()
    upsertWorkflowNode(ctx, {
      workflow_id: 'wf-2',
      step_id: 'a',
      status: 'running',
      attempt: 1,
      claimed_by: 'p1',
      updated_at: freshUpdatedAt,
    })

    // P2 still acts on the row it read before P1's write (`staleUpdatedAt`/`dead_worker`).
    const released = reclaimOrphanedWorkflowNode(ctx, {
      workflowId: 'wf-2',
      stepId: 'a',
      expectedStatus: 'running',
      expectedClaimedBy: 'dead_worker',
      expectedUpdatedAt: staleUpdatedAt,
    })

    assert.equal(released, false, 'a lost CAS must change nothing')
    const row = getWorkflowNode(ctx, 'wf-2', 'a')
    assert.equal(row.status, 'running')
    assert.equal(row.claimed_by, 'p1', "P1's fresh claim must survive")
    assert.equal(row.attempt, 1)
  })
}
