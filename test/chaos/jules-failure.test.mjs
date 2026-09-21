import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { startRemoteJob, finishRemoteJob } from '../../src/cloud/runner.mjs'
import { pollUntilTerminal } from '../../src/cloud/poller.mjs'
import { createJob, readResult, updateResult } from '../../src/jobstore.mjs'
import { createAccount, setPolicy } from '../../src/accounts.mjs'
import { classifyError } from '../../src/policy/taxonomy.mjs'
import * as julesClient from '../../src/cloud/jules/client.mjs'
import * as julesAdapter from '../../src/cloud/jules/adapter.mjs'

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-chaos-jules-'))
}

function canned({ status, body = {}, raw, contentType = 'application/json' }) {
  const text = raw !== undefined ? raw : JSON.stringify(body)
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { 'content-type': contentType },
    text: async () => text,
  }
}

function makeClientWithFetch(fetchImpl) {
  return {
    createSession: (args) => julesClient.createSession({ ...args, fetchImpl }),
    getSession: (args) => julesClient.getSession({ ...args, fetchImpl }),
    listActivities: (args) => julesClient.listActivities({ ...args, fetchImpl }),
  }
}

test('jules 429 fails over to the next eligible account (bounded failover)', async () => {
  const home = makeTempHome()
  const env = { ...process.env, AGENT_HUB_HOME: home }

  try {
    const acc1 = createAccount({ label: 'acc-alpha', apiKey: 'key-alpha' }, env)
    const acc2 = createAccount({ label: 'acc-beta', apiKey: 'key-beta' }, env)
    setPolicy('priority', env)

    const attemptedKeys = []
    const fetchImpl = async (url, init = {}) => {
      const apiKey = init.headers?.['X-Goog-Api-Key']
      attemptedKeys.push(apiKey)

      if (apiKey === 'key-alpha') {
        return canned({
          status: 429,
          body: { error: { code: 429, message: 'Resource exhausted: rate limit' } },
        })
      }

      if (apiKey === 'key-beta') {
        return canned({
          status: 200,
          body: { name: 'sessions/sess-beta-1', id: 'sess-beta-1', state: 'QUEUED' },
        })
      }

      return canned({ status: 500, body: { error: 'unexpected key' } })
    }

    const client = makeClientWithFetch(fetchImpl)
    const mockPollFn = async () => ({
      outcome: 'completed',
      state: 'COMPLETED',
      summary: { completed: true, failed: false },
      session: { name: 'sessions/sess-beta-1', id: 'sess-beta-1', state: 'COMPLETED' },
      apiError: null,
    })

    const { job, done } = startRemoteJob({
      task: 'chaos jules 429 failover test',
      cwd: '/repo',
      source: 'sources/github/acme/repo',
      env,
      client,
      adapter: julesAdapter,
      pollFn: mockPollFn,
    })

    await done

    assert.deepEqual(attemptedKeys, ['key-alpha', 'key-beta'], 'must try alpha first then fail over to beta')
    const finalJob = readResult(job.jobId, env)
    assert.equal(finalJob.status, 'succeeded', 'job should succeed on failed-over account')
    assert.equal(finalJob.remote.accountId, acc2.id, 'job must record successful account ID')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('jules 429 failover is bounded: exhausts at MAX_ACCOUNT_ATTEMPTS (3) and fails with errorKind quota', async () => {
  const home = makeTempHome()
  const env = { ...process.env, AGENT_HUB_HOME: home }

  try {
    createAccount({ label: 'acc-1', apiKey: 'key-1' }, env)
    createAccount({ label: 'acc-2', apiKey: 'key-2' }, env)
    createAccount({ label: 'acc-3', apiKey: 'key-3' }, env)
    createAccount({ label: 'acc-4', apiKey: 'key-4' }, env)
    setPolicy('priority', env)

    const attemptedKeys = []
    const fetchImpl = async (url, init = {}) => {
      const apiKey = init.headers?.['X-Goog-Api-Key']
      attemptedKeys.push(apiKey)
      return canned({
        status: 429,
        body: { error: { code: 429, message: 'Resource exhausted: quota exceeded' } },
      })
    }

    const client = makeClientWithFetch(fetchImpl)
    const { job, done } = startRemoteJob({
      task: 'chaos jules bounded quota test',
      cwd: '/repo',
      source: 'sources/github/acme/repo',
      env,
      client,
      adapter: julesAdapter,
    })

    await done

    assert.equal(attemptedKeys.length, 3, 'failover must be bounded to MAX_ACCOUNT_ATTEMPTS (3)')
    assert.ok(!attemptedKeys.includes('key-4'), 'fourth account must not be attempted')

    const finalJob = readResult(job.jobId, env)
    assert.equal(finalJob.status, 'failed')
    assert.equal(finalJob.errorKind, 'quota')
    assert.match(finalJob.error, /3 account\(s\)/)
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('5xx/network failure classifies as transport without corrupting local job state', async () => {
  const home = makeTempHome()
  const env = { ...process.env, AGENT_HUB_HOME: home }

  try {
    // 1. Verify 5xx and network error classification
    const err503 = new julesClient.JulesApiError('Jules API responded 503 Service Unavailable on /sessions/sess-1', {
      status: 503,
      endpoint: '/sessions/sess-1',
    })
    assert.equal(classifyError(err503, { status: 503 }), 'transport', '503 error must classify as transport')
    assert.equal(classifyError(err503), 'transport', '503 text must classify as transport')

    const networkError = new julesClient.JulesApiError('network error: fetch failed', {
      status: 0,
      endpoint: '/sessions/sess-1',
      cause: new TypeError('fetch failed'),
    })
    assert.equal(classifyError(networkError), 'transport', 'network failure must classify as transport')
    assert.equal(classifyError(networkError.cause), 'transport', 'network cause must classify as transport')

    // 2. Verify polling with 5xx/network errors does not corrupt local state
    const job = createJob({
      agent: 'jules',
      model: 'jules',
      task: 'network resilience test',
      cwd: '/repo',
      title: 'network resilience test',
      mode: 'write',
      env,
    })
    updateResult(
      job.jobId,
      {
        status: 'running',
        remote: {
          provider: 'jules',
          sessionId: 'sess-active-1',
          state: 'IN_PROGRESS',
          branch: 'feature/chaos-net',
        },
      },
      env
    )

    let pollAttempts = 0
    const fetchImpl = async () => {
      pollAttempts++
      // Network failure on fetch
      throw new TypeError('fetch failed: ECONNRESET')
    }

    const client = makeClientWithFetch(fetchImpl)

    const pollResult = await pollUntilTerminal({
      jobId: job.jobId,
      apiKey: 'test-key',
      sessionId: 'sess-active-1',
      timeoutMs: 1000,
      client,
      adapter: julesAdapter,
      env,
      maxConsecutiveErrors: 2,
      sleepFn: async () => {},
    })

    assert.equal(pollResult.outcome, 'failed')
    assert.ok(pollResult.apiError, 'pollResult must contain apiError')
    assert.equal(
      classifyError(pollResult.apiError.cause ?? pollResult.apiError),
      'transport',
      'apiError must classify as transport'
    )

    // Finish remote job after API errors
    finishRemoteJob({
      jobId: job.jobId,
      outcome: pollResult.outcome,
      state: pollResult.state,
      summary: pollResult.summary,
      session: pollResult.session,
      apiError: pollResult.apiError,
      adapter: julesAdapter,
      env,
    })

    // INVARIANT: local job state must NOT be marked terminal or corrupted.
    // The remote session is still alive on Google side; local polling stops with reason recorded.
    const preservedJob = readResult(job.jobId, env)
    assert.equal(preservedJob.status, 'running', 'status must remain running so it is not falsely failed')
    assert.equal(preservedJob.remote.sessionId, 'sess-active-1', 'remote sessionId must be preserved')
    assert.equal(preservedJob.remote.branch, 'feature/chaos-net', 'remote branch must be preserved')
    assert.equal(preservedJob.remote.pollingStoppedReason, 'api_errors', 'polling stopped reason must be recorded')
    assert.ok(preservedJob.remote.pollingStoppedAt, 'polling stopped timestamp must be set')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('canceled job stops polling: poller checks canceled BEFORE reading the clock', async () => {
  const home = makeTempHome()
  const env = { ...process.env, AGENT_HUB_HOME: home }

  try {
    const job = createJob({
      agent: 'jules',
      model: 'jules',
      task: 'canceled before clock test',
      cwd: '/repo',
      title: 'canceled test',
      mode: 'write',
      env,
    })
    updateResult(job.jobId, { status: 'canceled', errorKind: 'canceled_by_user' }, env)

    let clockReads = 0
    const mockNowFn = () => {
      clockReads++
      return 1000
    }

    let clientApiCalls = 0
    const mockClient = {
      getSession: async () => {
        clientApiCalls++
        return { state: 'IN_PROGRESS' }
      },
    }

    const res = await pollUntilTerminal({
      jobId: job.jobId,
      apiKey: 'test-api-key',
      sessionId: 'sess-canceled-job',
      timeoutMs: 60000,
      client: mockClient,
      adapter: julesAdapter,
      env,
      nowFn: mockNowFn,
    })

    assert.equal(res.outcome, 'canceled', 'poller outcome must be canceled')
    assert.equal(clockReads, 0, 'poller must check canceled BEFORE reading the clock (zero clock reads)')
    assert.equal(clientApiCalls, 0, 'canceled job must never make API calls or spend quota')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
