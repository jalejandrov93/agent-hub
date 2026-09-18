import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createJob, updateResult } from '../src/jobstore.mjs'
import { getDb, closeDb, getWorkflowNode, upsertWorkflowNode } from '../src/storage/index.mjs'
import { resumeWorkflowNodeFromExecution, bestEffortResumeWorkflowNode } from '../src/workflow/resume.mjs'
import { supervise } from '../src/cloud/jules/supervisor.mjs'
import { julesInteractTool } from '../src/tools/jules.mjs'
import { NODE_STATUS } from '../src/workflow/state.mjs'

function tmpEnv(extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-c12-resume-'))
  return { AGENT_HUB_HOME: home, ...extra }
}

function makeWaitingJob(env, { status = NODE_STATUS.WAITING, claimedBy = 'scheduler_1' } = {}) {
  const job = createJob({
    agent: 'jules', model: 'jules', task: 'do it', cwd: '/tmp',
    workflow_id: 'wf-c12', step_id: 'step1', env,
  })
  updateResult(job.jobId, { remote: { provider: 'jules', sessionId: 'sess-1' } }, env)
  const ctx = getDb(env)
  const now = new Date().toISOString()
  upsertWorkflowNode(ctx, {
    workflow_id: 'wf-c12', step_id: 'step1', status, attempt: 1,
    updated_at: now, claimed_by: claimedBy,
    result_json: JSON.stringify({ waiting: true, jobId: job.jobId }),
  })
  return job
}

// ─── 1. sin workflow ───

test('C1.2 resume: job sin workflow_id/step_id -> no-workflow', () => {
  const env = tmpEnv()
  try {
    const job = createJob({ agent: 'agy', model: 'm', task: 't', cwd: '/tmp', env })
    const res = resumeWorkflowNodeFromExecution(job.jobId, { env })
    assert.deepEqual(res, { resumed: false, reason: 'no-workflow' })
  } finally { closeDb(env) }
})

test('C1.2 resume: job inexistente -> no-workflow (nunca lanza)', () => {
  const env = tmpEnv()
  try {
    const res = resumeWorkflowNodeFromExecution('no-such-job', { env })
    assert.deepEqual(res, { resumed: false, reason: 'no-workflow' })
  } finally { closeDb(env) }
})

// ─── 2. no-waiting ───

test('C1.2 resume: nodo en otro estado -> not-waiting:<estado>, sin tocar nada', () => {
  const env = tmpEnv()
  try {
    const job = makeWaitingJob(env, { status: NODE_STATUS.RUNNING })
    const res = resumeWorkflowNodeFromExecution(job.jobId, { env })
    assert.deepEqual(res, { resumed: false, reason: 'not-waiting:running' })
    const ctx = getDb(env)
    assert.equal(getWorkflowNode(ctx, 'wf-c12', 'step1').status, NODE_STATUS.RUNNING)
  } finally { closeDb(env) }
})

test('C1.2 resume: nodo inexistente -> not-waiting:missing', () => {
  const env = tmpEnv()
  try {
    const job = createJob({
      agent: 'jules', model: 'jules', task: 't', cwd: '/tmp',
      workflow_id: 'wf-c12', step_id: 'ghost', env,
    })
    const res = resumeWorkflowNodeFromExecution(job.jobId, { env })
    assert.deepEqual(res, { resumed: false, reason: 'not-waiting:missing' })
  } finally { closeDb(env) }
})

// ─── 3. resume OK ───

test('C1.2 resume: WAITING -> RUNNING con CAS, claim preservado', () => {
  const env = tmpEnv()
  try {
    const job = makeWaitingJob(env)
    const res = resumeWorkflowNodeFromExecution(job.jobId, { env })
    assert.deepEqual(res, { resumed: true, workflowId: 'wf-c12', stepId: 'step1', from: 'waiting', to: 'running' })
    const ctx = getDb(env)
    const row = getWorkflowNode(ctx, 'wf-c12', 'step1')
    assert.equal(row.status, NODE_STATUS.RUNNING)
    assert.equal(row.claimed_by, 'scheduler_1')
  } finally { closeDb(env) }
})

test('C1.2 resume: segundo resume sobre el mismo nodo -> not-waiting:running', () => {
  const env = tmpEnv()
  try {
    const job = makeWaitingJob(env)
    assert.equal(resumeWorkflowNodeFromExecution(job.jobId, { env }).resumed, true)
    const again = resumeWorkflowNodeFromExecution(job.jobId, { env })
    assert.deepEqual(again, { resumed: false, reason: 'not-waiting:running' })
  } finally { closeDb(env) }
})

test('C1.2 resume: transitionNodeFn inyectado recibe WAITING->RUNNING', () => {
  const env = tmpEnv()
  try {
    const job = makeWaitingJob(env)
    let seen = null
    const transitionNodeFn = (ctx, params) => { seen = params; return { ok: true } }
    const res = resumeWorkflowNodeFromExecution(job.jobId, { env, transitionNodeFn })
    assert.equal(res.resumed, true)
    assert.deepEqual(seen, { workflowId: 'wf-c12', stepId: 'step1', from: 'waiting', to: 'running' })
  } finally { closeDb(env) }
})

// ─── 4. owned-elsewhere ───

test('C1.2 resume: claim de otro scheduler vivo -> owned-elsewhere, sin escribir', () => {
  const env = tmpEnv()
  try {
    const job = makeWaitingJob(env, { claimedBy: 'scheduler_other' })
    const res = resumeWorkflowNodeFromExecution(job.jobId, {
      env, claimedBy: 'scheduler_me', isOwnerAlive: () => true,
    })
    assert.deepEqual(res, { resumed: false, reason: 'owned-elsewhere' })
    const ctx = getDb(env)
    assert.equal(getWorkflowNode(ctx, 'wf-c12', 'step1').status, NODE_STATUS.WAITING)
  } finally { closeDb(env) }
})

test('C1.2 resume: claim foráneo pero muerto -> resume OK', () => {
  const env = tmpEnv()
  try {
    const job = makeWaitingJob(env, { claimedBy: 'scheduler_dead' })
    const res = resumeWorkflowNodeFromExecution(job.jobId, {
      env, claimedBy: 'scheduler_me', isOwnerAlive: () => false,
    })
    assert.equal(res.resumed, true)
  } finally { closeDb(env) }
})

test('C1.2 resume: CAS perdido (transitionNodeFn falsy) -> owned-elsewhere', () => {
  const env = tmpEnv()
  try {
    const job = makeWaitingJob(env)
    // El write pierde la carrera pero el nodo sigue WAITING: es otro dueño.
    const res = resumeWorkflowNodeFromExecution(job.jobId, { env, transitionNodeFn: () => false })
    assert.deepEqual(res, { resumed: false, reason: 'owned-elsewhere' })
  } finally { closeDb(env) }
})

test('C1.2 bestEffort: nunca lanza ante readResult roto', () => {
  const res = bestEffortResumeWorkflowNode('x', {
    env: tmpEnv(),
    readResultFn: () => { throw new Error('boom') },
  })
  // readResult roto -> record null -> no-workflow (vía catch interno de resume)
  assert.equal(res.resumed, false)
})

// ─── 5. wiring supervise() ───

test('C1.2 wiring: supervise() tras approve_plan reanuda el nodo WAITING', async () => {
  const env = tmpEnv({ JULES_API_KEY: 'test-key' })
  try {
    const job = makeWaitingJob(env)
    let checks = 0
    const checkRemoteSessionFn = async () => {
      checks++
      if (checks === 1) {
        return { state: 'AWAITING_PLAN_APPROVAL', terminal: false, sessionId: 'sess-1', attentionRequired: true }
      }
      return { state: 'COMPLETED', terminal: true, sessionId: 'sess-1', prUrl: 'https://pr/1', branch: 'b' }
    }
    const interactCalls = []
    const interactFn = async (params) => { interactCalls.push(params); return { status: 'ok' } }
    const result = await supervise({
      jobId: job.jobId, env,
      policy: { autoApprovePlan: true, autoResolveFeedback: false },
      timeoutS: 30, intervalMs: 1,
      checkRemoteSessionFn, interactFn,
      sleepFn: async () => {},
    })
    assert.equal(result.outcome, 'terminal')
    assert.equal(interactCalls.length, 1)
    assert.equal(interactCalls[0].action, 'approve_plan')
    const ctx = getDb(env)
    assert.equal(getWorkflowNode(ctx, 'wf-c12', 'step1').status, NODE_STATUS.RUNNING)
  } finally { closeDb(env) }
})

// ─── 6. wiring julesInteractTool() ───

test('C1.2 wiring: julesInteractTool() tras reply OK reanuda el nodo WAITING', async () => {
  const env = tmpEnv({ JULES_API_KEY: 'test-key' })
  try {
    const job = makeWaitingJob(env)
    const client = {
      sendMessage: async () => ({ ok: true }),
      approvePlan: async () => ({ ok: true }),
    }
    const res = await julesInteractTool({
      jobId: job.jobId, action: 'reply', message: 'sigue así', env, client,
    })
    assert.equal(res.status, 'ok')
    const ctx = getDb(env)
    assert.equal(getWorkflowNode(ctx, 'wf-c12', 'step1').status, NODE_STATUS.RUNNING)
  } finally { closeDb(env) }
})

test('C1.2 wiring: julesInteractTool() con fallo remoto no toca el nodo', async () => {
  const env = tmpEnv({ JULES_API_KEY: 'test-key' })
  try {
    const job = makeWaitingJob(env)
    const client = {
      sendMessage: async () => { throw new Error('remote down') },
      approvePlan: async () => ({ ok: true }),
    }
    await assert.rejects(
      julesInteractTool({ jobId: job.jobId, action: 'reply', message: 'hola', env, client })
    )
    const ctx = getDb(env)
    assert.equal(getWorkflowNode(ctx, 'wf-c12', 'step1').status, NODE_STATUS.WAITING)
  } finally { closeDb(env) }
})
