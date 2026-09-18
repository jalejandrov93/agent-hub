import { policyFor } from './registry.mjs'

/**
 * Ordered recovery pipeline stages: retry -> resume -> fallback -> escalate.
 */
const RECOVERY_STAGES = [
  {
    name: 'retry',
    isApplicable(policy, ctx, state, err) {
      if (!policy?.retry) return false
      // Non-retriable operational errors per execution contract
      if (err?.errorKind === 'canceled' || err?.errorKind === 'worktree_denied' || err?.errorKind === 'read_mode_violation') {
        return false
      }
      const maxRetries = typeof policy.retry === 'number' ? policy.retry : (ctx?.maxRetries ?? 3)
      return state.retryCount < maxRetries
    },
    async execute(policy, ctx, state, err) {
      state.retryCount++
      if (ctx?.onRetry) {
        await ctx.onRetry({ ...ctx, attempt: state.retryCount, error: err })
      }
      return { action: 'continue', stage: 'retry' }
    },
  },
  {
    name: 'resume',
    isApplicable(policy, ctx, state) {
      if (!policy?.resume || state.resumed) return false
      return Boolean(state.sessionId || ctx?.sessionId)
    },
    async execute(policy, ctx, state, err) {
      state.resumed = true
      if (ctx?.onResume) {
        await ctx.onResume({ ...ctx, sessionId: state.sessionId || ctx?.sessionId, error: err })
      }
      return { action: 'continue', stage: 'resume' }
    },
  },
  {
    name: 'fallback',
    isApplicable(policy, ctx, state) {
      if (!policy?.fallback) return false
      return Boolean((ctx?.fallbacks && ctx.fallbacks.length > 0) || ctx?.onFallback)
    },
    async execute(policy, ctx, state, err) {
      if (Array.isArray(ctx?.fallbacks) && ctx.fallbacks.length > 0) {
        state.currentCandidate = ctx.fallbacks.shift()
      }
      if (ctx?.onFallback) {
        await ctx.onFallback({ ...ctx, candidate: state.currentCandidate, error: err })
      }
      return { action: 'continue', stage: 'fallback' }
    },
  },
  {
    name: 'escalate',
    isApplicable(policy, ctx, state) {
      if (!policy?.escalation || state.escalated) return false
      return true
    },
    async execute(policy, ctx, state, err) {
      state.escalated = true
      const target = policy.escalation
      if (ctx?.onEscalate) {
        return ctx.onEscalate({ ...ctx, escalation: target, error: err })
      }
      const escalationError = new Error(`Escalated to ${target}: ${err?.message || err}`)
      escalationError.escalation = target
      escalationError.cause = err
      throw escalationError
    },
  },
]

/**
 * Executes a task within an execution policy boundary.
 *
 * Drives a single recovery loop (retry -> resume -> fallback -> escalate)
 * when taskFn fails, according to policy rules.
 *
 * @param {Function} taskFn Async task function receiving (context)
 * @param {object|string} policy Policy object or category string
 * @param {object} [ctx={}] Execution context
 * @returns {Promise<any>}
 */
export async function executeWithPolicy(taskFn, policy, ctx = {}) {
  const resolvedPolicy = typeof policy === 'string' ? (policyFor(policy) ?? {}) : (policy ?? {})

  const state = {
    retryCount: 0,
    resumed: false,
    escalated: false,
    sessionId: ctx?.sessionId ?? null,
    currentCandidate: ctx?.candidate ?? null,
    lastError: null,
  }

  while (true) {
    try {
      const activeCtx = {
        ...ctx,
        attempt: state.retryCount,
        resumed: state.resumed,
        sessionId: state.sessionId,
        candidate: state.currentCandidate,
      }
      const result = await taskFn(activeCtx)
      if (result && typeof result === 'object' && result.status === 'failed') {
        const err = new Error(result.error || 'Task failed')
        err.result = result
        err.errorKind = result.errorKind
        if (result.sessionId) err.sessionId = result.sessionId
        throw err
      }
      return result
    } catch (err) {
      state.lastError = err
      if (err?.sessionId) state.sessionId = err.sessionId
      if (err?.result?.sessionId) state.sessionId = err.result.sessionId

      // Single loop through recovery stages: retry -> resume -> fallback -> escalate
      const stage = RECOVERY_STAGES.find((s) => s.isApplicable(resolvedPolicy, ctx, state, err))
      if (!stage) {
        throw err
      }

      const outcome = await stage.execute(resolvedPolicy, ctx, state, err)
      if (outcome?.action === 'continue') {
        continue
      }
      return outcome
    }
  }
}
