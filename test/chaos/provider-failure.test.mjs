import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { policyFor, POLICY_TABLE } from '../../src/policy/registry.mjs'
import { executeWithPolicy } from '../../src/policy/executor.mjs'
import { dispatch } from '../../src/dispatch.mjs'
import { route } from '../../src/router.mjs'

function makeTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-chaos-provider-'))
}

test('A3 policy: policy table maps quota to fallback: true, auth/billing to fallback: false and escalate: human', () => {
  const quotaPolicy = policyFor('quota')
  assert.ok(quotaPolicy, 'quota policy must be defined')
  assert.equal(quotaPolicy.fallback, true, 'quota failure must allow fallback to next candidate')
  assert.equal(quotaPolicy.escalation, 'human', 'quota failure escalates to human when fallbacks exhausted')
  assert.equal(quotaPolicy.retry, 2, 'quota policy allows bounded retries before fallback')

  const authPolicy = policyFor('auth')
  assert.ok(authPolicy, 'auth policy must be defined')
  assert.equal(authPolicy.fallback, false, 'auth failure must NOT fall back to next candidate')
  assert.equal(authPolicy.retry, false, 'auth failure must NOT retry')
  assert.equal(authPolicy.escalation, 'human', 'auth failure must escalate directly to human')

  const billingPolicy = policyFor('billing')
  assert.ok(billingPolicy, 'billing policy must be defined')
  assert.equal(billingPolicy.fallback, false, 'billing failure must NOT fall back to next candidate')
  assert.equal(billingPolicy.retry, false, 'billing failure must NOT retry')
  assert.equal(billingPolicy.escalation, 'human', 'billing failure must escalate directly to human')
})

test('executeWithPolicy (honest unit): quota failure retries then falls back to next candidate', async () => {
  const stagesExecuted = []
  const primaryCandidate = { agent: 'agy', model: 'gemini-3.8-flash-low' }
  const fallbackCandidate = { agent: 'opencode', model: 'muse-spark-1.3-contributor-free' }
  const fallbacks = [{ ...fallbackCandidate }]

  let callCount = 0
  const taskFn = async (activeCtx) => {
    callCount++
    if (activeCtx.candidate.agent === 'agy') {
      const err = new Error('Resource exhausted: 429 quota exceeded')
      err.errorKind = 'quota'
      err.status = 429
      throw err
    }
    return { ok: true, candidate: activeCtx.candidate, calls: callCount }
  }

  const result = await executeWithPolicy(taskFn, 'quota', {
    candidate: primaryCandidate,
    fallbacks,
    onRetry: async ({ attempt }) => {
      stagesExecuted.push({ stage: 'retry', attempt })
    },
    onFallback: async ({ candidate }) => {
      stagesExecuted.push({ stage: 'fallback', candidate })
    },
    onEscalate: async ({ escalation }) => {
      stagesExecuted.push({ stage: 'escalate', escalation })
      throw new Error(`Escalated to ${escalation}`)
    },
  })

  assert.equal(result.ok, true)
  assert.equal(result.candidate.agent, 'opencode', 'result candidate must be the fallback candidate')
  assert.deepEqual(
    stagesExecuted.map((s) => s.stage),
    ['retry', 'retry', 'fallback'],
    'quota must execute bounded retries then fall back'
  )
  assert.equal(stagesExecuted[2].candidate.agent, 'opencode')
})

test('executeWithPolicy (honest unit): auth failure does NOT fall back and escalates to human immediately', async () => {
  const stagesExecuted = []
  const primaryCandidate = { agent: 'agy', model: 'gemini-3.8-flash-low' }
  const fallbackCandidate = { agent: 'opencode', model: 'muse-spark-1.3-contributor-free' }
  const fallbacks = [{ ...fallbackCandidate }]

  let taskCalls = 0
  const taskFn = async (activeCtx) => {
    taskCalls++
    const err = new Error('401 Unauthorized: Invalid API key')
    err.errorKind = 'auth'
    err.status = 401
    throw err
  }

  let escalationObserved = null
  try {
    await executeWithPolicy(taskFn, 'auth', {
      candidate: primaryCandidate,
      fallbacks,
      onRetry: async () => stagesExecuted.push('retry'),
      onFallback: async () => stagesExecuted.push('fallback'),
      onEscalate: async ({ escalation, error }) => {
        stagesExecuted.push('escalate')
        escalationObserved = escalation
        const err = new Error(`Escalated to ${escalation}: ${error.message}`)
        err.escalation = escalation
        throw err
      },
    })
    assert.fail('executeWithPolicy should have escalated and thrown')
  } catch (err) {
    assert.equal(err.escalation, 'human', 'auth error must escalate to human')
  }

  assert.equal(taskCalls, 1, 'taskFn must only be called once on auth error')
  assert.deepEqual(stagesExecuted, ['escalate'], 'auth failure must NOT retry or fall back, only escalate')
  assert.equal(fallbacks.length, 1, 'fallback candidate must remain untouched')
  assert.equal(escalationObserved, 'human')
})

test('executeWithPolicy (honest unit): billing failure does NOT fall back and escalates to human immediately', async () => {
  const stagesExecuted = []
  const primaryCandidate = { agent: 'codex', model: 'default' }
  const fallbackCandidate = { agent: 'opencode', model: 'muse-spark-1.3-contributor-free' }
  const fallbacks = [{ ...fallbackCandidate }]

  let taskCalls = 0
  const taskFn = async () => {
    taskCalls++
    const err = new Error('402 Payment Required: Out of credits')
    err.errorKind = 'billing'
    err.status = 402
    throw err
  }

  let escalationObserved = null
  try {
    await executeWithPolicy(taskFn, 'billing', {
      candidate: primaryCandidate,
      fallbacks,
      onRetry: async () => stagesExecuted.push('retry'),
      onFallback: async () => stagesExecuted.push('fallback'),
      onEscalate: async ({ escalation, error }) => {
        stagesExecuted.push('escalate')
        escalationObserved = escalation
        const err = new Error(`Escalated to ${escalation}: ${error.message}`)
        err.escalation = escalation
        throw err
      },
    })
    assert.fail('executeWithPolicy should have escalated and thrown')
  } catch (err) {
    assert.equal(err.escalation, 'human', 'billing error must escalate to human')
  }

  assert.equal(taskCalls, 1, 'taskFn must only be called once on billing error')
  assert.deepEqual(stagesExecuted, ['escalate'], 'billing failure must NOT retry or fall back, only escalate')
  assert.equal(fallbacks.length, 1, 'fallback candidate must remain untouched')
  assert.equal(escalationObserved, 'human')
})

test('dispatch(): quota classified failure falls back to next candidate while auth/billing escalates to human', async () => {
  const home = makeTempHome()
  const env = { ...process.env, AGENT_HUB_HOME: home }

  const primary = { agent: 'agy', model: 'gemini-3.8-flash-low' }
  const fallback = { agent: 'opencode', model: 'muse-spark-1.3-contributor-free' }

  try {
    // 1. Quota failure falls back to next candidate
    const invokedCandidatesQuota = []
    const startJobQuota = async (args) => {
      invokedCandidatesQuota.push(args.agent)
      if (args.agent === 'agy') {
        const err = new Error('429 Too Many Requests: quota exceeded')
        err.status = 429
        err.errorKind = 'quota'
        throw err
      }
      return {
        job: {
          jobId: 'job-quota-fallback',
          agent: args.agent,
          model: args.model,
          status: 'queued',
          createdAt: new Date().toISOString(),
        },
        done: Promise.resolve(),
      }
    }

    const quotaResult = await dispatch({
      task: 'chaos quota fallback test',
      taskType: 'recon',
      cwd: '/tmp/chaos-quota-cwd',
      mode: 'read',
      env,
      startJobFn: startJobQuota,
      routeFn: async () => ({ primary, fallbacks: [fallback] }),
      runPreflightFn: async () => ({ status: 'ready' }),
      circuitBreakerOpenFn: () => false,
    })

    assert.equal(quotaResult.job.agent, 'opencode', 'job should have succeeded with fallback candidate')
    assert.ok(invokedCandidatesQuota.includes('agy'), 'primary candidate agy must have been attempted')
    assert.ok(invokedCandidatesQuota.includes('opencode'), 'fallback candidate opencode must have been called')

    // 2. Auth failure escalates to human without calling fallback
    const invokedCandidatesAuth = []
    const startJobAuth = async (args) => {
      invokedCandidatesAuth.push(args.agent)
      const err = new Error('401 Unauthorized: bad key')
      err.status = 401
      err.errorKind = 'auth'
      throw err
    }

    await assert.rejects(
      async () => {
        await dispatch({
          task: 'chaos auth failure test',
          taskType: 'recon',
          cwd: '/tmp/chaos-auth-cwd',
          mode: 'read',
          env,
          startJobFn: startJobAuth,
          routeFn: async () => ({ primary, fallbacks: [fallback] }),
          runPreflightFn: async () => ({ status: 'ready' }),
          circuitBreakerOpenFn: () => false,
        })
      },
      (err) => {
        assert.equal(err.escalation, 'human', 'auth error must escalate to human')
        return true
      }
    )
    assert.deepEqual(invokedCandidatesAuth, ['agy'], 'auth failure must NOT invoke fallback candidate')

    // 3. Billing failure escalates to human without calling fallback
    const invokedCandidatesBilling = []
    const startJobBilling = async (args) => {
      invokedCandidatesBilling.push(args.agent)
      const err = new Error('402 Payment Required: card expired')
      err.status = 402
      err.errorKind = 'billing'
      throw err
    }

    await assert.rejects(
      async () => {
        await dispatch({
          task: 'chaos billing failure test',
          taskType: 'recon',
          cwd: '/tmp/chaos-billing-cwd',
          mode: 'read',
          env,
          startJobFn: startJobBilling,
          routeFn: async () => ({ primary, fallbacks: [fallback] }),
          runPreflightFn: async () => ({ status: 'ready' }),
          circuitBreakerOpenFn: () => false,
        })
      },
      (err) => {
        assert.equal(err.escalation, 'human', 'billing error must escalate to human')
        return true
      }
    )
    assert.deepEqual(invokedCandidatesBilling, ['agy'], 'billing failure must NOT invoke fallback candidate')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test("every candidate unavailable: route() reports primary null and dispatch() rejects", async () => {
  const home = makeTempHome()
  const env = { ...process.env, AGENT_HUB_HOME: home }

  try {
    // 1. route() reports primary: null when all candidates are excluded / unavailable
    const routeRes = await route({
      taskType: 'triage',
      requirements: ['non_existent_capability_xyz'],
      env,
    })

    assert.equal(routeRes.primary, null, 'route() must return primary: null when no candidates are usable')
    assert.deepEqual(routeRes.fallbacks, [], 'fallbacks must be empty when primary is null')
    assert.match(routeRes.reason, /every candidate for "triage" is unavailable/, 'reason must state all candidates unavailable')

    // 2. dispatch() reports primary null / rejects when route reports primary: null
    await assert.rejects(
      async () => {
        await dispatch({
          task: 'chaos all candidates unavailable test',
          taskType: 'triage',
          cwd: '/tmp/chaos-unavailable-cwd',
          mode: 'read',
          env,
          routeFn: async () => routeRes,
          runPreflightFn: async () => ({ status: 'ready' }),
          circuitBreakerOpenFn: () => false,
        })
      },
      (err) => {
        assert.match(err.message, /every candidate for "triage" is unavailable/i)
        return true
      }
    )
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})
