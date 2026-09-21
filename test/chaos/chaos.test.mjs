import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dispatch } from '../../src/dispatch.mjs'
import { runWorkflow, transitionNode } from '../../src/workflow/engine.mjs'
import { createJob, readResult } from '../../src/jobstore.mjs'
import {
  getDb,
  closeDb,
  resetDbInstances,
  upsertWorkflow,
  upsertWorkflowNode,
  getWorkflowNode,
  getJob
} from '../../src/storage/index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-chaos-'))
}

test('chaos 1: duplicate dispatch -> exactly one startJobFn call and both callers observe same jobId', async () => {
  const home = makeTempHome()
  const env = { ...process.env, AGENT_HUB_HOME: home }

  let startJobCalls = 0
  let releaseStartJob
  const startJobGate = new Promise((resolve) => {
    releaseStartJob = resolve
  })

  let signalInsideStartJob
  const insideStartJob = new Promise((resolve) => {
    signalInsideStartJob = resolve
  })

  const mockStartJob = async (args) => {
    startJobCalls++
    signalInsideStartJob()
    await startJobGate
    const job = {
      jobId: `job-chaos-dup-${startJobCalls}`,
      agent: args.agent,
      model: args.model,
      status: 'queued',
      createdAt: new Date().toISOString(),
      dispatchKey: args.dispatchKey,
      executionId: args.executionId
    }
    return { job, done: Promise.resolve() }
  }

  const dispatchParams = {
    task: 'chaos duplicate dispatch test',
    taskType: 'recon',
    cwd: '/tmp/chaos-dispatch-cwd',
    mode: 'read',
    dispatchKey: 'chaos-dup-key-1',
    env,
    startJobFn: mockStartJob,
    routeFn: async () => ({ primary: { agent: 'agy', model: 'gemini-3.8-flash-low' }, fallbacks: [] }),
    runPreflightFn: async () => ({ status: 'ready' }),
    circuitBreakerOpenFn: () => false
  }

  const p1 = dispatch(dispatchParams)
  await insideStartJob
  const p2 = dispatch(dispatchParams)

  releaseStartJob()

  const [res1, res2] = await Promise.all([p1, p2])

  assert.equal(startJobCalls, 1, 'startJobFn must be called exactly once despite concurrent dispatches')
  assert.equal(res1.jobId, res2.jobId, 'both concurrent callers must observe the identical jobId')
  assert.equal(res1.jobId, 'job-chaos-dup-1', 'observed jobId must match the single created job')

  fs.rmSync(home, { recursive: true, force: true })
})

test('chaos 2: workflow resume after crash -> node re-adopted and dispatched exactly once', async () => {
  const home = makeTempHome()
  const env = { ...process.env, AGENT_HUB_HOME: home }
  const dbCtx = getDb(env)

  const workflowId = 'wf-chaos-resume'
  const workflowDef = {
    id: workflowId,
    name: 'chaos-crash-recovery',
    nodes: [
      { id: 'step_init', type: 'delegate', task: 'initial setup' },
      { id: 'step_crashed', type: 'delegate', task: 'work that crashed mid-flight', dependsOn: ['step_init'], maxAttempts: 2 }
    ]
  }

  upsertWorkflow(dbCtx, {
    id: workflowId,
    name: workflowDef.name,
    created_at: new Date(Date.now() - 60_000).toISOString(),
    definition_json: JSON.stringify(workflowDef),
    status: 'running',
    updated_at: new Date(Date.now() - 60_000).toISOString()
  })

  // step_init completed before crash
  upsertWorkflowNode(dbCtx, {
    workflow_id: workflowId,
    step_id: 'step_init',
    status: 'succeeded',
    attempt: 1,
    claimed_by: 'dead_scheduler_process_1',
    updated_at: new Date(Date.now() - 50_000).toISOString(),
    result_json: JSON.stringify({ done: true })
  })

  // step_crashed was left in 'running' status when the process crashed
  upsertWorkflowNode(dbCtx, {
    workflow_id: workflowId,
    step_id: 'step_crashed',
    status: 'running',
    attempt: 1,
    claimed_by: 'dead_scheduler_process_1',
    updated_at: new Date(Date.now() - 40_000).toISOString()
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
    dispatchFn: mockDispatch
  })

  assert.equal(result.status, 'succeeded', 'resumed workflow must complete with succeeded status')
  assert.deepEqual(dispatched, ['step_crashed'], 'only uncompleted crashed node must be dispatched')
  assert.equal(result.nodes.step_init.status, 'succeeded')
  assert.equal(result.nodes.step_crashed.status, 'succeeded')

  const verifyCtx = getDb(env)
  const crashedNodeRow = getWorkflowNode(verifyCtx, workflowId, 'step_crashed')
  assert.equal(crashedNodeRow.status, 'succeeded')
  closeDb(env)
  fs.rmSync(home, { recursive: true, force: true })
})

test('chaos 3: expired node claim -> dead owner with expired lease is reclaimed, while live owner is not stolen', async () => {
  const home = makeTempHome()
  const env = { ...process.env, AGENT_HUB_HOME: home }
  const dbCtx = getDb(env)

  const isOwnerAlive = (owner) => owner === 'active_live_worker'

  // Part A: Dead owner with expired claim lease -> reclaimable
  const deadWfId = 'wf-chaos-dead-claim'
  const deadWfDef = {
    id: deadWfId,
    name: 'dead-claim-recovery',
    nodes: [
      { id: 'node_dead', type: 'delegate', task: 'reclaim dead node', maxAttempts: 2 }
    ]
  }

  upsertWorkflow(dbCtx, {
    id: deadWfId,
    name: deadWfDef.name,
    created_at: new Date(Date.now() - 100_000).toISOString(),
    definition_json: JSON.stringify(deadWfDef),
    status: 'running',
    updated_at: new Date(Date.now() - 100_000).toISOString()
  })

  upsertWorkflowNode(dbCtx, {
    workflow_id: deadWfId,
    step_id: 'node_dead',
    status: 'running',
    attempt: 1,
    claimed_by: 'dead_worker_999',
    updated_at: new Date(Date.now() - 5000).toISOString()
  })

  const deadDispatches = []
  const resultDead = await runWorkflow({
    workflowId: deadWfId,
    env,
    claimedBy: 'new_scheduler_alpha',
    leaseTtlMs: 500,
    isOwnerAlive,
    dispatchFn: async (params) => {
      deadDispatches.push(params.workflowStep)
      return { reclaimed: true }
    }
  })

  assert.equal(resultDead.status, 'succeeded')
  assert.deepEqual(deadDispatches, ['node_dead'], 'dead owner node with expired lease must be reclaimed and dispatched')
  const deadRow = getWorkflowNode(dbCtx, deadWfId, 'node_dead')
  assert.equal(deadRow.status, 'succeeded')

  // Part B: LIVE owner -> claim is protected and NOT stolen by a new scheduler
  const liveWfId = 'wf-chaos-live-claim'
  const liveWfDef = {
    id: liveWfId,
    name: 'live-claim-protection',
    nodes: [
      { id: 'node_live', type: 'delegate', task: 'live node', maxAttempts: 2 }
    ]
  }

  upsertWorkflow(dbCtx, {
    id: liveWfId,
    name: liveWfDef.name,
    created_at: new Date(Date.now() - 100_000).toISOString(),
    definition_json: JSON.stringify(liveWfDef),
    status: 'running',
    updated_at: new Date(Date.now() - 100_000).toISOString()
  })

  upsertWorkflowNode(dbCtx, {
    workflow_id: liveWfId,
    step_id: 'node_live',
    status: 'running',
    attempt: 1,
    claimed_by: 'active_live_worker',
    updated_at: new Date(Date.now() - 5000).toISOString()
  })

  const rivalDispatches = []
  const rivalScheduler = runWorkflow({
    workflowId: liveWfId,
    env,
    claimedBy: 'rival_scheduler_beta',
    leaseTtlMs: 500,
    pollIntervalMs: 10,
    isOwnerAlive,
    dispatchFn: async (params) => {
      rivalDispatches.push(params.workflowStep)
      return { ok: true }
    }
  })

  let nodeLiveRow = getWorkflowNode(dbCtx, liveWfId, 'node_live')
  assert.equal(nodeLiveRow.claimed_by, 'active_live_worker', 'claim must remain with active_live_worker')
  assert.equal(nodeLiveRow.status, 'running', 'status must remain running while owner is alive')

  // Active live worker completes its work
  transitionNode(dbCtx, {
    workflowId: liveWfId,
    stepId: 'node_live',
    from: 'running',
    to: 'succeeded',
    claimedBy: 'active_live_worker',
    resultJson: JSON.stringify({ completedBy: 'active_live_worker' })
  })

  const resultLive = await rivalScheduler
  assert.equal(resultLive.status, 'succeeded')
  assert.equal(rivalDispatches.length, 0, 'rival scheduler must not have stolen or dispatched the live node')

  nodeLiveRow = getWorkflowNode(dbCtx, liveWfId, 'node_live')
  assert.equal(nodeLiveRow.claimed_by, 'active_live_worker', 'claim was never overwritten')
  assert.equal(nodeLiveRow.status, 'succeeded')

  closeDb(env)
  fs.rmSync(home, { recursive: true, force: true })
})

test('chaos 4: sqlite contention -> concurrent child updateResult calls produce no lost update', async () => {
  const home = makeTempHome()
  const env = { ...process.env, AGENT_HUB_HOME: home }

  const job = createJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'contention test',
    cwd: home,
    env
  })

  const helperPath = path.join(HERE, '..', 'helpers', 'chaos-updater.mjs')
  const updatesPerWorker = 20

  const runWorker = (tag) =>
    new Promise((resolve, reject) => {
      const child = fork(helperPath, [job.jobId, tag, String(updatesPerWorker)], {
        env,
        stdio: 'inherit'
      })
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`worker ${tag} timed out`))
      }, 30_000)
      child.on('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(code)
        else reject(new Error(`worker ${tag} exited with code ${code}`))
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })

  await Promise.all([runWorker('worker_A'), runWorker('worker_B')])

  const finalRecord = readResult(job.jobId, env)
  assert.ok(Array.isArray(finalRecord.updates), 'updates array must exist')
  assert.equal(finalRecord.updates.length, updatesPerWorker * 2, 'all updates must be preserved without lost update')
  assert.equal(finalRecord.worker_A_count, updatesPerWorker, 'all worker_A updates recorded')
  assert.equal(finalRecord.worker_B_count, updatesPerWorker, 'all worker_B updates recorded')

  const dbCtx = getDb(env)
  const dbRow = getJob(dbCtx, job.jobId)
  assert.ok(dbRow, 'job exists in SQLite')
  const dbData = typeof dbRow.result_json === 'string' ? JSON.parse(dbRow.result_json) : dbRow.result_json
  assert.equal(dbData.updates.length, updatesPerWorker * 2, 'SQLite mirrored state must also have all updates')

  closeDb(env)
  fs.rmSync(home, { recursive: true, force: true })
})
