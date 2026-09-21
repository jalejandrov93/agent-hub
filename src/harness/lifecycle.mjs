import { getOrigin } from './origin.mjs'
import { resolveBridge } from './bridge.mjs'
import { appendEvent } from '../eventlog.mjs'

const MAX_SUMMARY_CHARS = 300

/**
 * Deliver completion/lifecycle notification back to the originating harness.
 *
 * Looks up the harness_origin for the jobId. If no origin exists or the resolved
 * bridge cannot wake, returns { delivered: false, reason } without throwing.
 *
 * When the bridge can wake, calls bridge.wake(origin, payload) with a bounded payload
 * inside try/catch and appends a 'harness.wake' event. NEVER throws.
 */
export async function deliverCompletion({
  jobId,
  event = null,
  summary = null,
  env = process.env,
  getOriginFn = getOrigin,
  bridgeFn = resolveBridge,
  appendEventFn = appendEvent,
} = {}) {
  try {
    if (jobId == null || String(jobId).length === 0) {
      return { delivered: false, reason: 'no-origin' }
    }

    const origin = getOriginFn(String(jobId), { env })
    if (!origin) {
      return { delivered: false, reason: 'no-origin' }
    }

    const bridge = bridgeFn(origin.harness)
    if (!bridge || typeof bridge.canWake !== 'function' || !bridge.canWake()) {
      return { delivered: false, reason: 'cannot-wake' }
    }

    const rawSummary = summary ?? event?.summary ?? null
    const boundedSummary =
      typeof rawSummary === 'string'
        ? rawSummary.slice(0, MAX_SUMMARY_CHARS)
        : null

    const payload = {
      jobId: String(jobId),
      harness: origin.harness ?? null,
      sessionId: origin.harness_session_id ?? null,
      summary: boundedSummary,
    }

    try {
      const outcome = await bridge.wake(origin, payload)
      const delivered = Boolean(outcome?.delivered)
      const reason = outcome?.reason ?? (delivered ? 'delivered' : 'wake-failed')
      try {
        appendEventFn(
          {
            kind: 'harness.wake',
            jobId: String(jobId),
            delivered,
            reason,
            harness: origin.harness ?? null,
            sessionId: origin.harness_session_id ?? null,
          },
          { env }
        )
      } catch {
        // Event append error must never fail delivery
      }
      return { delivered, reason }
    } catch (wakeError) {
      const reason = wakeError?.message ?? 'wake-error'
      try {
        appendEventFn(
          {
            kind: 'harness.wake',
            jobId: String(jobId),
            delivered: false,
            reason,
            harness: origin.harness ?? null,
            sessionId: origin.harness_session_id ?? null,
          },
          { env }
        )
      } catch {
        // Event append error must never fail delivery
      }
      return { delivered: false, reason }
    }
  } catch (error) {
    return { delivered: false, reason: error?.message ?? 'unknown-error' }
  }
}
