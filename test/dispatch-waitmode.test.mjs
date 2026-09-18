import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dispatch } from '../src/dispatch.mjs'

function baseRoute(candidate = { agent: 'agy', model: 'm' }) {
  return {
    routeFn: async () => ({ primary: candidate, fallbacks: [] }),
    runPreflightFn: async () => ({ status: 'ready' }),
    circuitBreakerOpenFn: () => false,
  }
}

function mockStartJob(jobId, seen = null) {
  return async (args) => {
    seen?.push(args)
    return {
      job: {
        jobId,
        agent: args.agent,
        model: args.model,
        status: 'queued',
        createdAt: new Date().toISOString(),
        dispatchKey: args.dispatchKey,
      },
      done: Promise.resolve(),
    }
  }
}

test('waitMode none (default generic): retorna al crear sin observar', async () => {
  let waited = 0
  const seen = []
  const res = await dispatch({
    task: 't-none',
    taskType: 'recon',
    cwd: '/tmp/wm-none',
    dispatchKey: 'wm-none-key',
    harness: 'generic',
    startJobFn: mockStartJob('job-wm-none', seen),
    waitExecutionFn: async () => { waited++; return { done: true, status: 'succeeded', record: { status: 'succeeded' } } },
    ...baseRoute(),
  })
  assert.equal(waited, 0, 'none nunca llama a waitExecution')
  assert.equal(res.harness, 'generic')
  assert.equal(res.waitMode, 'none')
  assert.equal(res.wait, undefined)
  assert.equal(res.jobId, 'job-wm-none')
  // startJob recibe el contrato resuelto (para record + eventos)
  assert.equal(seen[0]?.harness, 'generic')
  assert.equal(seen[0]?.waitMode, 'none')
})

test('waitMode attention: una sola observacion; waiting termina sin seguir', async () => {
  let calls = 0
  const res = await dispatch({
    task: 't-att',
    taskType: 'recon',
    cwd: '/tmp/wm-att',
    dispatchKey: 'wm-att-key',
    waitMode: 'attention',
    harness: 'generic',
    startJobFn: mockStartJob('job-wm-att'),
    waitExecutionFn: async () => {
      calls++
      return { done: true, waiting: true, status: 'waiting', reason: 'plan_approval', record: { jobId: 'job-wm-att', status: 'running' }, remoteState: 'AWAITING_PLAN_APPROVAL' }
    },
    ...baseRoute(),
  })
  assert.equal(calls, 1, 'attention observa exactamente una vez')
  assert.equal(res.waitMode, 'attention')
  assert.equal(res.wait?.waiting, true)
  assert.equal(res.wait?.reason, 'plan_approval')
})

test('waitMode attention: terminal resuelve en la misma observacion', async () => {
  const res = await dispatch({
    task: 't-att-ok',
    taskType: 'recon',
    cwd: '/tmp/wm-att-ok',
    dispatchKey: 'wm-att-ok-key',
    waitMode: 'attention',
    harness: 'generic',
    startJobFn: mockStartJob('job-wm-att-ok'),
    waitExecutionFn: async () => ({ done: true, status: 'succeeded', record: { jobId: 'job-wm-att-ok', status: 'succeeded' } }),
    ...baseRoute(),
  })
  assert.equal(res.wait?.status, 'succeeded')
})

test('waitMode terminal: sigue observando past waiting hasta terminal', async () => {
  let calls = 0
  const res = await dispatch({
    task: 't-term',
    taskType: 'recon',
    cwd: '/tmp/wm-term',
    dispatchKey: 'wm-term-key',
    waitMode: 'terminal',
    harness: 'generic',
    startJobFn: mockStartJob('job-wm-term'),
    waitExecutionFn: async () => {
      calls++
      if (calls === 1) {
        return { done: true, waiting: true, status: 'waiting', reason: 'user_feedback', record: { jobId: 'job-wm-term', status: 'running' }, remoteState: 'AWAITING_USER_FEEDBACK' }
      }
      return { done: true, status: 'succeeded', record: { jobId: 'job-wm-term', status: 'succeeded' } }
    },
    ...baseRoute(),
  })
  assert.equal(calls, 2, 'terminal re-observa tras waiting')
  assert.equal(res.wait?.status, 'succeeded')
  assert.equal(res.waitMode, 'terminal')
})

test('waitMode terminal: presupuesto agotado en waiting devuelve timedOut sin colgar', async () => {
  let now = 1_000_000
  let calls = 0
  const res = await dispatch({
    task: 't-term-budget',
    taskType: 'recon',
    cwd: '/tmp/wm-term-budget',
    dispatchKey: 'wm-term-budget-key',
    waitMode: 'terminal',
    harness: 'generic',
    waitTimeoutS: 0.05,
    nowFn: () => now,
    startJobFn: mockStartJob('job-wm-term-budget'),
    waitExecutionFn: async () => {
      calls++
      now += 1000 // el tiempo avanza: el presupuesto se agota
      return { done: true, waiting: true, status: 'waiting', reason: 'user_feedback', record: { status: 'running' }, remoteState: 'AWAITING_USER_FEEDBACK' }
    },
    ...baseRoute(),
  })
  assert.ok(calls >= 1)
  assert.equal(res.wait?.waiting, true)
  assert.equal(res.wait?.timedOut, true)
})

test('default del profile: env claude-code => attention sin pasar waitMode', async () => {
  let waited = 0
  const res = await dispatch({
    task: 't-env',
    taskType: 'recon',
    cwd: '/tmp/wm-env',
    dispatchKey: 'wm-env-key',
    env: { AGENT_HUB_HARNESS: 'claude-code' },
    startJobFn: mockStartJob('job-wm-env'),
    waitExecutionFn: async () => { waited++; return { done: true, status: 'succeeded', record: { status: 'succeeded' } } },
    ...baseRoute(),
  })
  assert.equal(res.harness, 'claude-code')
  assert.equal(res.waitMode, 'attention')
  assert.equal(waited, 1)
})

test('hint MCP solo es default: clientHint opencode => attention', async () => {
  let waited = 0
  const res = await dispatch({
    task: 't-hint',
    taskType: 'recon',
    cwd: '/tmp/wm-hint',
    dispatchKey: 'wm-hint-key',
    env: {},
    clientHint: 'opencode',
    startJobFn: mockStartJob('job-wm-hint'),
    waitExecutionFn: async () => { waited++; return { done: true, status: 'succeeded', record: { status: 'succeeded' } } },
    ...baseRoute(),
  })
  assert.equal(res.harness, 'opencode')
  assert.equal(res.waitMode, 'attention')
  assert.equal(waited, 1)
})

test('waitMode explicito gana al profile: env claude-code + none => sin espera', async () => {
  let waited = 0
  const res = await dispatch({
    task: 't-override',
    taskType: 'recon',
    cwd: '/tmp/wm-override',
    dispatchKey: 'wm-override-key',
    env: { AGENT_HUB_HARNESS: 'claude-code' },
    waitMode: 'none',
    startJobFn: mockStartJob('job-wm-override'),
    waitExecutionFn: async () => { waited++; return { done: true, status: 'succeeded', record: { status: 'succeeded' } } },
    ...baseRoute(),
  })
  assert.equal(res.harness, 'claude-code')
  assert.equal(res.waitMode, 'none')
  assert.equal(waited, 0)
})

test('waitMode invalido falla rapido', async () => {
  await assert.rejects(
    () => dispatch({
      task: 't-bad',
      taskType: 'recon',
      cwd: '/tmp/wm-bad',
      dispatchKey: 'wm-bad-key',
      waitMode: 'smart',
      startJobFn: mockStartJob('job-wm-bad'),
      ...baseRoute(),
    }),
    /unknown waitMode/
  )
})

test('compat: delegate() sin espera por defecto en generic (harness+none via dispatch)', async () => {
  // delegateTool() no cambia: create/start inmediato. El equivalente
  // dispatch en generic debe seguir retornando sin observar.
  let waited = 0
  const res = await dispatch({
    task: 't-compat',
    taskType: 'recon',
    cwd: '/tmp/wm-compat',
    dispatchKey: 'wm-compat-key',
    env: {},
    startJobFn: mockStartJob('job-wm-compat'),
    waitExecutionFn: async () => { waited++; return { done: true, status: 'succeeded', record: { status: 'succeeded' } } },
    ...baseRoute(),
  })
  assert.equal(res.harness, 'generic')
  assert.equal(res.waitMode, 'none')
  assert.equal(waited, 0)
  assert.ok(res.job && res.dispatchKey && res.executionId && res.candidate)
  assert.equal(typeof res.abort, 'function')
})
