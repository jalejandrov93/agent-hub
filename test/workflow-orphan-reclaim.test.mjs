import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDb, closeDb, upsertWorkflowNode, getWorkflowNode } from '../src/storage/index.mjs'
import { runWorkflow, reclaimOrphanedNode, claimNode } from '../src/workflow/engine.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-orphan-reclaim-'))
}

// Creates the workflow row (definition_json) by running it once to failure, so
// the test can then simulate a peer that died mid-node with a raw upsert.
async function seedFailedWorkflow(env, workflow) {
  await runWorkflow({
    workflow,
    env,
    dispatchFn: async () => {
      throw new Error('seed run fails on purpose')
    },
    backoffMs: 1,
  })
}

test('T2: a node orphaned by a dead worker (expired lease) is reclaimed and executed on resume', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const workflow = {
    id: 'wf-orphan-expired',
    name: 'expired orphan',
    nodes: [{ id: 'work', type: 'delegate', task: 'w', maxAttempts: 1 }],
  }

  await seedFailedWorkflow(env, workflow)
  closeDb(env)

  // A peer claimed the node and died: its lease is far in the past.
  const dbCtx = getDb(env)
  upsertWorkflowNode(dbCtx, {
    workflow_id: 'wf-orphan-expired',
    step_id: 'work',
    status: 'running',
    attempt: 0,
    claimed_by: 'dead_worker',
    updated_at: new Date(Date.now() - 10 * 60_000).toISOString(),
  })
  closeDb(env)

  const dispatched = []
  const result = await runWorkflow({
    workflowId: 'wf-orphan-expired',
    env,
    dispatchFn: async ({ workflowStep }) => {
      dispatched.push(workflowStep)
      return { ok: true }
    },
    pollIntervalMs: 10,
  })

  assert.equal(result.status, 'succeeded')
  assert.deepEqual(dispatched, ['work'])
  assert.equal(getWorkflowNode(getDb(env), 'wf-orphan-expired', 'work').status, 'succeeded')
  closeDb(env)
})

test('T2: a stale foreign claim on a ready node fails the run bound instead of hanging', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const workflow = {
    id: 'wf-orphan-live',
    name: 'ghost claim',
    nodes: [{ id: 'work', type: 'delegate', task: 'w', maxAttempts: 1 }],
  }

  await seedFailedWorkflow(env, workflow)
  closeDb(env)

  // A READY row carrying a foreign owner: no one can pass the owner-aware CAS,
  // and reclaim only re-queues running/waiting nodes, so this is the residual
  // state the stall bound exists for. It must fail bounded, never hang.
  const dbCtx = getDb(env)
  upsertWorkflowNode(dbCtx, {
    workflow_id: 'wf-orphan-live',
    step_id: 'work',
    status: 'ready',
    attempt: 0,
    claimed_by: 'ghost_owner',
    updated_at: new Date(Date.now() - 10 * 60_000).toISOString(),
  })
  closeDb(env)

  let dispatchCalls = 0
  await assert.rejects(
    () =>
      runWorkflow({
        workflowId: 'wf-orphan-live',
        env,
        dispatchFn: async () => {
          dispatchCalls++
          return { ok: true }
        },
        pollIntervalMs: 10,
        leaseTtlMs: 200,
        stallTimeoutS: 0.5,
      }),
    /stalled/,
  )

  assert.equal(dispatchCalls, 0, "a foreign claim must never be taken by force")
  closeDb(env)
})

test('T1: reclaimOrphanedNode loses the CAS when a peer already reclaimed and re-claimed the node between the read and the release', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const workflow = {
    id: 'wf-interleave',
    name: 'interleave',
    nodes: [{ id: 'work', type: 'delegate', task: 'w', maxAttempts: 1 }],
  }

  await seedFailedWorkflow(env, workflow)
  closeDb(env)

  // A peer claimed the node and died: its lease is far in the past.
  const dbCtx = getDb(env)
  const staleUpdatedAt = new Date(Date.now() - 10 * 60_000).toISOString()
  upsertWorkflowNode(dbCtx, {
    workflow_id: 'wf-interleave',
    step_id: 'work',
    status: 'running',
    attempt: 0,
    claimed_by: 'dead_worker',
    updated_at: staleUpdatedAt,
  })

  // P2 reads the orphaned row exactly like the scheduler wave would.
  const seenByP2 = getWorkflowNode(dbCtx, 'wf-interleave', 'work')

  // Interleaving: P1 reclaims AND re-claims the node before P2 acts on its
  // stale read.
  const reclaimedByP1 = reclaimOrphanedNode(dbCtx, {
    workflowId: 'wf-interleave',
    stepId: 'work',
    row: seenByP2,
    claimedBy: 'p1',
    ownerAlive: () => false,
    hasExplicitProbe: false,
    leaseTtlMs: 1000,
  })
  assert.equal(reclaimedByP1, true)
  const claimedByP1 = claimNode(dbCtx, { workflowId: 'wf-interleave', stepId: 'work', claimedBy: 'p1', attempt: 1 })
  assert.equal(claimedByP1, true)

  // P2 now acts on `seenByP2`, the row it read BEFORE P1's write.
  const releasedByP2 = reclaimOrphanedNode(dbCtx, {
    workflowId: 'wf-interleave',
    stepId: 'work',
    row: seenByP2,
    claimedBy: 'p2',
    ownerAlive: () => false,
    hasExplicitProbe: false,
    leaseTtlMs: 1000,
  })

  assert.equal(releasedByP2, false, "P2's stale read must not clobber P1's fresh claim")
  const finalRow = getWorkflowNode(dbCtx, 'wf-interleave', 'work')
  assert.equal(finalRow.status, 'running')
  assert.equal(finalRow.claimed_by, 'p1', "P1's claim must survive P2's stale reclaim")
  closeDb(env)
})
