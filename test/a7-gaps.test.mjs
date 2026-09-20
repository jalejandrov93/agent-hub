import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getDb, closeDb } from '../src/storage/index.mjs'
import { runWorkflow, transitionNode } from '../src/workflow/engine.mjs'
import { NODE_STATUS } from '../src/workflow/state.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-a7-gaps-'))
}

test('A7 caso 2: Jules-waiting con mocks de supervisor/interact — approve_plan reanuda sin re-dispatch', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const order = []
  let dispatchCalls = 0
  let waitCalls = 0
  const interactCalls = []

  const dispatchFn = async () => {
    dispatchCalls++
    return { jobId: 'job-jules-1', sessionId: 'sess-1', _aborted: false, async abort() { return { stoppedWaiting: true } } }
  }
  const waitExecutionFn = async () => {
    waitCalls++
    if (waitCalls === 1) {
      order.push('wait:waiting')
      return { done: true, waiting: true, status: 'waiting', reason: 'plan_approval', record: { jobId: 'job-jules-1', status: 'running' }, remoteState: 'AWAITING_PLAN_APPROVAL' }
    }
    order.push('wait:succeeded')
    return { done: true, status: 'succeeded', record: { jobId: 'job-jules-1', status: 'succeeded' } }
  }

  const workflow = {
    id: 'wf-a7-jules',
    name: 'jules waiting test',
    nodes: [{ id: 'step1', type: 'delegate', task: 'work', maxAttempts: 1 }],
  }

  // Mock del supervisor: ante el waiting decide approve_plan y lo ejecuta
  // via el mock de interact (jules_interact), que reanuda el nodo
  // waiting -> running sin tocar el dispatch.
  const dbCtx = getDb(env)
  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn,
    waitExecutionFn,
    pollIntervalMs: 5,
    waitingTimeoutS: 30,
    onWaiting: async ({ workflowId, stepId, reason }) => {
      assert.equal(reason, 'plan_approval')
      interactCalls.push('approve_plan')
      order.push('interact:approve_plan')
      transitionNode(dbCtx, { workflowId, stepId, from: NODE_STATUS.WAITING, to: NODE_STATUS.RUNNING })
    },
  })

  assert.equal(result.status, 'succeeded')
  assert.deepEqual(order, ['wait:waiting', 'interact:approve_plan', 'wait:succeeded'])
  assert.deepEqual(interactCalls, ['approve_plan'])
  assert.equal(dispatchCalls, 1, 'aprobar el plan no re-dispatchea: se sigue el mismo handle')
  assert.equal(result.nodes.step1.status, NODE_STATUS.SUCCEEDED)
  closeDb(env)
})

test('A7 caso 5: timeout → abort → retry — el resultado tardio del intento abortado nunca se usa', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const aborts = []
  const attempts = []
  let n = 0
  // El intento 1 sigue 'running' al confirmar tras el abort; su exito tardio
  // (visible solo despues) no debe resucitar ni reutilizarse jamas.
  let attempt1LateSuccess = false

  const dispatchFn = async (params) => {
    attempts.push(params.attempt)
    const attempt = params.attempt
    return {
      jobId: `job-a7-${attempt}`,
      _aborted: false,
      async abort() { aborts.push(attempt); this._aborted = true; return { canceled: true } },
    }
  }
  const waitExecutionFn = async () => {
    n++
    if (n === 1) return { done: false, timedOut: true, record: { jobId: 'job-a7-1', status: 'running' } }
    return { done: true, status: 'succeeded', record: { jobId: 'job-a7-2', status: 'succeeded' } }
  }
  const readResultFn = (jobId) => {
    if (jobId === 'job-a7-1' && attempt1LateSuccess) return { jobId, status: 'succeeded' }
    return { jobId, status: 'running' }
  }

  const workflow = {
    id: 'wf-a7-abort',
    name: 'anti double execution test',
    nodes: [{ id: 'step1', type: 'delegate', task: 'work', maxAttempts: 2, timeoutS: 5 }],
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn,
    waitExecutionFn,
    backoffMs: 1,
    pollIntervalMs: 5,
    readResultFn,
  })

  assert.equal(result.status, 'succeeded')
  assert.deepEqual(aborts, [1], 'el intento con timeout hace abort exactamente una vez')
  assert.deepEqual(attempts, [1, 2], 'retry con attempt+1, sin ejecuciones extra')
  assert.equal(result.nodes.step1.attempt, 2)
  assert.equal(result.nodes.step1.result?.jobId, 'job-a7-2', 'el resultado es del intento 2, no del abortado')

  // Exito tardio del intento 1: el nodo ya cerro con el intento 2.
  attempt1LateSuccess = true
  assert.equal(result.nodes.step1.result?.jobId, 'job-a7-2', 'el exito tardio del intento abortado no resucita')
  closeDb(env)
})

test('A7 caso 5: timeout → abort → confirm terminal — no re-dispatchea', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const aborts = []
  let dispatchCalls = 0
  let n = 0

  const dispatchFn = async (params) => {
    dispatchCalls++
    return {
      jobId: `job-a7c-${params.attempt}`,
      _aborted: false,
      async abort() { aborts.push(params.attempt); this._aborted = true; return { canceled: true } },
    }
  }
  const waitExecutionFn = async () => {
    n++
    if (n === 1) return { done: false, timedOut: true, record: { jobId: 'job-a7c-1', status: 'running' } }
    throw new Error('no debe observarse un segundo intento')
  }
  // Al confirmar tras el abort, el record ya esta terminal: se adopta.
  const readResultFn = () => ({ jobId: 'job-a7c-1', status: 'succeeded' })

  const workflow = {
    id: 'wf-a7-confirm',
    name: 'confirm after abort test',
    nodes: [{ id: 'step1', type: 'delegate', task: 'work', maxAttempts: 2, timeoutS: 5 }],
  }

  const result = await runWorkflow({
    workflow,
    env,
    dispatchFn,
    waitExecutionFn,
    backoffMs: 1,
    pollIntervalMs: 5,
    readResultFn,
  })

  assert.equal(result.status, 'succeeded')
  assert.deepEqual(aborts, [1])
  assert.equal(dispatchCalls, 1, 'confirmar terminal tras abort no re-dispatchea (anti-doble-ejecucion)')
  assert.equal(result.nodes.step1.result?.jobId, 'job-a7c-1')
  closeDb(env)
})
