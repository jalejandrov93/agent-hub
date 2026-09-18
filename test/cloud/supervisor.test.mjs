import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  acquireWatch,
  releaseWatch,
  classifyFeedback,
  supervise,
  julesSuperviseTool,
} from '../../src/cloud/jules/supervisor.mjs'
import { julesWait, interactWithSession } from '../../src/tools/jules.mjs'
import { RemoteInfo, JulesSuperviseResponse } from '../../src/schemas.mjs'

// ─── 1. Schema typing ─────────────────────────────────────────────────────────

test('RemoteInfo parses watch lease with owner and generation', () => {
  const validLease = RemoteInfo.parse({
    provider: 'jules',
    sessionId: 's-1',
    watch: { owner: 'supervisor', generation: 1 },
  })
  assert.equal(validLease.watch.owner, 'supervisor')
  assert.equal(validLease.watch.generation, 1)

  const nullLease = RemoteInfo.parse({
    provider: 'jules',
    sessionId: 's-1',
    watch: null,
  })
  assert.equal(nullLease.watch, null)

  const emptyLease = RemoteInfo.parse({
    provider: 'jules',
    sessionId: 's-1',
  })
  assert.equal(emptyLease.watch, undefined)
})

// ─── 2. Mandatory Test a: Watch lease acquisition, bump and protection ────────

test('mandatory a) A adquiere gen1, B falla, A interactua, B no sobrescribe', async () => {
  let record = {
    jobId: 'job-1',
    status: 'running',
    remote: {
      provider: 'jules',
      sessionId: 's-1',
      attempts: 0,
      interventionCount: 0,
      autoReplyCount: 0,
      planApprovalCount: 0,
      watch: null,
    },
  }

  const updateResultFn = (jobId, patch) => {
    record = {
      ...record,
      ...patch,
      remote: {
        ...record.remote,
        ...(patch.remote ?? {}),
      },
    }
  }
  const readResultFn = () => record

  // 1. A acquires gen 1
  const resA1 = acquireWatch({ record, owner: 'A', updateResultFn, jobId: 'job-1' })
  assert.equal(resA1.acquired, true)
  assert.equal(resA1.generation, 1)
  assert.deepEqual(record.remote.watch, { owner: 'A', generation: 1 })

  // 2. B tries to acquire while A is active -> fails
  const resB1 = acquireWatch({ record, owner: 'B', updateResultFn, jobId: 'job-1' })
  assert.equal(resB1.acquired, false)
  assert.match(resB1.reason, /watch owned by 'A'/)
  assert.deepEqual(record.remote.watch, { owner: 'A', generation: 1 })

  // Same owner A re-acquires -> bumps generation
  const resA2 = acquireWatch({ record, owner: 'A', updateResultFn, jobId: 'job-1' })
  assert.equal(resA2.acquired, true)
  assert.equal(resA2.generation, 2)
  assert.deepEqual(record.remote.watch, { owner: 'A', generation: 2 })

  // 3. A interacts -> watch lease is preserved
  const client = {
    sendMessage: async () => {},
  }
  await interactWithSession({
    jobId: 'job-1',
    action: 'reply',
    message: 'proceed with approach',
    client,
    readResultFn,
    updateResultFn,
    env: { JULES_API_KEY: 'test-key' },
  })
  assert.equal(record.remote.autoReplyCount, 1)
  assert.deepEqual(record.remote.watch, { owner: 'A', generation: 2 }, 'interact must preserve watch lease')

  // 4. B cannot release A\'s lease
  const resBRelease = releaseWatch({ record, owner: 'B', generation: 2, updateResultFn, jobId: 'job-1' })
  assert.equal(resBRelease.released, false)
  assert.deepEqual(record.remote.watch, { owner: 'A', generation: 2 })

  // Stale release by A (gen 1 when current is gen 2) fails
  const resAStaleRelease = releaseWatch({ record, owner: 'A', generation: 1, updateResultFn, jobId: 'job-1' })
  assert.equal(resAStaleRelease.released, false)
  assert.deepEqual(record.remote.watch, { owner: 'A', generation: 2 })

  // Correct release by A releases the watch
  const resARelease = releaseWatch({ record, owner: 'A', generation: 2, updateResultFn, jobId: 'job-1' })
  assert.equal(resARelease.released, true)
  assert.equal(record.remote.watch, null)

  // Now B can acquire
  const resB2 = acquireWatch({ record, owner: 'B', updateResultFn, jobId: 'job-1' })
  assert.equal(resB2.acquired, true)
  assert.equal(resB2.generation, 1)
  assert.deepEqual(record.remote.watch, { owner: 'B', generation: 1 })
})

// ─── 3. Mandatory Test b: 6 Hard gates classifyFeedback ────────────────────────

test('mandatory b) gates bloquean negocio/secretos -> request_user and classify all 6 gates', () => {
  // Gate 4: secrets
  const secret1 = classifyFeedback({ lastAgentMessage: 'Could you share the AWS API_KEY and secret token?' })
  assert.equal(secret1.decision, 'request_user')
  assert.equal(secret1.gate, 'secrets')

  const secret2 = classifyFeedback({ lastAgentMessage: 'What is the SSH_KEY or password for deployment?' })
  assert.equal(secret2.decision, 'request_user')
  assert.equal(secret2.gate, 'secrets')

  // Gate 3: product / business
  const biz1 = classifyFeedback({ lastAgentMessage: 'Should we change the pricing model or brand color palette?' })
  assert.equal(biz1.decision, 'request_user')
  assert.equal(biz1.gate, 'business_decision')

  const biz2 = classifyFeedback({ lastAgentMessage: 'Is this UX decision approved by product owner?' })
  assert.equal(biz2.decision, 'request_user')
  assert.equal(biz2.gate, 'business_decision')

  // Gate 2: alters objectives
  const obj1 = classifyFeedback({ lastAgentMessage: 'Should we do this instead of the original requirements?' })
  assert.equal(obj1.decision, 'request_user')
  assert.equal(obj1.gate, 'objective_change')

  // Gate 5: changes scope
  const scope1 = classifyFeedback({ lastAgentMessage: 'Should we also add a new payment gateway feature?' })
  assert.equal(scope1.decision, 'request_user')
  assert.equal(scope1.gate, 'scope_change')

  const scope2 = classifyFeedback({ lastAgentMessage: 'Should we expand the scope to include mobile styling?' })
  assert.equal(scope2.decision, 'request_user')
  assert.equal(scope2.gate, 'scope_change')

  // Gate 1: unambiguous (single concrete question with obvious technical answer)
  const multiQ = classifyFeedback({ lastAgentMessage: 'Should I use Tabs? Or should I use Accordion?' })
  assert.equal(multiQ.decision, 'request_user')
  assert.equal(multiQ.gate, 'ambiguous')

  const noQ = classifyFeedback({ lastAgentMessage: 'I am not sure how to continue with this file.' })
  assert.equal(noQ.decision, 'request_user')
  assert.equal(noQ.gate, 'ambiguous')

  // Gate 6: budget exhausted
  const budget = classifyFeedback({
    lastAgentMessage: 'Should I proceed with standard error handling?',
    attempts: 2,
    maxAttempts: 2,
  })
  assert.equal(budget.decision, 'request_user')
  assert.equal(budget.gate, 'budget_exhausted')

  // Valid unambiguous question passing all 6 gates
  const valid = classifyFeedback({
    lastAgentMessage: 'Should I use snake_case or camelCase for the internal helper function?',
    attempts: 0,
    maxAttempts: 2,
  })
  assert.equal(valid.decision, 'auto_reply')
  assert.equal(valid.gate, null)
  assert.ok(valid.response.length > 0)
})

// ─── 4. Mandatory Test c: maxAutoReplies=2 corta al tercero ────────────────────

test('mandatory c) maxAutoReplies=2 corta al tercero', async () => {
  let autoReplyCalls = 0
  const interactCalls = []

  let record = {
    jobId: 'job-budget',
    status: 'running',
    remote: {
      sessionId: 's-budget',
      autoReplyCount: 0,
      planApprovalCount: 0,
      watch: null,
    },
  }

  const readResultFn = () => record
  const updateResultFn = (id, patch) => {
    record = {
      ...record,
      ...patch,
      remote: { ...record.remote, ...(patch.remote ?? {}) },
    }
  }

  let loopCount = 0
  const checkRemoteSessionFn = async () => {
    loopCount++
    return {
      state: 'AWAITING_USER_FEEDBACK',
      terminal: false,
      attentionRequired: true,
      attentionReason: 'user_feedback',
      recommendedAction: 'send_message',
      lastMessage: 'Should I use camelCase for helper function names?',
    }
  }

  const interactFn = async (args) => {
    interactCalls.push(args)
    if (args.action === 'reply') {
      autoReplyCalls++
      record.remote.autoReplyCount = autoReplyCalls
    }
  }

  const result = await supervise({
    jobId: 'job-budget',
    policy: {
      maxAutoReplies: 2,
      autoResolveFeedback: true,
    },
    timeoutS: 10,
    intervalMs: 10,
    checkRemoteSessionFn,
    interactFn,
    readResultFn,
    updateResultFn,
    sleepFn: async () => {},
  })

  // Exactly 2 auto-replies before stopping on the 3rd attempt
  assert.equal(autoReplyCalls, 2)
  assert.equal(interactCalls.length, 2)
  assert.equal(result.outcome, 'budget_exhausted')
  assert.equal(result.autoReplyCount, 2)
  assert.equal(result.attentionRequired, true)
  assert.equal(result.attentionReason, 'user_feedback')
  JulesSuperviseResponse.parse(result)
})

// ─── 5. Mandatory Test d: plan approval no consume autoReplyCount ─────────────

test('mandatory d) plan approval no consume autoReplyCount', async () => {
  let record = {
    jobId: 'job-plan',
    status: 'running',
    remote: {
      sessionId: 's-plan',
      autoReplyCount: 0,
      planApprovalCount: 0,
      watch: null,
    },
  }

  const readResultFn = () => record
  const updateResultFn = (id, patch) => {
    record = {
      ...record,
      ...patch,
      remote: { ...record.remote, ...(patch.remote ?? {}) },
    }
  }

  let step = 0
  const checkRemoteSessionFn = async () => {
    step++
    if (step === 1) {
      return {
        state: 'AWAITING_PLAN_APPROVAL',
        terminal: false,
        attentionRequired: true,
        attentionReason: 'plan_approval',
        recommendedAction: 'approve_plan',
      }
    }
    if (step === 2) {
      return {
        state: 'AWAITING_USER_FEEDBACK',
        terminal: false,
        attentionRequired: true,
        attentionReason: 'user_feedback',
        recommendedAction: 'send_message',
        lastMessage: 'Should I follow the standard error handling pattern?',
      }
    }
    return {
      state: 'COMPLETED',
      terminal: true,
      attentionRequired: false,
      prUrl: 'https://github.com/org/repo/pull/42',
    }
  }

  const actions = []
  const interactFn = async (args) => {
    actions.push(args.action)
    if (args.action === 'approve_plan') {
      record.remote.planApprovalCount = (record.remote.planApprovalCount ?? 0) + 1
    } else if (args.action === 'reply') {
      record.remote.autoReplyCount = (record.remote.autoReplyCount ?? 0) + 1
    }
  }

  const result = await supervise({
    jobId: 'job-plan',
    policy: {
      autoApprovePlan: true,
      autoResolveFeedback: true,
      maxAutoReplies: 2,
    },
    timeoutS: 10,
    intervalMs: 10,
    checkRemoteSessionFn,
    interactFn,
    readResultFn,
    updateResultFn,
    sleepFn: async () => {},
  })

  assert.deepEqual(actions, ['approve_plan', 'reply'])
  assert.equal(result.planApprovalCount, 1)
  assert.equal(result.autoReplyCount, 1, 'plan approval must not consume autoReplyCount')
  assert.equal(result.outcome, 'terminal')
  assert.equal(result.state, 'COMPLETED')
  JulesSuperviseResponse.parse(result)
})

// ─── 6. Mandatory Test e: PAUSED nunca dispara approve/reply ──────────────────

test('mandatory e) PAUSED sin approve/reply', async () => {
  let interactCalled = false
  const checkRemoteSessionFn = async () => ({
    state: 'PAUSED',
    terminal: false,
    attentionRequired: true,
    attentionReason: 'paused',
    recommendedAction: null,
  })

  const interactFn = async () => {
    interactCalled = true
  }

  let record = {
    jobId: 'job-paused',
    status: 'running',
    remote: { sessionId: 's-paused', watch: null },
  }
  const readResultFn = () => record
  const updateResultFn = (id, patch) => {
    record = { ...record, ...patch }
  }

  const result = await supervise({
    jobId: 'job-paused',
    policy: {
      autoApprovePlan: true,
      autoResolveFeedback: true,
    },
    timeoutS: 10,
    checkRemoteSessionFn,
    interactFn,
    readResultFn,
    updateResultFn,
    sleepFn: async () => {},
  })

  assert.equal(interactCalled, false, 'PAUSED must never trigger approve or reply')
  assert.equal(result.outcome, 'paused')
  assert.equal(result.state, 'PAUSED')
  assert.equal(result.attentionRequired, true)
  assert.equal(result.attentionReason, 'paused')
  assert.equal(result.recommendedAction, null)
  JulesSuperviseResponse.parse(result)
})

// ─── 7. julesWait respeta lease ajeno ─────────────────────────────────────────

test('julesWait respeta lease ajeno: observa read-only sin finalizar ni mutar', async () => {
  let finishCalled = false
  let updateCalled = false

  const record = {
    jobId: 'job-foreign',
    status: 'running',
    remote: {
      sessionId: 's-foreign',
      watch: { owner: 'supervisor', generation: 1 },
    },
  }

  const readResultFn = () => record
  const finishRemoteJobFn = () => {
    finishCalled = true
  }
  const updateResultFn = () => {
    updateCalled = true
  }

  // checkRemoteSession wrapper that tests whether finishRemoteJobFn and updateResultFn
  // were neutralized by julesWait
  const checkRemoteSessionFn = async (args) => {
    // Attempt to invoke the passed callbacks as checkRemoteSession normally would
    args.finishRemoteJobFn?.()
    args.updateResultFn?.()
    return {
      state: 'COMPLETED',
      terminal: true,
    }
  }

  const res = await julesWait({
    jobId: 'job-foreign',
    checkRemoteSessionFn,
    readResultFn,
    finishRemoteJobFn,
    updateResultFn,
    sleepFn: async () => {},
  })

  assert.equal(res.done, true)
  assert.equal(res.terminal, true)
  assert.equal(finishCalled, false, 'foreign lease must prevent finalization by julesWait')
  assert.equal(updateCalled, false, 'foreign lease must prevent mutation by julesWait')
})

// ─── 8. Supervisor loop terminal & timeout outcomes ───────────────────────────

test('supervise returns terminal when session is completed and releases watch', async () => {
  let record = {
    jobId: 'job-term',
    status: 'running',
    remote: {
      sessionId: 's-term',
      watch: null,
    },
  }
  const readResultFn = () => record
  const updateResultFn = (id, patch) => {
    record = { ...record, ...patch, remote: { ...record.remote, ...(patch.remote ?? {}) } }
  }

  const checkRemoteSessionFn = async () => ({
    state: 'COMPLETED',
    terminal: true,
    prUrl: 'https://github.com/org/repo/pull/1',
  })

  const res = await supervise({
    jobId: 'job-term',
    checkRemoteSessionFn,
    readResultFn,
    updateResultFn,
    sleepFn: async () => {},
  })

  assert.equal(res.outcome, 'terminal')
  assert.equal(res.terminal, true)
  assert.equal(res.prUrl, 'https://github.com/org/repo/pull/1')
  assert.equal(record.remote.watch, null, 'watch lease should be released on completion')
  JulesSuperviseResponse.parse(res)
})

test('supervise detects stale generation during loop and stops writing', async () => {
  let record = {
    jobId: 'job-stale',
    status: 'running',
    remote: {
      sessionId: 's-stale',
      watch: null,
    },
  }
  const readResultFn = () => record
  const updateResultFn = (id, patch) => {
    record = { ...record, ...patch, remote: { ...record.remote, ...(patch.remote ?? {}) } }
  }

  let interactCalled = false
  let count = 0
  const checkRemoteSessionFn = async () => {
    count++
    if (count === 1) {
      // Simulate another process stealing the lease
      record.remote.watch = { owner: 'supervisor-2', generation: 99 }
      return {
        state: 'AWAITING_PLAN_APPROVAL',
        terminal: false,
        attentionRequired: true,
        attentionReason: 'plan_approval',
      }
    }
    return { state: 'COMPLETED', terminal: true }
  }

  const res = await supervise({
    jobId: 'job-stale',
    owner: 'supervisor-1',
    checkRemoteSessionFn,
    interactFn: async () => { interactCalled = true },
    readResultFn,
    updateResultFn,
    sleepFn: async () => {},
  })

  assert.equal(interactCalled, false, 'must not interact when generation is stale')
  assert.equal(res.outcome, 'attention')
})
