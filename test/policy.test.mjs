import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ERROR_TAXONOMY, classifyError } from '../src/policy/taxonomy.mjs'
import { POLICY_TABLE, policyFor } from '../src/policy/registry.mjs'
import { executeWithPolicy, recoveryStageOrder } from '../src/policy/executor.mjs'

// P0.4: every taxonomy category has an explicit declarative policy, so
// policyFor() never returns null for a classified error.
test('POLICY_TABLE covers every ERROR_TAXONOMY category', () => {
  for (const category of Object.keys(ERROR_TAXONOMY)) {
    const policy = policyFor(category)
    assert.ok(policy, `missing policy for category "${category}"`)
    assert.ok('retry' in policy && 'fallback' in policy && 'escalation' in policy)
  }
  assert.equal(policyFor('no-such-category'), null)
})

test('billing and auth never retry and escalate to a human', () => {
  assert.equal(policyFor('billing').retry, false)
  assert.equal(policyFor('billing').fallback, false)
  assert.equal(policyFor('billing').escalation, 'human')
  assert.equal(policyFor('auth').retry, false)
  assert.equal(policyFor('auth').escalation, 'human')
})

test('recoveryStageOrder defaults to retry -> resume -> fallback -> escalate', () => {
  assert.deepEqual(
    recoveryStageOrder({}).map((s) => s.name),
    ['retry', 'resume', 'fallback', 'escalate']
  )
})

test('recoveryStageOrder honors an adapter-aware override and keeps escalate last', () => {
  // Remote adapters must resume/reconcile before any retry that could
  // create a duplicate session.
  assert.deepEqual(
    recoveryStageOrder({ recoveryOrder: ['resume', 'fallback', 'retry'] }).map((s) => s.name),
    ['resume', 'fallback', 'retry', 'escalate']
  )
  assert.deepEqual(
    recoveryStageOrder({ recoveryOrder: ['escalate', 'bogus', 'retry'] }).map((s) => s.name),
    ['retry', 'resume', 'fallback', 'escalate']
  )
})

test('executeWithPolicy on billing fails fast to human escalation without retrying', async () => {
  let calls = 0
  let caught = null
  try {
    await executeWithPolicy(
      async () => {
        calls++
        throw new Error('402 Insufficient Balance')
      },
      'billing',
      {}
    )
  } catch (err) {
    caught = err
  }
  assert.ok(caught, 'billing must throw')
  assert.equal(calls, 1, 'billing must not be retried')
  assert.equal(caught.escalation, 'human')
})

test('classifyError maps an adapter-reported incomplete turn to the non-retried quality category, like empty', () => {
  assert.equal(classifyError('agy yielded with 1 background task(s) still running', { errorKind: 'incomplete' }), 'quality')
})

test('transport retries once, after a delay long enough for a replaced service to come back', () => {
  const policy = policyFor('transport')
  assert.equal(policy.retry, 1)
  assert.ok(policy.retryDelayMs >= 5000, `retryDelayMs too short: ${policy.retryDelayMs}`)
  assert.equal(policy.fallback, true)
})

test('executeWithPolicy waits retryDelayMs before a retry, then falls back instead of retrying again', async () => {
  const sleeps = []
  const attempts = []
  const result = await executeWithPolicy(
    async (ctx) => {
      attempts.push(ctx.candidate)
      if (ctx.candidate === 'fallback') return { status: 'succeeded' }
      return { status: 'failed', errorKind: 'transport', error: 'Transport' }
    },
    { retry: 1, retryDelayMs: 10_000, resume: false, fallback: true, escalation: 'human' },
    { candidate: 'primary', fallbacks: ['fallback'], sleep: async (ms) => { sleeps.push(ms) } }
  )

  assert.equal(result.status, 'succeeded')
  assert.deepEqual(attempts, ['primary', 'primary', 'fallback'])
  assert.deepEqual(sleeps, [10_000])
})

test('executeWithPolicy does not sleep when the policy has no retryDelayMs', async () => {
  const sleeps = []
  let calls = 0
  await executeWithPolicy(
    async () => (++calls === 1 ? { status: 'failed', errorKind: 'crash' } : { status: 'succeeded' }),
    { retry: 1, resume: false, fallback: false, escalation: 'human' },
    { sleep: async (ms) => { sleeps.push(ms) } }
  )
  assert.equal(calls, 2)
  assert.deepEqual(sleeps, [])
})
