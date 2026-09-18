import { policyFor } from './registry.mjs'
import { classifyError } from './taxonomy.mjs'

/**
 * Recovery pipeline stages in default order: retry -> resume -> fallback ->
 * escalate. See recoveryStageOrder() for the adapter-aware override.
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
 * Drives a single recovery loop when taskFn fails, according to policy rules.
 * Stage order defaults to retry -> resume -> fallback -> escalate, but a
 * caller may pass ctx.recoveryOrder (e.g. a remote adapter that must
 * resume/reconcile the existing session BEFORE any retry that would create a
 * duplicate: ['resume', 'fallback', 'retry', 'escalate']). Unknown names are
 * ignored; stages missing from the order keep their relative default order
 * at the end. Escalation always stays last — it ends the loop.
 *
 * @param {Function} taskFn Async task function receiving (context)
 * @param {object|string} policy Policy object or category string
 * @param {object} [ctx={}] Execution context
 * @returns {Promise<any>}
 */
export function recoveryStageOrder(ctx = {}) {
  const names = RECOVERY_STAGES.map((s) => s.name)
  const requested = Array.isArray(ctx?.recoveryOrder) ? ctx.recoveryOrder.filter((n) => names.includes(n) && n !== 'escalate') : []
  const ordered = [...requested]
  for (const name of names) {
    if (name !== 'escalate' && !ordered.includes(name)) ordered.push(name)
  }
  ordered.push('escalate')
  return ordered.map((name) => RECOVERY_STAGES.find((s) => s.name === name))
}

export async function executeWithPolicy(taskFn, policy, ctx = {}) {
  const stages = recoveryStageOrder(ctx)

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
        err.errorKind = result.errorKind ?? result.job?.errorKind
        if (result.sessionId) err.sessionId = result.sessionId
        else if (result.job?.sessionId) err.sessionId = result.job.sessionId
        else if (result.job?.remote?.sessionId) err.sessionId = result.job.remote.sessionId
        throw err
      }
      return result
    } catch (err) {
      state.lastError = err
      if (err?.sessionId) state.sessionId = err.sessionId
      if (err?.result?.sessionId) state.sessionId = err.result.sessionId
      if (err?.result?.job?.sessionId) state.sessionId = err.result.job.sessionId
      if (err?.result?.job?.remote?.sessionId) state.sessionId = err.result.job.remote.sessionId

      // Post-error policy resolution per attempt
      let activePolicy
      if (typeof policy === 'function') {
        activePolicy = policy(err, ctx, state)
      } else if (policy && typeof policy === 'object') {
        activePolicy = policy
      } else {
        const cat = (typeof policy === 'string' && policy) ? policy : classifyError(err, {
          errorKind: err?.errorKind ?? err?.result?.errorKind ?? err?.result?.job?.errorKind,
          status: err?.status ?? err?.statusCode ?? err?.result?.status ?? err?.result?.job?.status,
          category: err?.category ?? err?.result?.category,
        })
        activePolicy = (cat ? (ctx?.policyForFn ?? ctx?.policyFor ?? policyFor)(cat) : null) ?? (policyFor('default') || {
          retry: 1,
          resume: false,
          fallback: true,
          escalation: 'human',
        })
      }

      // Single loop through recovery stages in the caller's (or default)
      // order: retry -> resume -> fallback -> escalate unless recoveryOrder
      // says otherwise (remote adapters resume first).
      const stage = stages.find((s) => s.isApplicable(activePolicy, ctx, state, err))
      if (!stage) {
        throw err
      }

      const outcome = await stage.execute(activePolicy, ctx, state, err)
      if (outcome?.action === 'continue') {
        continue
      }
      return outcome
    }
  }
}
