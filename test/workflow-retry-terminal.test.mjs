import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDb, closeDb, getWorkflowNode, upsertWorkflowNode } from '../src/storage/index.mjs'
import { runWorkflow } from '../src/workflow/engine.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-retry-terminal-'))
}

function handle(jobId) {
  return { jobId, abort: async () => {} }
}

test('T1: a node whose wait times out is retried instead of throwing an illegal waiting -> ready transition', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-wait-timeout',
    name: 'wait timeout',
    nodes: [{ id: 'waiting_step', type: 'delegate', task: 't', maxAttempts: 3 }],
  }

  let waitCalls = 0
  const dispatchFn = async () => handle('job-1')
  const waitExecutionFn = async () => {
    waitCalls++
    if (waitCalls === 1) return { waiting: true, reason: 'external_event' }
    return { status: 'succeeded', record: { ok: true, via: 'retry' } }
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn,
    waitExecutionFn,
    waitingTimeoutS: 1,
    pollIntervalMs: 10,
    backoffMs: 1,
    readResultFn: () => ({ status: 'succeeded' }),
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(result.nodes.waiting_step.status, 'succeeded')
  assert.equal(waitCalls, 2)
  closeDb(env)
})

test('T1: a node canceled while waiting finalizes as canceled, without retrying and without throwing', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-wait-cancel',
    name: 'wait cancel',
    nodes: [{ id: 'waiting_step', type: 'delegate', task: 't', maxAttempts: 3 }],
  }

  const dbCtx = getDb(env)
  let dispatchCalls = 0
  const dispatchFn = async () => {
    dispatchCalls++
    return handle('job-2')
  }
  // The cancel lands while the node is parked in WAITING.
  const onWaiting = async ({ workflowId, stepId }) => {
    upsertWorkflowNode(dbCtx, {
      workflow_id: workflowId,
      step_id: stepId,
      status: 'canceled',
      attempt: 1,
      claimed_by: null,
      updated_at: new Date().toISOString(),
    })
  }
  const waitExecutionFn = async () => ({ waiting: true, reason: 'external_event' })

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn,
    waitExecutionFn,
    onWaiting,
    waitingTimeoutS: 30,
    pollIntervalMs: 10,
    backoffMs: 1,
    readResultFn: () => ({ status: 'succeeded' }),
  })

  assert.equal(result.nodes.waiting_step.status, 'canceled')
  assert.equal(getWorkflowNode(dbCtx, workflow.id, 'waiting_step').status, 'canceled')
  assert.equal(dispatchCalls, 1, 'a canceled job must never be re-dispatched')
  closeDb(env)
})
