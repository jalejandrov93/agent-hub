import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  getDb,
  closeDb,
  upsertWorkflowNode,
  getWorkflowNode,
  listWorkflowNodes,
} from '../src/storage/index.mjs'
import { runWorkflow, transitionNode, claimNode } from '../src/workflow/engine.mjs'
import { NODE_STATUS } from '../src/workflow/state.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-wf-engine-'))
}

test('workflow transitions: all state changes route through transitionNode/claimNode', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-transitions',
    name: 'transitions test',
    nodes: [
      { id: 'step_1', type: 'delegate', task: 't1', maxAttempts: 2 },
    ]
  }

  const dbCtx = getDb(env)

  // Set initial state manually without using transitionNode
  upsertWorkflowNode(dbCtx, {
    workflow_id: 'wf-transitions',
    step_id: 'step_1',
    status: 'succeeded',
    attempt: 1,
    updated_at: new Date().toISOString()
  })

  try {
    transitionNode(dbCtx, {
      workflowId: 'wf-transitions',
      stepId: 'step_1',
      from: 'succeeded',
      to: 'running',
      attempt: 1,
    })
    assert.fail('Should have rejected illegal transition from succeeded to running')
  } catch (err) {
    assert.match(err.message, /invalid node state transition/i)
  }

  closeDb(env)
})

test('engine: drives workflow and records valid transitions', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-drive',
    name: 'drive test',
    nodes: [
      { id: 'step_1', type: 'delegate', task: 't1', maxAttempts: 2 },
    ]
  }

  let attempts = 0
  const mockDispatch = async (params) => {
    attempts++
    if (attempts === 1) throw new Error('First attempt failed')
    return { ok: true }
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
    backoffMs: 1
  })

  assert.equal(result.status, 'succeeded')
  const node = result.nodes.step_1
  assert.equal(node.status, 'succeeded')
  assert.equal(node.attempt, 2)

  closeDb(env)
})

test('engine: drives workflow through failure', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-fail',
    name: 'fail test',
    nodes: [
      { id: 'step_2', type: 'delegate', task: 't2', maxAttempts: 1 },
    ]
  }

  const mockDispatch = async (params) => {
    throw new Error('Fatal error')
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
    backoffMs: 1
  })

  assert.equal(result.status, 'failed')
  const node = result.nodes.step_2
  assert.equal(node.status, 'failed')

  closeDb(env)
})

test('transitionNode: an explicit claimedBy:null releases the owner so a new scheduler can claim', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const dbCtx = getDb(env)

  // A node left RUNNING by a worker that died.
  upsertWorkflowNode(dbCtx, {
    workflow_id: 'wf-claim',
    step_id: 'step_x',
    status: NODE_STATUS.RUNNING,
    attempt: 1,
    claimed_by: 'dead_worker',
    updated_at: new Date().toISOString(),
  })

  // Resume recovery: running -> ready AND the dead owner must be released.
  // If the owner survives, the owner-aware CAS refuses the next claim and the
  // scheduler spins on the same wave forever.
  transitionNode(dbCtx, {
    workflowId: 'wf-claim',
    stepId: 'step_x',
    to: NODE_STATUS.READY,
    attempt: 1,
    claimedBy: null,
  })
  assert.equal(getWorkflowNode(dbCtx, 'wf-claim', 'step_x').claimed_by, null)

  const claimed = claimNode(dbCtx, {
    workflowId: 'wf-claim',
    stepId: 'step_x',
    claimedBy: 'new_scheduler',
    attempt: 2,
  })
  assert.equal(claimed, true)

  // Omitting claimedBy must keep the existing owner untouched.
  upsertWorkflowNode(dbCtx, {
    workflow_id: 'wf-keep',
    step_id: 'step_y',
    status: NODE_STATUS.RUNNING,
    attempt: 1,
    claimed_by: 'owner_a',
    updated_at: new Date().toISOString(),
  })
  transitionNode(dbCtx, {
    workflowId: 'wf-keep',
    stepId: 'step_y',
    to: NODE_STATUS.READY,
    attempt: 1,
  })
  assert.equal(getWorkflowNode(dbCtx, 'wf-keep', 'step_y').claimed_by, 'owner_a')

  closeDb(env)
})
