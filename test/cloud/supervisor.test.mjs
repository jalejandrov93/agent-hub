import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  acquireWatch,
  releaseWatch,
  classifyFeedback,
  supervise,
  julesSuperviseTool,
  LeaseConflictError,
} from '../../src/cloud/jules/supervisor.mjs'
import { resultPath } from '../../src/jobstore.mjs'
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

  const updateResultFn = (jobId, patchOrUpdater) => {
    const patch = typeof patchOrUpdater === 'function' ? patchOrUpdater(record) : patchOrUpdater
    record = {
      ...record,
      ...patch,
      remote: {
        ...record.remote,
        ...(patch?.remote ?? {}),
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

  // Now B can acquire -> monotonic generation bumps from 2 to 3, NEVER resets to 1!
  const resB2 = acquireWatch({ record, owner: 'B', updateResultFn, jobId: 'job-1' })
  assert.equal(resB2.acquired, true)
  assert.equal(resB2.generation, 3)
  assert.deepEqual(record.remote.watch, { owner: 'B', generation: 3 })
  assert.equal(record.remote.watchGenerationCounter, 3)
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

// ─── 9. B4.1 Interleaved CAS Tests ──────────────────────────────────────────

test('mandatory interleaved CAS: read of B occurs between read and write of A -> only one wins', () => {
  let store = {
    jobId: 'job-cas-interleave',
    remote: {
      watch: null,
      watchGenerationCounter: 0,
    },
  }

  const ownerA = 'uuid-actor-A'
  const ownerB = 'uuid-actor-B'

  let bObservedSnapshot = null

  // A's updateResultFn simulates:
  // 1. A reads store (watch: null)
  // 2. Before A writes, B also reads store (watch: null)
  // 3. A writes to store (watch: ownerA, gen 1)
  const updateResultFnA = (jobId, updater) => {
    const aReadSnapshot = structuredClone(store)
    bObservedSnapshot = structuredClone(store) // B reads here (between read and write of A)
    const nextA = updater(aReadSnapshot)
    store = {
      ...store,
      ...nextA,
      remote: { ...store.remote, ...nextA.remote },
    }
  }

  // When B's updater runs in CAS, it evaluates against live/locked store
  const updateResultFnB = (jobId, updater) => {
    const nextB = updater(store) // store already has ownerA!
    store = {
      ...store,
      ...nextB,
      remote: { ...store.remote, ...nextB.remote },
    }
  }

  // 1. A executes acquireWatch
  const resA = acquireWatch({
    jobId: 'job-cas-interleave',
    owner: ownerA,
    updateResultFn: updateResultFnA,
  })

  assert.equal(resA.acquired, true)
  assert.equal(resA.generation, 1)
  assert.equal(store.remote.watch.owner, ownerA)

  // Verify B's read indeed observed null before A's write took effect
  assert.equal(bObservedSnapshot.remote.watch, null)

  // 2. B attempts acquireWatch
  const resB = acquireWatch({
    jobId: 'job-cas-interleave',
    owner: ownerB,
    updateResultFn: updateResultFnB,
  })

  // Only A wins! B's updater threw LeaseConflictError and acquireWatch caught it
  assert.equal(resB.acquired, false)
  assert.match(resB.reason, new RegExp(`watch owned by '${ownerA}'`))
  assert.equal(store.remote.watch.owner, ownerA, 'Owner A must not be overwritten')
  assert.equal(store.remote.watch.generation, 1)
})

test('real concurrent acquireWatch with updateJsonLocked on disk: only one winner', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-cas-test-'))
  const env = { AGENT_HUB_HOME: tmpDir }
  const jobId = 'job-disk-cas'
  const file = resultPath(jobId, env)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ jobId, status: 'running', remote: { watch: null, watchGenerationCounter: 0 } }), 'utf8')

  const res1 = acquireWatch({ jobId, owner: 'owner-1', env })
  assert.equal(res1.acquired, true)
  assert.equal(res1.generation, 1)

  const res2 = acquireWatch({ jobId, owner: 'owner-2', env })
  assert.equal(res2.acquired, false)
  assert.match(res2.reason, /watch owned by 'owner-1'/)

  // release by owner-1
  const rel = releaseWatch({ jobId, owner: 'owner-1', generation: 1, env })
  assert.equal(rel.released, true)

  // Now owner-2 acquires -> monotonic generation 2 (never resets to 1)
  const res3 = acquireWatch({ jobId, owner: 'owner-2', env })
  assert.equal(res3.acquired, true)
  assert.equal(res3.generation, 2)

  fs.rmSync(tmpDir, { recursive: true, force: true })
})

// ─── 10. B4.1 3-Level Feedback Classifier ───────────────────────────────────

test('classifyFeedback: AUTO_REPLY allowlist (all 7 categories)', () => {
  const cases = [
    { msg: 'Should I use tabs or spaces for indentation?', category: 'formato' },
    { msg: 'Should I use snake_case or camelCase for the function name?', category: 'naming' },
    { msg: 'What test command should I run: npm test?', category: 'test_command' },
    { msg: 'Should I follow the existing convention in this repo?', category: 'existing_convention' },
    { msg: 'Is the standard import order mechanical detail acceptable?', category: 'mechanical_detail' },
    { msg: 'Should I re-run the tests to verify the suite?', category: 'rerun_tests' },
    { msg: 'Should I follow the same pattern as file src/client.mjs?', category: 'same_pattern' },
  ]

  for (const { msg, category } of cases) {
    const res = classifyFeedback({ lastAgentMessage: msg })
    assert.equal(res.decision, 'auto_reply', `Expected auto_reply for "${msg}"`)
    assert.equal(res.category, category)
    assert.equal(typeof res.confidence, 'number')
    assert.ok(res.confidence > 0.8)
    assert.ok(res.reason.length > 0)
    assert.ok(res.evidence.length > 0)
    assert.ok(res.response && res.response.length > 0)
  }
})

test('classifyFeedback: SAFE_CONTINUE conditional operational blocks (all 5 categories)', () => {
  const cases = [
    { msg: 'Npm warn deprecated dependency found for old package. Proceed?', category: 'obsolete_dependency' },
    { msg: 'Got a foreign warning from external compiler in node_modules. Can I continue?', category: 'foreign_warning' },
    { msg: 'Found pre-existing failing test on main branch unrelated to task. Should I ignore?', category: 'preexisting_test_failure' },
    { msg: 'Eslint blocks CI pipeline on trailing comma style check. Should I fix?', category: 'lint_blocks_pipeline' },
    { msg: 'Received 429 rate limit transient failure from API, should we retry?', category: 'transient_retry' },
  ]

  for (const { msg, category } of cases) {
    const res = classifyFeedback({ lastAgentMessage: msg })
    assert.equal(res.decision, 'safe_continue', `Expected safe_continue for "${msg}"`)
    assert.equal(res.category, category)
    assert.equal(typeof res.confidence, 'number')
    assert.ok(res.confidence >= 0.9)
    assert.ok(res.reason.length > 0)
    assert.ok(res.evidence.length > 0)
    assert.ok(res.response && res.response.length > 0)
  }
})

test('classifyFeedback: REQUEST_USER 10 escalations', () => {
  const escalations = [
    { msg: 'Should we refactor and re-architect the service layer?', category: 'architecture' },
    { msg: 'What authentication or login credentials should we use?', category: 'auth' },
    { msg: 'Please provide the database password and secret api_key?', category: 'secrets' },
    { msg: 'Should we introduce a breaking change in public API signature?', category: 'api_changes' },
    { msg: 'Should I run a database migration to alter table and drop column?', category: 'migrations' },
    { msg: 'Is it safe to delete records or truncate table with user data?', category: 'data' },
    { msg: 'What pricing model and UX decision should we choose?', category: 'business_decision' },
    { msg: 'Should I delete the feature and remove the deprecated module?', category: 'code_deletion' },
    { msg: 'Should we add a heavy major dependency and switch framework?', category: 'impactful_dependencies' },
    { msg: 'Should we also add a new payment gateway feature out of scope?', category: 'scope_change' },
    { msg: 'What do you think we should do next with this code?', category: 'ambiguous_functional' },
  ]

  for (const { msg, category } of escalations) {
    const res = classifyFeedback({ lastAgentMessage: msg })
    assert.equal(res.decision, 'request_user', `Expected request_user for "${msg}"`)
    assert.equal(res.category, category)
    assert.equal(typeof res.confidence, 'number')
    assert.ok(res.reason.length > 0)
    assert.ok(res.evidence.length > 0)
    assert.equal(res.response, null)
  }
})

test('classifyFeedback: budget exhausted transitions to request_user', () => {
  // auto-reply budget exhausted
  const autoExhausted = classifyFeedback({
    lastAgentMessage: 'Should I use snake_case or camelCase for function names?',
    attempts: 2,
    maxAttempts: 2,
  })
  assert.equal(autoExhausted.decision, 'request_user')
  assert.equal(autoExhausted.category, 'budget_exhausted')

  // safe-continue budget exhausted
  const safeExhausted = classifyFeedback({
    lastAgentMessage: 'Transient network failure 429 rate limit encountered, retry?',
    safeContinues: 3,
    maxSafeContinues: 3,
  })
  assert.equal(safeExhausted.decision, 'request_user')
  assert.equal(safeExhausted.category, 'budget_exhausted')
})

test('supervise: separate budgets autoReplyCount/maxAutoReplies=2 and safeContinueCount/maxSafeContinues=3', async () => {
  let record = {
    jobId: 'job-split-budgets',
    status: 'running',
    remote: {
      sessionId: 's-split-budgets',
      autoReplyCount: 0,
      safeContinueCount: 0,
      planApprovalCount: 0,
      watch: null,
    },
  }

  const readResultFn = () => record
  const updateResultFn = (id, patchOrUpdater) => {
    const patch = typeof patchOrUpdater === 'function' ? patchOrUpdater(record) : patchOrUpdater
    record = { ...record, ...patch, remote: { ...record.remote, ...(patch?.remote ?? {}) } }
  }

  let step = 0
  const checkRemoteSessionFn = async () => {
    step++
    if (step <= 2) {
      return {
        state: 'AWAITING_USER_FEEDBACK',
        terminal: false,
        lastMessage: 'Should I use snake_case or camelCase for helper function names?',
      }
    }
    if (step <= 5) {
      return {
        state: 'AWAITING_USER_FEEDBACK',
        terminal: false,
        lastMessage: 'Received 429 rate limit transient failure from API, should we retry?',
      }
    }
    return {
      state: 'COMPLETED',
      terminal: true,
      prUrl: 'https://github.com/org/repo/pull/123',
    }
  }

  const interactCalls = []
  const interactFn = async (args) => {
    interactCalls.push(args)
    if (args.feedbackDecision === 'auto_reply') {
      record.remote.autoReplyCount = (record.remote.autoReplyCount ?? 0) + 1
    } else if (args.feedbackDecision === 'safe_continue') {
      record.remote.safeContinueCount = (record.remote.safeContinueCount ?? 0) + 1
    }
  }

  const result = await supervise({
    jobId: 'job-split-budgets',
    policy: {
      maxAutoReplies: 2,
      maxSafeContinues: 3,
    },
    timeoutS: 10,
    intervalMs: 10,
    checkRemoteSessionFn,
    interactFn,
    readResultFn,
    updateResultFn,
    sleepFn: async () => {},
  })

  // 2 auto-replies + 3 safe-continues occurred without mutual interference
  assert.equal(result.autoReplyCount, 2)
  assert.equal(result.safeContinueCount, 3)
  assert.equal(record.remote.autoReplyCount, 2)
  assert.equal(record.remote.safeContinueCount, 3)
  assert.equal(interactCalls.length, 5)
  assert.equal(result.outcome, 'terminal')
  JulesSuperviseResponse.parse(result)
})

