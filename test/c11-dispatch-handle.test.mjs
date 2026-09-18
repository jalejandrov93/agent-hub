import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dispatch,
  createExecutionHandle,
  isExecutionHandle,
  waitExecution,
  isWaitingJobState,
  waitingReasonForState,
} from '../src/dispatch.mjs'

function baseRoute(candidate = { agent: 'agy', model: 'm' }) {
  return {
    routeFn: async () => ({ primary: candidate, fallbacks: [] }),
    runPreflightFn: async () => ({ status: 'ready' }),
    circuitBreakerOpenFn: () => false,
  }
}

test('C1.1 dispatch retorna handle {jobId, sessionId, abort} + compat total', async () => {
  const mockStartJob = async (args) => ({
    job: {
      jobId: 'job-handle-1',
      agent: args.agent,
      model: args.model,
      status: 'queued',
      sessionId: 'sess-1',
      createdAt: new Date().toISOString(),
      dispatchKey: args.dispatchKey,
    },
    done: Promise.resolve(),
  })
  const res = await dispatch({
    task: 't',
    taskType: 'recon',
    cwd: '/tmp/c11-handle',
    dispatchKey: 'c11-handle-key',
    startJobFn: mockStartJob,
    ...baseRoute(),
  })
  // Compat: campos viejos intactos
  assert.ok(res.job)
  assert.equal(res.dispatchKey, 'c11-handle-key')
  assert.ok(res.executionId)
  assert.equal(res.candidate.agent, 'agy')
  // Nuevo: handle
  assert.equal(res.jobId, 'job-handle-1')
  assert.equal(res.sessionId, 'sess-1')
  assert.equal(typeof res.abort, 'function')
  assert.ok(isExecutionHandle({ jobId: res.jobId, abort: res.abort }))
})

test('C1.1 waitExecution: terminal real + onWaiting + timeout', async () => {
  // Terminal
  const ok = await waitExecution(
    { jobId: 'j1', _aborted: false },
    { timeoutS: 5, pollIntervalMs: 5, readResultFn: () => ({ jobId: 'j1', status: 'succeeded' }) }
  )
  assert.equal(ok.done, true)
  assert.equal(ok.status, 'succeeded')

  // Waiting con reason + onWaiting llamado
  let seen = null
  const waiting = await waitExecution(
    { jobId: 'j2', _aborted: false },
    {
      timeoutS: 5,
      pollIntervalMs: 5,
      readResultFn: () => ({ jobId: 'j2', status: 'running', remote: { state: 'AWAITING_USER_FEEDBACK' } }),
      onWaiting: async ({ record, reason }) => { seen = { record, reason } },
    }
  )
  assert.equal(waiting.waiting, true)
  assert.equal(waiting.reason, 'user_feedback')
  assert.equal(seen.reason, 'user_feedback')

  // Timeout local
  const timed = await waitExecution(
    { jobId: 'j3', _aborted: false },
    { timeoutS: 0.05, pollIntervalMs: 5, readResultFn: () => ({ jobId: 'j3', status: 'running' }) }
  )
  assert.equal(timed.timedOut, true)

  // Abortado
  const handle = { jobId: 'j4', _aborted: true }
  const aborted = await waitExecution(handle, {
    timeoutS: 5,
    pollIntervalMs: 5,
    readResultFn: () => ({ jobId: 'j4', status: 'running' }),
  })
  assert.equal(aborted.aborted, true)
})

test('C1.1 waiting reasons por estado remoto', () => {
  assert.equal(isWaitingJobState('AWAITING_USER_FEEDBACK'), true)
  assert.equal(isWaitingJobState('AWAITING_PLAN_APPROVAL'), true)
  assert.equal(isWaitingJobState('PAUSED'), true)
  assert.equal(isWaitingJobState('IN_PROGRESS'), false)
  assert.equal(isWaitingJobState(null), false)
  assert.equal(waitingReasonForState('AWAITING_USER_FEEDBACK'), 'user_feedback')
  assert.equal(waitingReasonForState('AWAITING_PLAN_APPROVAL'), 'plan_approval')
  assert.equal(waitingReasonForState('PAUSED'), 'external_event')
})

test('C1.1 abort(): local → cancelJob + confirmación; remoto → stop-wait', async () => {
  let canceled = []
  const cancelJobFn = async (jobId) => {
    canceled.push(jobId)
    return { jobId, status: 'canceled' }
  }
  const local = createExecutionHandle({
    job: { jobId: 'job-local', status: 'running' },
    cancelJobFn,
    isRemote: false,
  })
  const localRes = await local.abort()
  assert.equal(localRes.canceled, true)
  assert.deepEqual(canceled, ['job-local'])

  const remote = createExecutionHandle({
    job: { jobId: 'job-remote', status: 'running', remote: { sessionId: 'sess-r' } },
    cancelJobFn,
    isRemote: true,
  })
  const remoteRes = await remote.abort()
  assert.equal(remoteRes.stoppedWaiting, true)
  assert.equal(remoteRes.remoteContinuing, true)
  assert.deepEqual(canceled, ['job-local'], 'remoto nunca llama cancelJob')
})
