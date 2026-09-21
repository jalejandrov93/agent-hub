import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  getDb,
  closeDb,
  resetDbInstances,
  upsertWorkflowNode,
  getWorkflowNode,
  listWorkflowNodes,
  getWorkflow,
} from '../src/storage/index.mjs'
import { readTail } from '../src/eventlog.mjs'
import { runWorkflow } from '../src/workflow/engine.mjs'
import { softwarePipelineWorkflow } from '../examples/software-pipeline.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-wf-engine-'))
}

test('engine: executes real example workflow (research -> implementation -> review)', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const dispatchedSteps = []

  const mockDispatch = async (params) => {
    dispatchedSteps.push(params.workflowStep)
    return {
      success: true,
      stepId: params.workflowStep,
      output: `Completed ${params.workflowStep}`,
    }
  }

  const result = await runWorkflow({
    workflow: softwarePipelineWorkflow,
    env,
    dispatchFn: mockDispatch,
  })

  assert.equal(result.status, 'succeeded')
  assert.deepEqual(dispatchedSteps, ['research', 'implementation', 'review'])

  const dbCtx = getDb(env)
  const nodes = listWorkflowNodes(dbCtx, softwarePipelineWorkflow.id)
  assert.equal(nodes.length, 3)
  for (const n of nodes) {
    assert.equal(n.status, 'succeeded')
  }

  const events = readTail({ n: 20, env })
  const kinds = events.map((e) => e.kind)
  assert.ok(kinds.includes('job.started'))
  assert.ok(kinds.includes('job.finished'))

  closeDb(env)
})

test('engine: fan-out generates N children with distinct workflowStep and fan-in aggregates', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const childStepsDispatched = []

  const workflow = {
    id: 'wf-fan',
    name: 'fanout-fanin test',
    nodes: [
      {
        id: 'distribute',
        type: 'fanout',
        items: ['task_alpha', 'task_beta', 'task_gamma'],
      },
      {
        id: 'collect',
        type: 'fanin',
        dependsOn: ['distribute'],
      },
    ],
  }

  const mockDispatch = async (params) => {
    childStepsDispatched.push(params.workflowStep)
    return { itemDone: params.workflowStep }
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
  })

  assert.equal(result.status, 'succeeded')
  // 3 distinct child steps dispatched with distinct workflowStep
  assert.equal(childStepsDispatched.length, 3)
  assert.deepEqual(childStepsDispatched, ['distribute_0', 'distribute_1', 'distribute_2'])

  // Check fanin aggregated result
  const faninResult = result.nodes.collect?.result
  assert.ok(faninResult)
  assert.ok(faninResult.aggregated.distribute)
  assert.equal(faninResult.aggregated.distribute.count, 3)

  closeDb(env)
})

test('engine: retry exhausts maxAttempts and marks node failed', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  let attemptsSeen = 0

  const workflow = {
    id: 'wf-retry-fail',
    name: 'retry exhaust test',
    nodes: [
      {
        id: 'unstable_step',
        type: 'delegate',
        task: 'flaky task',
        maxAttempts: 3,
      },
    ],
  }

  const mockDispatch = async (params) => {
    attemptsSeen++
    throw new Error(`Failure on attempt ${params.attempt}`)
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
    backoffMs: 5,
  })

  assert.equal(result.status, 'failed')
  assert.equal(attemptsSeen, 3)
  assert.equal(result.nodes.unstable_step.status, 'failed')
  assert.equal(result.nodes.unstable_step.attempt, 3)

  const dbCtx = getDb(env)
  const nodeRow = getWorkflowNode(dbCtx, 'wf-retry-fail', 'unstable_step')
  assert.equal(nodeRow.status, 'failed')
  assert.equal(nodeRow.attempt, 3)

  const events = readTail({ n: 10, env })
  const failedEvent = events.find((e) => e.kind === 'job.failed')
  assert.ok(failedEvent)
  assert.match(failedEvent.summary, /Failure on attempt 3/)

  closeDb(env)
})

test('engine: retry succeeds on subsequent attempt before maxAttempts', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  let callCount = 0

  const workflow = {
    id: 'wf-retry-ok',
    name: 'retry succeed test',
    nodes: [
      {
        id: 'eventual_step',
        type: 'delegate',
        task: 'eventual task',
        maxAttempts: 3,
      },
    ],
  }

  const mockDispatch = async (params) => {
    callCount++
    if (callCount < 2) {
      throw new Error('Transient network error')
    }
    return { ok: true, attempt: params.attempt }
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
    backoffMs: 5,
  })

  assert.equal(result.status, 'succeeded')
  assert.equal(callCount, 2)
  assert.equal(result.nodes.eventual_step.status, 'succeeded')
  assert.equal(result.nodes.eventual_step.attempt, 2)

  closeDb(env)
})

test('engine: resume after restart does not re-execute succeeded nodes', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const firstRunDispatches = []

  const workflow = {
    id: 'wf-resume',
    name: 'resume test',
    nodes: [
      { id: 'prep', type: 'delegate', task: 'prep' },
      { id: 'work', type: 'delegate', task: 'work', dependsOn: ['prep'] },
    ],
  }

  // 1. First run: process executes 'prep' successfully, then simulates sudden crash / shutdown
  const abortController = new AbortController()
  const mockDispatch1 = async (params) => {
    firstRunDispatches.push(params.workflowStep)
    if (params.workflowStep === 'prep') {
      return { done: 'prep' }
    }
    // Simulate process killed while 'work' was starting
    throw new Error('Process killed by SIGKILL')
  }

  // Run initial workflow - prep succeeds, work is interrupted/failed
  await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch1,
  })

  assert.deepEqual(firstRunDispatches, ['prep', 'work'])

  // Check DB state: prep is succeeded in SQLite
  const dbCtx = getDb(env)
  const prepRow = getWorkflowNode(dbCtx, 'wf-resume', 'prep')
  assert.equal(prepRow.status, 'succeeded')

  // Simulate work left running after a crash. The lease is aged past the
  // claim TTL: that is what marks the owner dead, and the scheduler must not
  // steal a node whose lease is still fresh (a live peer), so a fresh
  // timestamp would (correctly) be left alone.
  upsertWorkflowNode(dbCtx, {
    workflow_id: 'wf-resume',
    step_id: 'work',
    status: 'running',
    attempt: 0,
    claimed_by: 'old_dead_worker',
    updated_at: new Date(Date.now() - 10 * 60_000).toISOString(),
  })

  // 2. Simulate process restart: close DB handles, reset singletons
  closeDb(env)
  resetDbInstances()

  // 3. Resume run using only workflowId
  const resumedDispatches = []
  const mockDispatch2 = async (params) => {
    resumedDispatches.push(params.workflowStep)
    return { done: params.workflowStep }
  }

  const resumeResult = await runWorkflow({
    workflowId: 'wf-resume',
    env,
    dispatchFn: mockDispatch2,
  })

  assert.equal(resumeResult.status, 'succeeded')
  // CRITICAL: prep was ALREADY succeeded, so it must NOT be re-executed!
  assert.deepEqual(resumedDispatches, ['work'])
  assert.equal(resumeResult.nodes.prep.status, 'succeeded')
  assert.equal(resumeResult.nodes.work.status, 'succeeded')

  closeDb(env)
})

test('engine: double scheduler on same workflow does not duplicate node executions (CAS claim)', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const executedCalls = []

  const workflow = {
    id: 'wf-race',
    name: 'race condition test',
    nodes: [
      { id: 'shared_node_1', type: 'delegate', task: 'task 1' },
      { id: 'shared_node_2', type: 'delegate', task: 'task 2', dependsOn: ['shared_node_1'] },
    ],
  }

  const mockDispatch = async (params) => {
    // Add small async jitter to simulate concurrency
    await new Promise((r) => setTimeout(r, 10))
    executedCalls.push({ step: params.workflowStep, attempt: params.attempt })
    return { step: params.workflowStep }
  }

  // Two schedulers running simultaneously on the same workflow
  const scheduler1 = runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
    claimedBy: 'scheduler_ALPHA',
  })

  const scheduler2 = runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
    claimedBy: 'scheduler_BETA',
  })

  const [res1, res2] = await Promise.all([scheduler1, scheduler2])

  assert.equal(res1.status, 'succeeded')
  assert.equal(res2.status, 'succeeded')

  // Each node must have been executed EXACTLY ONCE
  const step1Execs = executedCalls.filter((c) => c.step === 'shared_node_1')
  const step2Execs = executedCalls.filter((c) => c.step === 'shared_node_2')

  assert.equal(step1Execs.length, 1, 'shared_node_1 must execute exactly once across schedulers')
  assert.equal(step2Execs.length, 1, 'shared_node_2 must execute exactly once across schedulers')

  closeDb(env)
})

test('engine: timeout per node enforces deadline and fails attempt', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-timeout',
    name: 'timeout test',
    nodes: [
      {
        id: 'slow_step',
        type: 'delegate',
        task: 'slow task',
        timeoutS: 0.05, // 50ms timeout
        maxAttempts: 1,
      },
    ],
  }

  const mockDispatch = async () => {
    // Hangs for 200ms
    await new Promise((r) => setTimeout(r, 200))
    return { ok: true }
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn: mockDispatch,
  })

  assert.equal(result.status, 'failed')
  assert.equal(result.nodes.slow_step.status, 'failed')
  assert.match(result.nodes.slow_step.error.message, /timed out after 0.05s/)

  closeDb(env)
})
