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
