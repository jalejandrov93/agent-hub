import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDb, closeDb, getWorkflowNode, upsertWorkflowNode } from '../src/storage/index.mjs'
import { runWorkflow, claimNode, transitionNode } from '../src/workflow/engine.mjs'
import { NODE_STATUS } from '../src/workflow/state.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-c11-engine-'))
}

test('C1.1 dispatch pendiente → el nodo NO avanza hasta done', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  let releaseWait
  const gate = new Promise((resolve) => { releaseWait = resolve })
  let dispatchCalls = 0

  const dispatchFn = async (params) => ({
    jobId: `job-${params.workflowStep}`,
    sessionId: null,
    _aborted: false,
    abortCalls: 0,
    async abort() { this.abortCalls++; this._aborted = true; return { stoppedWaiting: true, remoteContinuing: false } },
  })
  const waitExecutionFn = async () => {
    await gate // pendiente hasta que el test libere
    return { done: true, status: 'succeeded', record: { jobId: 'job-step1', status: 'succeeded' } }
  }

  const workflow = {
    id: 'wf-c11-pending',
    name: 'pending test',
    nodes: [{ id: 'step1', type: 'delegate', task: 'work', maxAttempts: 1 }],
  }

  const runPromise = runWorkflow({
    workflow,
    env,
    dispatchFn: async (p) => { dispatchCalls++; return dispatchFn(p) },
    waitExecutionFn,
    pollIntervalMs: 5,
  })

  // Mientras el handle sigue pendiente, el nodo debe seguir en running (jamás succeeded)
  await new Promise((r) => setTimeout(r, 80))
  const dbCtx = getDb(env)
  const midRow = getWorkflowNode(dbCtx, 'wf-c11-pending', 'step1')
  assert.equal(midRow.status, NODE_STATUS.RUNNING, 'nodo pendiente no debe marcar succeeded')
  assert.equal(dispatchCalls, 1)

  releaseWait()
  const result = await runPromise
  assert.equal(result.status, 'succeeded')
  assert.equal(result.nodes.step1.status, NODE_STATUS.SUCCEEDED)
  closeDb(env)
})

test('C1.1 WAITING persiste + scheduler reanuda sin duplicar dispatch', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  let dispatchCalls = 0
  let waitCalls = 0
  let waitingSeen = null

  const dispatchFn = async (params) => {
    dispatchCalls++
    return { jobId: 'job-wait-1', sessionId: null, _aborted: false, async abort() { return { stoppedWaiting: true } } }
  }
  const waitExecutionFn = async () => {
    waitCalls++
    if (waitCalls === 1) {
      return { done: true, waiting: true, status: 'waiting', reason: 'plan_approval', record: { jobId: 'job-wait-1', status: 'running' }, remoteState: 'AWAITING_PLAN_APPROVAL' }
    }
    return { done: true, status: 'succeeded', record: { jobId: 'job-wait-1', status: 'succeeded' } }
  }

  const workflow = {
    id: 'wf-c11-waiting',
    name: 'waiting test',
    nodes: [{ id: 'step1', type: 'delegate', task: 'work', maxAttempts: 1 }],
  }

  const runPromise = runWorkflow({
    workflow,
    env,
    dispatchFn,
    waitExecutionFn,
    pollIntervalMs: 5,
    waitingTimeoutS: 30,
    onWaiting: async ({ stepId, reason }) => { waitingSeen = { stepId, reason } },
  })

  // Esperar a que el nodo entre en WAITING en DB
  const dbCtx = getDb(env)
  let sawWaiting = false
  for (let i = 0; i < 200; i++) {
    const row = getWorkflowNode(dbCtx, 'wf-c11-waiting', 'step1')
    if (row?.status === NODE_STATUS.WAITING) { sawWaiting = true; break }
    await new Promise((r) => setTimeout(r, 10))
  }
  assert.ok(sawWaiting, 'executeNode debe persistir WAITING')
  assert.equal(waitingSeen?.reason, 'plan_approval')

  // Reanudación externa waiting → running (sin re-dispatch)
  transitionNode(dbCtx, {
    workflowId: 'wf-c11-waiting',
    stepId: 'step1',
    from: NODE_STATUS.WAITING,
    to: NODE_STATUS.RUNNING,
  })

  const result = await runPromise
  assert.equal(result.status, 'succeeded')
  assert.equal(dispatchCalls, 1, 'sin duplicar dispatch tras reanudar')
  assert.equal(result.nodes.step1.status, NODE_STATUS.SUCCEEDED)
  closeDb(env)
})

test('C1.1 timeout → abort → confirm → retry attempt+1 (abort registrado)', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const aborts = []
  const attempts = []
  let n = 0

  const dispatchFn = async (params) => {
    attempts.push(params.attempt)
    return {
      jobId: `job-t-${params.attempt}`,
      _aborted: false,
      async abort() { aborts.push(params.attempt); this._aborted = true; return { canceled: true } },
    }
  }
  const waitExecutionFn = async () => {
    n++
    if (n === 1) return { done: false, timedOut: true, record: { jobId: 'job-t-1', status: 'running' } }
    return { done: true, status: 'succeeded', record: { jobId: 'job-t-2', status: 'succeeded' } }
  }

  const workflow = {
    id: 'wf-c11-abort',
    name: 'abort test',
    nodes: [{ id: 'step1', type: 'delegate', task: 'work', maxAttempts: 2, timeoutS: 5 }],
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn,
    waitExecutionFn,
    backoffMs: 1,
    pollIntervalMs: 5,
    readResultFn: () => ({ jobId: 'job-t-1', status: 'running' }),
  })

  assert.equal(result.status, 'succeeded')
  assert.deepEqual(aborts, [1], 'abort registrado en el intento con timeout')
  assert.deepEqual(attempts, [1, 2], 'retry con attempt+1')
  assert.equal(result.nodes.step1.attempt, 2)
  closeDb(env)
})

test('C1.1 claimNode única vía ready→running; transitionNode valida el resto', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const ctx = getDb(env)
  const now = new Date().toISOString()
  upsertWorkflowNode(ctx, { workflow_id: 'wf-c11-claim', step_id: 'n1', status: NODE_STATUS.READY, attempt: 0, updated_at: now, claimed_by: null })

  assert.equal(claimNode(ctx, { workflowId: 'wf-c11-claim', stepId: 'n1', claimedBy: 'A', attempt: 1 }), true)
  assert.equal(claimNode(ctx, { workflowId: 'wf-c11-claim', stepId: 'n1', claimedBy: 'B', attempt: 2 }), false)

  assert.throws(
    () => transitionNode(ctx, { workflowId: 'wf-c11-claim', stepId: 'n1', from: 'running', to: 'pending' }),
    /Invalid node state transition/
  )
  // Matriz WAITING
  transitionNode(ctx, { workflowId: 'wf-c11-claim', stepId: 'n1', from: 'running', to: 'waiting', claimedBy: 'A' })
  assert.equal(getWorkflowNode(ctx, 'wf-c11-claim', 'n1').status, 'waiting')
  transitionNode(ctx, { workflowId: 'wf-c11-claim', stepId: 'n1', from: 'waiting', to: 'running', claimedBy: 'A' })
  assert.equal(getWorkflowNode(ctx, 'wf-c11-claim', 'n1').status, 'running')
  transitionNode(ctx, { workflowId: 'wf-c11-claim', stepId: 'n1', from: 'running', to: 'canceled', claimedBy: 'A' })
  assert.equal(getWorkflowNode(ctx, 'wf-c11-claim', 'n1').status, 'canceled')
  closeDb(env)
})

test('C1.1 anti-robo: resume con dueño vivo y lease fresca NO re-ejecuta', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const workflow = {
    id: 'wf-c11-nosteal',
    name: 'no steal test',
    nodes: [
      { id: 'a', type: 'delegate', task: 'a' },
      { id: 'b', type: 'delegate', task: 'b', dependsOn: ['a'] },
    ],
  }
  const noopDispatch = async () => ({ ok: true })
  await runWorkflow({ workflow, env, dispatchFn: noopDispatch })

  // Simular crash dejando 'b' en ready y 'a' succeeded; luego un dueño vivo
  // reclama 'b' (running, lease fresca). Resume con probe vivo → re-adopta.
  const ctx = getDb(env)
  upsertWorkflowNode(ctx, {
    workflow_id: 'wf-c11-nosteal',
    step_id: 'b',
    status: 'running',
    attempt: 1,
    claimed_by: 'live-owner',
    updated_at: new Date().toISOString(),
  })
  closeDb(env)

  const dispatched = []
  const runPromise = runWorkflow({
    workflowId: 'wf-c11-nosteal',
    env,
    dispatchFn: async (p) => { dispatched.push(p.workflowStep); return { ok: true } },
    claimedBy: 'new-scheduler',
    isOwnerAlive: () => true, // dueño vivo
    leaseTtlMs: 60_000,
    pollIntervalMs: 5,
  })
  // El scheduler ve 'b' running de un dueño vivo: espera sin reclamar.
  await new Promise((r) => setTimeout(r, 200))
  assert.ok(!dispatched.includes('b'), `dueño vivo: b no se re-ejecuta (visto: ${JSON.stringify(dispatched)})`)
  assert.ok(!dispatched.includes('a'), 'a ya estaba succeeded')
  // El dueño vivo termina 'b'; el scheduler lo observa y cierra sin haberlo ejecutado.
  const ctx2 = getDb(env)
  transitionNode(ctx2, { workflowId: 'wf-c11-nosteal', stepId: 'b', from: 'running', to: 'succeeded' })
  const result = await runPromise
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(dispatched, [], 'nadie re-ejecutó nada')
  closeDb(env)
})

test('C1.1 regresión live: record queued sin handle espera al terminal real, no marca succeeded', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { createJob, updateResult } = await import('../src/jobstore.mjs')
  // Job real en queued, como lo devuelve startRemoteJob al crear la sesión.
  const job = createJob({ agent: 'jules', model: 'jules', task: 't', cwd: null, title: 't', mode: 'write', env })
  let reads = 0
  const dispatchFn = async () => ({ ...job })

  const workflow = {
    id: 'wf-c11-bare-record',
    name: 'bare record test',
    nodes: [{ id: 'step1', type: 'delegate', task: 'work', maxAttempts: 1, timeoutS: 30 }],
  }

  const { readResult } = await import('../src/jobstore.mjs')
  const runPromise = runWorkflow({
    workflow,
    env,
    dispatchFn,
    readResultFn: (id) => { reads++; return readResult(id, env) },
    pollIntervalMs: 5,
  })

  // Mientras sigue queued, el nodo no puede estar succeeded.
  await new Promise((r) => setTimeout(r, 80))
  const dbCtx = getDb(env)
  const midRow = getWorkflowNode(dbCtx, 'wf-c11-bare-record', 'step1')
  assert.notEqual(midRow.status, NODE_STATUS.SUCCEEDED, 'record queued no debe marcar succeeded')
  assert.ok(reads > 1, 'el engine debe estar observando el record, no dando por hecho el resultado')

  updateResult(job.jobId, { status: 'succeeded' }, env)
  const result = await runPromise
  assert.equal(result.status, 'succeeded')
  assert.equal(result.nodes.step1.status, NODE_STATUS.SUCCEEDED)
  closeDb(env)
})
