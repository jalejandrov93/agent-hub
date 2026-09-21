import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { closeDb } from '../src/storage/index.mjs'
import { readTail } from '../src/eventlog.mjs'
import { runWorkflow } from '../src/workflow/engine.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-wf-completed-'))
}

test('runWorkflow emits exactly one workflow.completed event with status succeeded and correct counts', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-completed-success',
    name: '2-node delegate workflow',
    nodes: [
      { id: 'step_1', type: 'delegate', task: 'Task 1' },
      { id: 'step_2', type: 'delegate', task: 'Task 2', dependsOn: ['step_1'] },
    ],
  }

  const mockDispatch = async (params) => ({
    success: true,
    stepId: params.workflowStep,
  })

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
  })

  assert.equal(result.status, 'succeeded')

  const events = readTail({ n: 50, env })
  const completedEvents = events.filter((e) => e.kind === 'workflow.completed')

  assert.equal(completedEvents.length, 1)
  const event = completedEvents[0]
  assert.equal(event.status, 'succeeded')
  assert.equal(event.workflow_id, 'wf-completed-success')
  assert.deepEqual(event.counts, {
    total: 2,
    succeeded: 2,
    failed: 0,
    skipped: 0,
    canceled: 0,
  })

  closeDb(env)
})

test('runWorkflow resume for already-completed workflowId does not add a second workflow.completed event', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-completed-resume',
    name: '2-node delegate workflow for resume',
    nodes: [
      { id: 'step_1', type: 'delegate', task: 'Task 1' },
      { id: 'step_2', type: 'delegate', task: 'Task 2', dependsOn: ['step_1'] },
    ],
  }

  const mockDispatch = async (params) => ({
    success: true,
    stepId: params.workflowStep,
  })

  await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
  })

  const eventsFirstRun = readTail({ n: 50, env })
  const completedFirstRun = eventsFirstRun.filter((e) => e.kind === 'workflow.completed')
  assert.equal(completedFirstRun.length, 1)

  // Call runWorkflow again for the same workflowId (resume of a completed workflow)
  await runWorkflow({
    workflowId: workflow.id,
    env,
    dispatchFn: mockDispatch,
  })

  const eventsSecondRun = readTail({ n: 50, env })
  const completedSecondRun = eventsSecondRun.filter((e) => e.kind === 'workflow.completed')
  assert.equal(completedSecondRun.length, 1)

  closeDb(env)
})

test('runWorkflow emits workflow.completed event with status failed when a node fails', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-completed-failed',
    name: 'failing workflow',
    nodes: [
      { id: 'step_fail', type: 'delegate', task: 'Failing task', maxAttempts: 1 },
    ],
  }

  const mockDispatch = async () => {
    throw new Error('Dispatched node failed')
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
    backoffMs: 5,
  })

  assert.equal(result.status, 'failed')

  const events = readTail({ n: 50, env })
  const completedEvents = events.filter((e) => e.kind === 'workflow.completed')

  assert.equal(completedEvents.length, 1)
  const event = completedEvents[0]
  assert.equal(event.status, 'failed')
  assert.equal(event.workflow_id, 'wf-completed-failed')
  assert.deepEqual(event.counts, {
    total: 1,
    succeeded: 0,
    failed: 1,
    skipped: 0,
    canceled: 0,
  })

  closeDb(env)
})
