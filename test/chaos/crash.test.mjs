import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runWorkflow } from '../../src/workflow/engine.mjs'
import {
  getDb,
  closeDb,
  resetDbInstances,
  upsertWorkflow,
  upsertWorkflowNode,
  getWorkflowNode,
} from '../../src/storage/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-chaos-crash-'))
}

test('crash 1: scheduler killed mid-wave -> resumed with fresh claimedBy completes without re-dispatching succeeded node', async () => {
  const home = makeTempHome()
  const env = { ...process.env, AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-chaos-midwave-kill',
    name: 'scheduler-killed-mid-wave',
    nodes: [
      { id: 'step_first', type: 'delegate', task: 'first node in wave' },
      { id: 'step_running', type: 'delegate', task: 'second node in wave', maxAttempts: 2 },
      { id: 'step_downstream', type: 'delegate', task: 'downstream work', dependsOn: ['step_running'] },
    ],
  }

  let signalInsideRunning
  const insideRunning = new Promise((resolve) => {
    signalInsideRunning = resolve
  })

  // Scheduler 1 runs the wave: step_first completes and writes succeeded to DB,
  // step_running starts and signals, then scheduler 1 stops advancing (simulating process death).
  const scheduler1Dispatches = []
  const scheduler1DispatchFn = async (params) => {
    scheduler1Dispatches.push(params.workflowStep)
    if (params.workflowStep === 'step_first') {
      return { ok: true, step: 'step_first' }
    }
    if (params.workflowStep === 'step_running') {
      const db = getDb(env)
      for (let i = 0; i < 50; i++) {
        const row = getWorkflowNode(db, workflow.id, 'step_first')
        if (row?.status === 'succeeded') break
        await new Promise((r) => setTimeout(r, 10))
      }
      signalInsideRunning()
      return new Promise(() => {}) // stops advancing; step_running left claimed and running
    }
    return { ok: true, step: params.workflowStep }
  }

  runWorkflow({
    workflow,
    env,
    claimedBy: 'dead_scheduler_alpha',
    dispatchFn: scheduler1DispatchFn,
  })

  await insideRunning

  // Verify DB state mid-wave: step_first is succeeded, step_running is running with scheduler 1 claim
  const dbCtx = getDb(env)
  const firstRow = getWorkflowNode(dbCtx, workflow.id, 'step_first')
  assert.equal(firstRow?.status, 'succeeded', 'step_first must have completed before scheduler death')
  const runningRow = getWorkflowNode(dbCtx, workflow.id, 'step_running')
  assert.equal(runningRow?.status, 'running', 'step_running must be left running')
  assert.equal(runningRow?.claimed_by, 'dead_scheduler_alpha')
  closeDb(env)
  resetDbInstances()

  // Scheduler 2 resumes the workflow with a fresh claimedBy
  const scheduler2Dispatches = []
  const scheduler2DispatchFn = async (params) => {
    scheduler2Dispatches.push(params.workflowStep)
    return { ok: true, step: params.workflowStep }
  }

  const result = await runWorkflow({
    workflowId: workflow.id,
    env,
    claimedBy: 'fresh_scheduler_beta',
    dispatchFn: scheduler2DispatchFn,
  })

  assert.equal(result.status, 'succeeded', 'resumed workflow must complete with succeeded status')
  assert.ok(!scheduler2Dispatches.includes('step_first'), 'already-succeeded step_first must not be re-dispatched')
  assert.deepEqual(scheduler2Dispatches, ['step_running', 'step_downstream'], 'only unfinished nodes must be dispatched')
  assert.equal(result.nodes.step_first.status, 'succeeded')
  assert.equal(result.nodes.step_running.status, 'succeeded')
  assert.equal(result.nodes.step_downstream.status, 'succeeded')

  const verifyCtx = getDb(env)
  assert.equal(getWorkflowNode(verifyCtx, workflow.id, 'step_first').status, 'succeeded')
  assert.equal(getWorkflowNode(verifyCtx, workflow.id, 'step_running').status, 'succeeded')
  assert.equal(getWorkflowNode(verifyCtx, workflow.id, 'step_downstream').status, 'succeeded')

  closeDb(env)
  fs.rmSync(home, { recursive: true, force: true })
})

test('crash 2: workflow crash + resume -> expired claim re-adopted exactly once, succeeded nodes not re-run', async () => {
  const home = makeTempHome()
  const env = { ...process.env, AGENT_HUB_HOME: home }
  const dbCtx = getDb(env)

  const workflowId = 'wf-chaos-crash-resume'
  const workflowDef = {
    id: workflowId,
    name: 'workflow-crash-resume',
    nodes: [
      { id: 'node_done_1', type: 'delegate', task: 'already succeeded 1' },
      { id: 'node_done_2', type: 'delegate', task: 'already succeeded 2', dependsOn: ['node_done_1'] },
      { id: 'node_crashed', type: 'delegate', task: 'left running on crash', dependsOn: ['node_done_2'], maxAttempts: 2 },
      { id: 'node_pending', type: 'delegate', task: 'pending after crash', dependsOn: ['node_crashed'] },
    ],
  }

  upsertWorkflow(dbCtx, {
    id: workflowId,
    name: workflowDef.name,
    created_at: new Date(Date.now() - 120_000).toISOString(),
    definition_json: JSON.stringify(workflowDef),
    status: 'running',
    updated_at: new Date(Date.now() - 120_000).toISOString(),
  })

  // Succeeded nodes before crash
  upsertWorkflowNode(dbCtx, {
    workflow_id: workflowId,
    step_id: 'node_done_1',
    status: 'succeeded',
    attempt: 1,
    claimed_by: 'dead_scheduler_proc',
    updated_at: new Date(Date.now() - 100_000).toISOString(),
    result_json: JSON.stringify({ done: 1 }),
  })
  upsertWorkflowNode(dbCtx, {
    workflow_id: workflowId,
    step_id: 'node_done_2',
    status: 'succeeded',
    attempt: 1,
    claimed_by: 'dead_scheduler_proc',
    updated_at: new Date(Date.now() - 80_000).toISOString(),
    result_json: JSON.stringify({ done: 2 }),
  })

  // Crashed node left running with expired claim lease
  upsertWorkflowNode(dbCtx, {
    workflow_id: workflowId,
    step_id: 'node_crashed',
    status: 'running',
    attempt: 1,
    claimed_by: 'dead_scheduler_proc',
    updated_at: new Date(Date.now() - 60_000).toISOString(),
  })

  closeDb(env)
  resetDbInstances()

  const dispatched = []
  const mockDispatch = async (params) => {
    dispatched.push(params.workflowStep)
    return { ok: true, step: params.workflowStep }
  }

  const result = await runWorkflow({
    workflowId,
    env,
    claimedBy: 'resuming_scheduler_gamma',
    leaseTtlMs: 30_000,
    dispatchFn: mockDispatch,
  })

  assert.equal(result.status, 'succeeded', 'workflow must resume and reach succeeded status')
  assert.ok(!dispatched.includes('node_done_1'), 'node_done_1 must not be re-run')
  assert.ok(!dispatched.includes('node_done_2'), 'node_done_2 must not be re-run')
  assert.equal(dispatched.filter((s) => s === 'node_crashed').length, 1, 'crashed node must be re-adopted and dispatched exactly once')
  assert.deepEqual(dispatched, ['node_crashed', 'node_pending'], 'only unfinished and downstream nodes must be dispatched')
  assert.equal(result.nodes.node_done_1.status, 'succeeded')
  assert.equal(result.nodes.node_done_2.status, 'succeeded')
  assert.equal(result.nodes.node_crashed.status, 'succeeded')
  assert.equal(result.nodes.node_pending.status, 'succeeded')

  const verifyCtx = getDb(env)
  assert.equal(getWorkflowNode(verifyCtx, workflowId, 'node_crashed').status, 'succeeded')
  assert.equal(getWorkflowNode(verifyCtx, workflowId, 'node_pending').status, 'succeeded')
  closeDb(env)
  fs.rmSync(home, { recursive: true, force: true })
})

test('crash 3: killed worker -> process dies mid-run, step not re-dispatched twice on resume', async () => {
  const home = makeTempHome()
  const env = { ...process.env, AGENT_HUB_HOME: home }

  const workflow = {
    id: 'wf-chaos-killed-worker',
    name: 'killed-worker-test',
    nodes: [
      { id: 'step_worker', type: 'delegate', task: 'delegated worker job', maxAttempts: 2 },
      { id: 'step_final', type: 'delegate', task: 'downstream after worker', dependsOn: ['step_worker'] },
    ],
  }

  let workerKilledSignal
  const workerKilled = new Promise((resolve) => {
    workerKilledSignal = resolve
  })

  let initialDispatchCount = 0
  const initialDispatchFn = async (params) => {
    if (params.workflowStep === 'step_worker') {
      initialDispatchCount++
      const child = fork(path.join(HERE, '..', 'helpers', 'heartbeat.mjs'))
      const childExit = new Promise((resolve) => child.on('exit', resolve))
      child.kill('SIGKILL')
      await childExit
      workerKilledSignal()
      // Worker died mid-run; execution stops advancing and leaves step running
      return new Promise(() => {})
    }
    return { ok: true }
  }

  runWorkflow({
    workflow,
    env,
    claimedBy: 'worker_scheduler_initial',
    dispatchFn: initialDispatchFn,
  })

  await workerKilled

  // Step was claimed and left in running status when worker process died
  const dbCtx = getDb(env)
  const workerRow = getWorkflowNode(dbCtx, workflow.id, 'step_worker')
  assert.equal(workerRow?.status, 'running')
  assert.equal(workerRow?.claimed_by, 'worker_scheduler_initial')
  closeDb(env)
  resetDbInstances()

  // Workflow resumes: step must be re-adopted and executed, but NOT re-dispatched twice on resume
  const resumeDispatches = []
  const resumeDispatchFn = async (params) => {
    resumeDispatches.push(params.workflowStep)
    return { ok: true, step: params.workflowStep }
  }

  const result = await runWorkflow({
    workflowId: workflow.id,
    env,
    claimedBy: 'resuming_scheduler_alpha',
    dispatchFn: resumeDispatchFn,
  })

  assert.equal(initialDispatchCount, 1, 'initial run dispatched step once before worker died')
  const workerResumeDispatches = resumeDispatches.filter((s) => s === 'step_worker')
  assert.equal(workerResumeDispatches.length, 1, 'step must not be re-dispatched twice when workflow resumes')
  assert.deepEqual(resumeDispatches, ['step_worker', 'step_final'])
  assert.equal(result.status, 'succeeded')

  const verifyCtx = getDb(env)
  assert.equal(getWorkflowNode(verifyCtx, workflow.id, 'step_worker').status, 'succeeded')
  assert.equal(getWorkflowNode(verifyCtx, workflow.id, 'step_final').status, 'succeeded')
  closeDb(env)
  fs.rmSync(home, { recursive: true, force: true })
})
