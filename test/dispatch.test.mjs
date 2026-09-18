import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  dispatch,
  computeDispatchKey,
  fingerprintRemoteIntent,
  findMatchingSession,
  calculateDispatchTimeoutS,
  findRecentJobByDispatchKey,
} from '../src/dispatch.mjs'
import { createJob, listJobs, readResult } from '../src/jobstore.mjs'
import { paths, ADAPTIVE_TIMEOUT } from '../src/config.mjs'

function makeTempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dispatch-test-'))
  const env = { ...process.env, AGENT_HUB_HOME: home }
  return { home, env, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) }
}

test('computeDispatchKey computes deterministic sha256 from task+cwd+taskType+workflowStep', () => {
  const k1 = computeDispatchKey({ task: 'foo', cwd: '/bar', taskType: 'triage', workflowStep: 'step-1' })
  const k2 = computeDispatchKey({ task: 'foo', cwd: '/bar', taskType: 'triage', workflowStep: 'step-1' })
  const k3 = computeDispatchKey({ task: 'foo', cwd: '/bar', taskType: 'triage', workflowStep: 'step-2' })

  assert.equal(typeof k1, 'string')
  assert.equal(k1.length, 64)
  assert.equal(k1, k2)
  assert.notEqual(k1, k3)
})

test('calculateDispatchTimeoutS applies 1x/1.5x/2x attempt backoff clamped to capS', () => {
  const mockResolve = () => ({ timeoutS: 100 })

  const t1 = calculateDispatchTimeoutS({ attempt: 1, resolveEffectiveTimeoutSFn: mockResolve })
  const t2 = calculateDispatchTimeoutS({ attempt: 2, resolveEffectiveTimeoutSFn: mockResolve })
  const t3 = calculateDispatchTimeoutS({ attempt: 3, resolveEffectiveTimeoutSFn: mockResolve })
  const t4 = calculateDispatchTimeoutS({ attempt: 5, resolveEffectiveTimeoutSFn: mockResolve })

  assert.equal(t1, 100) // 1x
  assert.equal(t2, 150) // 1.5x
  assert.equal(t3, 200) // 2x
  assert.equal(t4, 200) // capped at 2x

  // Test capS clamping
  const hugeResolve = () => ({ timeoutS: 3000 })
  const capped = calculateDispatchTimeoutS({ attempt: 2, resolveEffectiveTimeoutSFn: hugeResolve })
  assert.equal(capped, ADAPTIVE_TIMEOUT.capS)
})

test('a) DOS dispatch CONCURRENTES misma dispatchKey → exactamente 1 job (Promise.all, con startJob mockeado con delay)', async () => {
  let startJobCalls = 0
  const jobsCreated = []

  const mockStartJob = async (args) => {
    startJobCalls++
    await new Promise((r) => setTimeout(r, 60))
    const job = {
      jobId: `job-concurrent-${startJobCalls}`,
      agent: args.agent,
      model: args.model,
      status: 'queued',
      createdAt: new Date().toISOString(),
      dispatchKey: args.dispatchKey,
      executionId: args.executionId,
    }
    jobsCreated.push(job)
    return { job, done: Promise.resolve() }
  }

  const [res1, res2] = await Promise.all([
    dispatch({
      task: 'same-task',
      taskType: 'recon',
      cwd: '/tmp/test-concurrent',
      mode: 'read',
      dispatchKey: 'concurrent-key-1',
      startJobFn: mockStartJob,
      routeFn: async () => ({ primary: { agent: 'agy', model: 'gemini-3.8-flash-low' }, fallbacks: [] }),
      runPreflightFn: async () => ({ status: 'ready' }),
      circuitBreakerOpenFn: () => false,
    }),
    dispatch({
      task: 'same-task',
      taskType: 'recon',
      cwd: '/tmp/test-concurrent',
      mode: 'read',
      dispatchKey: 'concurrent-key-1',
      startJobFn: mockStartJob,
      routeFn: async () => ({ primary: { agent: 'agy', model: 'gemini-3.8-flash-low' }, fallbacks: [] }),
      runPreflightFn: async () => ({ status: 'ready' }),
      circuitBreakerOpenFn: () => false,
    }),
  ])

  assert.equal(startJobCalls, 1, 'startJob must be called exactly once')
  assert.equal(jobsCreated.length, 1, 'exactly 1 job must be created')
  assert.equal(res1.job.jobId, res2.job.jobId, 'both dispatches must return the same job')
  assert.equal(res1.dispatchKey, 'concurrent-key-1')
  assert.equal(res2.dispatchKey, 'concurrent-key-1')
  assert.equal(res1.executionId, res2.executionId)
})

test('b) re-dispatch secuencial misma key → mismo jobId', async () => {
  let startJobCalls = 0

  const mockStartJob = async (args) => {
    startJobCalls++
    return {
      job: {
        jobId: 'job-seq-42',
        agent: args.agent,
        model: args.model,
        status: 'queued',
        createdAt: new Date().toISOString(),
        dispatchKey: args.dispatchKey,
        executionId: args.executionId,
      },
      done: Promise.resolve(),
    }
  }

  const res1 = await dispatch({
    task: 'seq-task',
    taskType: 'triage',
    cwd: '/tmp/test-seq',
    dispatchKey: 'seq-key-1',
    startJobFn: mockStartJob,
    routeFn: async () => ({ primary: { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free' }, fallbacks: [] }),
    runPreflightFn: async () => ({ status: 'ready' }),
    circuitBreakerOpenFn: () => false,
  })

  const res2 = await dispatch({
    task: 'seq-task',
    taskType: 'triage',
    cwd: '/tmp/test-seq',
    dispatchKey: 'seq-key-1',
    startJobFn: mockStartJob,
    routeFn: async () => ({ primary: { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free' }, fallbacks: [] }),
    runPreflightFn: async () => ({ status: 'ready' }),
    circuitBreakerOpenFn: () => false,
  })

  assert.equal(startJobCalls, 1, 'startJob must not be invoked on sequential re-dispatch with same key')
  assert.equal(res1.job.jobId, 'job-seq-42')
  assert.equal(res2.job.jobId, res1.job.jobId)
})

test('c) keys distintas → jobs distintos', async () => {
  let startJobCalls = 0

  const mockStartJob = async (args) => {
    startJobCalls++
    return {
      job: {
        jobId: `job-distinct-${startJobCalls}`,
        agent: args.agent,
        model: args.model,
        status: 'queued',
        createdAt: new Date().toISOString(),
        dispatchKey: args.dispatchKey,
        executionId: args.executionId,
      },
      done: Promise.resolve(),
    }
  }

  const res1 = await dispatch({
    task: 'task-1',
    taskType: 'research',
    cwd: '/tmp/test-c1',
    dispatchKey: 'key-1',
    startJobFn: mockStartJob,
    routeFn: async () => ({ primary: { agent: 'agy', model: 'gemini-3.8-flash-medium' }, fallbacks: [] }),
    runPreflightFn: async () => ({ status: 'ready' }),
    circuitBreakerOpenFn: () => false,
  })

  const res2 = await dispatch({
    task: 'task-2',
    taskType: 'research',
    cwd: '/tmp/test-c2',
    dispatchKey: 'key-2',
    startJobFn: mockStartJob,
    routeFn: async () => ({ primary: { agent: 'agy', model: 'gemini-3.8-flash-medium' }, fallbacks: [] }),
    runPreflightFn: async () => ({ status: 'ready' }),
    circuitBreakerOpenFn: () => false,
  })

  assert.equal(startJobCalls, 2)
  assert.notEqual(res1.job.jobId, res2.job.jobId)
  assert.equal(res1.dispatchKey, 'key-1')
  assert.equal(res2.dispatchKey, 'key-2')
})

test('d) fingerprint remoto re-adopta en vez de crear', async () => {
  let createSessionCalls = 0
  let startJobCalls = 0

  const existingSession = {
    id: 'sess-existing-jules-101',
    name: 'sessions/sess-existing-jules-101',
    title: 'PR review intent',
    createTime: new Date(Date.now() - 120000).toISOString(),
    sourceContext: { source: 'sources/github.com/org/repo', githubRepoContext: { startingBranch: 'main' } },
    state: 'IN_PROGRESS',
    prompt: 'Analyze repository architecture',
  }

  const linkedJob = {
    jobId: 'job-jules-linked-101',
    agent: 'jules',
    model: 'default',
    status: 'running',
    remote: { sessionId: 'sess-existing-jules-101', state: 'IN_PROGRESS' },
    createdAt: new Date(Date.now() - 120000).toISOString(),
    dispatchKey: 'jules-key-101',
    executionId: 'exec_original',
  }

  const mockClient = {
    listSessions: async () => ({ sessions: [existingSession] }),
    createSession: async () => {
      createSessionCalls++
      return { id: 'sess-new-202' }
    },
  }

  const mockStartJob = async () => {
    startJobCalls++
    return { job: { jobId: 'job-new' } }
  }

  const res = await dispatch({
    task: 'Analyze repository architecture',
    taskType: 'architecture',
    cwd: '/tmp/repo',
    dispatchKey: 'jules-key-101',
    source: 'sources/github.com/org/repo',
    startingBranch: 'main',
    title: 'PR review intent',
    candidate: { agent: 'jules', model: 'default' },
    client: mockClient,
    startJobFn: mockStartJob,
    listJobsFn: () => [linkedJob],
  })

  assert.equal(createSessionCalls, 0, 'createSession must never be called when matching session exists')
  assert.equal(startJobCalls, 0, 'startJob must never be called when re-adopting')
  assert.equal(res.job.jobId, 'job-jules-linked-101')
  assert.equal(res.job.remote.sessionId, 'sess-existing-jules-101')
})

test('closes TOCTOU gap by revalidating breaker and preflight at execution time', async () => {
  let startJobCandidate = null
  const mockStartJob = async (args) => {
    startJobCandidate = { agent: args.agent, model: args.model }
    return {
      job: {
        jobId: 'job-toctou-1',
        agent: args.agent,
        model: args.model,
        status: 'queued',
        createdAt: new Date().toISOString(),
        dispatchKey: args.dispatchKey,
      },
      done: Promise.resolve(),
    }
  }

  // Route returned primary (agy) and fallback (opencode), but agy's breaker is now open
  const res = await dispatch({
    task: 'test-toctou',
    taskType: 'triage',
    cwd: '/tmp/test-toctou',
    routeFn: async () => ({
      primary: { agent: 'agy', model: 'gemini-3.8-flash-low' },
      fallbacks: [{ agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free' }],
    }),
    circuitBreakerOpenFn: ({ agent }) => agent === 'agy', // agy breaker is open!
    runPreflightFn: async () => ({ status: 'ready' }),
    startJobFn: mockStartJob,
  })

  assert.equal(startJobCandidate.agent, 'opencode')
  assert.equal(res.candidate.agent, 'opencode')
})

test('automatic fallback to next candidate when first candidate fails fast', async () => {
  const attempted = []

  const mockStartJob = async (args) => {
    attempted.push(`${args.agent}:${args.model}`)
    if (args.agent === 'opencode') {
      return {
        job: {
          jobId: 'job-failed-fast',
          agent: args.agent,
          model: args.model,
          status: 'failed',
          errorKind: 'quota',
          error: 'Rate limit exceeded',
        },
        done: Promise.resolve(),
      }
    }
    return {
      job: {
        jobId: 'job-succeeded-fallback',
        agent: args.agent,
        model: args.model,
        status: 'queued',
        createdAt: new Date().toISOString(),
        dispatchKey: args.dispatchKey,
      },
      done: Promise.resolve(),
    }
  }

  const res = await dispatch({
    task: 'test-fallback',
    taskType: 'recon',
    cwd: '/tmp/test-fallback',
    category: 'quality', // quality policy has retry: false, fallback: true
    routeFn: async () => ({
      primary: { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free' },
      fallbacks: [{ agent: 'agy', model: 'gemini-3.8-flash-low' }],
    }),
    circuitBreakerOpenFn: () => false,
    runPreflightFn: async () => ({ status: 'ready' }),
    startJobFn: mockStartJob,
  })

  assert.deepEqual(attempted, [
    'opencode:opencode/muse-spark-1.3-contributor-free',
    'agy:gemini-3.8-flash-low',
  ])
  assert.equal(res.candidate.agent, 'agy')
  assert.equal(res.job.jobId, 'job-succeeded-fallback')
})

test('reserves write lock when mode is write and releases after check', async () => {
  let acquireLockCalled = false
  let releaseLockCalled = false

  const res = await dispatch({
    task: 'write-task',
    taskType: 'mechanical-edit',
    cwd: '/tmp/worktree-1',
    mode: 'write',
    routeFn: async () => ({
      primary: { agent: 'opencode', model: 'deepseek/deepseek-v4-flash', mode: 'write' },
      fallbacks: [],
    }),
    circuitBreakerOpenFn: () => false,
    runPreflightFn: async () => ({ status: 'ready' }),
    acquireWriteLockFn: ({ cwd, jobId }) => {
      acquireLockCalled = true
      return { acquired: true, file: '/tmp/lock.file' }
    },
    releaseWriteLockFn: () => {
      releaseLockCalled = true
    },
    startJobFn: async (args) => ({
      job: {
        jobId: 'job-write-1',
        agent: args.agent,
        model: args.model,
        status: 'queued',
        createdAt: new Date().toISOString(),
        dispatchKey: args.dispatchKey,
      },
    }),
  })

  assert.ok(acquireLockCalled, 'acquireWriteLock must be called')
  assert.ok(releaseLockCalled, 'releaseWriteLock must be called after reservation check')
  assert.equal(res.job.jobId, 'job-write-1')
})
