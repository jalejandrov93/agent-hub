import { checkRemoteSession as defaultCheckRemoteSession } from '../check.mjs'
import { interactWithSession as defaultInteractWithSession } from '../../tools/jules.mjs'
import { readResult as defaultReadResult, updateResult as defaultUpdateResult } from '../../jobstore.mjs'
import { listJobs as defaultListJobs } from '../../jobstore.mjs'
import * as defaultClient from './client.mjs'
import * as defaultAdapter from './adapter.mjs'

// ─── Watch lease ─────────────────────────────────────────────────────────────

/**
 * Acquire observation ownership of a remote session. The lease lives at
 * `remote.watch = {owner, generation}` and prevents a supervisor and a
 * concurrent jules_wait from driving the same session.
 *
 * Rules:
 * - watch==null (no lease) or watch.owner matches: acquire, bump generation.
 * - watch.owner is a different owner: fail (another actor is driving).
 */
export function acquireWatch({ record, owner = 'supervisor', updateResultFn = defaultUpdateResult, jobId, env }) {
  const remote = record?.remote ?? {}
  const current = remote.watch ?? null

  if (current != null && current.owner != null && current.owner !== owner) {
    return { acquired: false, reason: `watch owned by '${current.owner}' (generation ${current.generation})` }
  }

  const generation = (current?.generation ?? 0) + 1
  const watch = { owner, generation }
  if (jobId && updateResultFn) {
    updateResultFn(jobId, { remote: { ...remote, watch } }, env)
  }
  return { acquired: true, generation, watch }
}

/**
 * Release the watch lease. Only succeeds when the caller still owns the
 * current generation — a stale release (after someone else acquired) is a
 * no-op, never an error.
 */
export function releaseWatch({ record, owner = 'supervisor', generation, updateResultFn = defaultUpdateResult, jobId, env }) {
  const remote = record?.remote ?? {}
  const current = remote.watch ?? null

  if (current?.owner !== owner || current?.generation !== generation) {
    return { released: false, reason: 'stale generation or different owner' }
  }

  if (jobId && updateResultFn) {
    updateResultFn(jobId, { remote: { ...remote, watch: null } }, env)
  }
  return { released: true }
}

// ─── Feedback classification (6 hard gates) ──────────────────────────────────

/**
 * Classify an AWAITING_USER_FEEDBACK message: can the supervisor auto-reply,
 * or must a human decide? Six hard gates that ALL must pass for auto_reply;
 * any failure → request_user.
 *
 * 1. Unambiguous: a single concrete question with an obvious answer.
 * 2. Does not alter the original objectives.
 * 3. Not a product/business decision (UX, pricing, naming, branding).
 * 4. Does not involve secrets, credentials, or sensitive data.
 * 5. Does not expand or reduce the scope.
 * 6. attempts < max (auto-reply budget not exhausted).
 */
export function classifyFeedback({
  lastAgentMessage,
  originalTask,
  plan,
  attempts = 0,
  maxAttempts = 2,
} = {}) {
  const msg = (lastAgentMessage ?? '').toLowerCase()

  // Gate 6: budget exhausted
  if (attempts >= maxAttempts) {
    return { decision: 'request_user', gate: 'budget_exhausted', response: null }
  }

  // Gate 4: secrets / credentials / sensitive data
  const secretPatterns = /\b(password|secret|credential|api[_-]?key|token|private[_-]?key|ssh[_-]?key|env(?:ironment)?\s*var|oauth|bearer)\b/i
  if (secretPatterns.test(msg)) {
    return { decision: 'request_user', gate: 'secrets', response: null }
  }

  // Gate 3: product / business decision
  const businessPatterns = /\b(pricing|brand|marketing|business|stakeholder|product\s*(?:owner|manager|decision)|ux\s*(?:decision|direction)|naming\s*convention|color\s*(?:scheme|palette)|user\s*(?:experience|interface)\s*(?:decision|choice))\b/i
  if (businessPatterns.test(msg)) {
    return { decision: 'request_user', gate: 'business_decision', response: null }
  }

  // Gate 2: alters original objectives
  const objectivePatterns = /\b(instead\s+of|different\s+goal|change\s+(?:the\s+)?(?:goal|objective|requirements)|pivot|re-?architect|abandon\s+(?:the\s+)?(?:original|initial))\b/i
  if (objectivePatterns.test(msg)) {
    return { decision: 'request_user', gate: 'objective_change', response: null }
  }

  // Gate 5: changes scope
  const scopePatterns = /\b(should\s+(?:i|we)\s+(?:also|additionally)|(?:expand|reduce|change)\s+(?:the\s+)?scope|add(?:ing)?\s+(?:a\s+)?(?:new|additional|extra)\s+feature|out\s+of\s+scope)\b/i
  if (scopePatterns.test(msg)) {
    return { decision: 'request_user', gate: 'scope_change', response: null }
  }

  // Gate 1: must be unambiguous — a concrete question with a clear technical answer.
  // Heuristic: short clarification questions about implementation details that
  // the original task already answers (or that have an obvious default) pass.
  // Multi-part questions, open-ended questions, or questions without an obvious
  // answer fail.
  const hasQuestion = /\?/.test(msg)
  const multiQuestion = (msg.match(/\?/g) || []).length > 1
  if (!hasQuestion || multiQuestion) {
    return { decision: 'request_user', gate: 'ambiguous', response: null }
  }

  // All gates passed — auto-reply with a reference to the original task.
  return {
    decision: 'auto_reply',
    gate: null,
    response: 'Please proceed with the approach that best matches the original task requirements. Use your best judgment for implementation details.',
  }
}

// ─── Supervisor loop ─────────────────────────────────────────────────────────

/**
 * Supervisor loop: observe → decide → interact → resume-observation, owning
 * the watch lease for the entire cycle. The loop runs until the session
 * reaches a terminal state, a PAUSED state, a timeout, or an unresolvable
 * attention need.
 *
 * Uses autoReplyCount (never turnDepth) for the auto-reply budget.
 */
export async function supervise({
  jobId,
  sessionId,
  owner = 'supervisor',
  policy: {
    autoApprovePlan = true,
    autoResolveFeedback = true,
    maxAutoReplies = 2,
    pauseAfterAmbiguity = true,
  } = {},
  timeoutMs,
  timeoutS = 300,
  intervalMs = 3000,
  env = process.env,
  client = defaultClient,
  adapter = defaultAdapter,
  checkRemoteSessionFn = defaultCheckRemoteSession,
  interactFn = defaultInteractWithSession,
  readResultFn = defaultReadResult,
  updateResultFn = defaultUpdateResult,
  listJobsFn = defaultListJobs,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  nowFn = Date.now,
  classifyFn = classifyFeedback,
} = {}) {
  const effectiveTimeoutMs = timeoutMs ?? (timeoutS * 1000)
  const start = nowFn()

  // Resolve job/session
  let resolvedJobId = jobId ?? null
  let resolvedSessionId = sessionId ?? null

  if (jobId) {
    const record = readResultFn(jobId, env)
    resolvedSessionId = sessionId ?? record?.remote?.sessionId ?? null
    if (!resolvedSessionId) throw new Error(`job ${jobId} has no Jules session recorded`)
  } else if (sessionId) {
    let jobs = []
    try { jobs = listJobsFn(env) } catch { /* ignore */ }
    const match = Array.isArray(jobs) ? jobs.find((j) => j?.remote?.sessionId === sessionId) : null
    if (match) resolvedJobId = match.jobId
  }

  if (!resolvedJobId && !resolvedSessionId) {
    throw new Error('jules_supervise requires either jobId or sessionId')
  }

  // Acquire the watch lease
  let watchGeneration = null
  if (resolvedJobId) {
    const record = readResultFn(resolvedJobId, env)
    const result = acquireWatch({ record, owner, updateResultFn, jobId: resolvedJobId, env })
    if (!result.acquired) {
      throw new Error(`cannot acquire watch: ${result.reason}`)
    }
    watchGeneration = result.generation
  }

  let localAutoReplies = 0
  let localPlanApprovals = 0

  const buildResult = (check, outcome) => {
    let currentRecord = null
    if (resolvedJobId) {
      try {
        currentRecord = readResultFn(resolvedJobId, env)
      } catch { /* ignore */ }
    }
    return {
      jobId: resolvedJobId,
      sessionId: resolvedSessionId,
      state: check.state,
      prUrl: check.prUrl ?? null,
      branch: check.branch ?? null,
      sessionUrl: check.sessionUrl ?? null,
      lastMessage: check.lastMessage ?? null,
      terminal: check.terminal ?? false,
      outcome,
      attentionRequired: check.attentionRequired ?? false,
      attentionReason: check.attentionReason ?? null,
      recommendedAction: check.recommendedAction ?? null,
      autoReplyCount: currentRecord?.remote?.autoReplyCount ?? localAutoReplies,
      planApprovalCount: currentRecord?.remote?.planApprovalCount ?? localPlanApprovals,
    }
  }

  const release = () => {
    if (resolvedJobId && watchGeneration != null) {
      try {
        const record = readResultFn(resolvedJobId, env)
        releaseWatch({ record, owner, generation: watchGeneration, updateResultFn, jobId: resolvedJobId, env })
      } catch { /* best-effort */ }
    }
  }

  try {
    while (true) {
      // Check timeout
      if (nowFn() - start >= effectiveTimeoutMs) {
        const check = await checkRemoteSessionFn({ jobId: resolvedJobId, sessionId: resolvedSessionId, env, client, adapter, enrich: true })
        return buildResult(check, 'timeout')
      }

      // Observe
      const check = await checkRemoteSessionFn({
        jobId: resolvedJobId,
        sessionId: resolvedSessionId,
        env,
        client,
        adapter,
        enrich: true,
      })
      const state = check.state

      // Terminal → done
      if (check.terminal || adapter.isTerminalState(state)) {
        return buildResult(check, 'terminal')
      }

      // PAUSED → never auto-resume (no remote resume endpoint exists)
      if (state === 'PAUSED') {
        return buildResult(check, 'paused')
      }

      // AWAITING_PLAN_APPROVAL
      if (state === 'AWAITING_PLAN_APPROVAL') {
        if (autoApprovePlan) {
          // Check for stale generation before writing (execution contract §7)
          if (resolvedJobId && watchGeneration != null) {
            let cur = null
            try { cur = readResultFn(resolvedJobId, env) } catch { /* ignore */ }
            const curWatch = cur?.remote?.watch
            if (curWatch?.owner !== owner || curWatch?.generation !== watchGeneration) {
              return buildResult(check, 'attention')
            }
          }

          // Approve the plan — does NOT consume autoReplyCount
          await interactFn({
            jobId: resolvedJobId,
            sessionId: resolvedSessionId,
            action: 'approve_plan',
            env,
            client,
            readResultFn,
            updateResultFn,
            listJobsFn,
          })
          localPlanApprovals++
          // Continue observing after interaction
          await sleepFn(intervalMs)
          continue
        }
        // Manual plan approval requested
        return buildResult(check, 'attention')
      }

      // AWAITING_USER_FEEDBACK
      if (state === 'AWAITING_USER_FEEDBACK') {
        if (!autoResolveFeedback) {
          return buildResult(check, 'attention')
        }

        // Read current autoReplyCount from the record (budget: always autoReplyCount, never turnDepth)
        let currentRecord = null
        if (resolvedJobId) {
          try {
            currentRecord = readResultFn(resolvedJobId, env)
          } catch { /* ignore */ }
        }
        const currentAutoReplies = currentRecord?.remote?.autoReplyCount ?? localAutoReplies

        // Budget check: autoReplyCount (never turnDepth)
        if (currentAutoReplies >= maxAutoReplies) {
          return buildResult(check, 'budget_exhausted')
        }

        // Classify feedback through the 6 hard gates
        const classification = classifyFn({
          lastAgentMessage: check.lastMessage,
          originalTask: currentRecord?.task ?? null,
          plan: null,
          attempts: currentAutoReplies,
          maxAttempts: maxAutoReplies,
        })

        if (classification.decision === 'auto_reply') {
          // Check for stale generation before writing (execution contract §7)
          if (resolvedJobId && watchGeneration != null) {
            let cur = null
            try { cur = readResultFn(resolvedJobId, env) } catch { /* ignore */ }
            const curWatch = cur?.remote?.watch
            if (curWatch?.owner !== owner || curWatch?.generation !== watchGeneration) {
              return buildResult(check, 'attention')
            }
          }

          // Auto-reply — increments autoReplyCount via interactWithSession
          await interactFn({
            jobId: resolvedJobId,
            sessionId: resolvedSessionId,
            action: 'reply',
            message: classification.response,
            env,
            client,
            readResultFn,
            updateResultFn,
            listJobsFn,
          })
          localAutoReplies++
          // Continue observing
          await sleepFn(intervalMs)
          continue
        }

        // Gates failed → needs human
        if (pauseAfterAmbiguity) {
          return buildResult(check, 'attention')
        }
        await sleepFn(intervalMs)
        continue
      }

      // Still working (IN_PROGRESS, QUEUED, PLANNING) — keep observing
      const elapsed = nowFn() - start
      const remaining = effectiveTimeoutMs - elapsed
      if (remaining <= 0) {
        return buildResult(check, 'timeout')
      }
      await sleepFn(Math.min(intervalMs, remaining))
    }
  } finally {
    release()
  }
}

export async function julesSuperviseTool({
  jobId,
  sessionId,
  owner,
  autoApprovePlan = true,
  autoResolveFeedback = true,
  maxAutoReplies = 2,
  pauseAfterAmbiguity = true,
  policy,
  timeoutS = 300,
  pollIntervalS,
  intervalMs,
  env = process.env,
  client = defaultClient,
  adapter = defaultAdapter,
  checkRemoteSessionFn = defaultCheckRemoteSession,
  interactFn = defaultInteractWithSession,
  readResultFn = defaultReadResult,
  updateResultFn = defaultUpdateResult,
  listJobsFn = defaultListJobs,
  sleepFn,
  nowFn,
  classifyFn,
} = {}) {
  const effectivePolicy = {
    autoApprovePlan: policy?.autoApprovePlan ?? autoApprovePlan,
    autoResolveFeedback: policy?.autoResolveFeedback ?? autoResolveFeedback,
    maxAutoReplies: policy?.maxAutoReplies ?? maxAutoReplies,
    pauseAfterAmbiguity: policy?.pauseAfterAmbiguity ?? pauseAfterAmbiguity,
  }
  return supervise({
    jobId,
    sessionId,
    owner,
    policy: effectivePolicy,
    timeoutS,
    intervalMs: intervalMs ?? (pollIntervalS != null ? pollIntervalS * 1000 : undefined),
    env,
    client,
    adapter,
    checkRemoteSessionFn,
    interactFn,
    readResultFn,
    updateResultFn,
    listJobsFn,
    ...(sleepFn ? { sleepFn } : {}),
    ...(nowFn ? { nowFn } : {}),
    ...(classifyFn ? { classifyFn } : {}),
  })
}

export const jules_supervise = julesSuperviseTool

