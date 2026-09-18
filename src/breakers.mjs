import { circuitBreakerOpen as legacyCircuitBreakerOpen } from './preflight.mjs'
import { CIRCUIT_BREAKER_BY_CLASS, CIRCUIT_BREAKER, breakerKey } from './config.mjs'
import { classifyError, ERROR_TAXONOMY } from './policy/taxonomy.mjs'
import { readTail } from './eventlog.mjs'
import { readOverrides, overrideKey } from './overrides.mjs'

export { breakerKey }

/**
 * Filter failed events matching a specific agent, model, and error class within the class window.
 *
 * @param {object} params
 * @param {string} params.agent
 * @param {string} params.model
 * @param {string} params.klass Error taxonomy class
 * @param {object} [params.env=process.env]
 * @returns {Array}
 */
export function matchingFailuresByClass({ agent, model, klass, env = process.env }) {
  const config = CIRCUIT_BREAKER_BY_CLASS[klass] || CIRCUIT_BREAKER_BY_CLASS.default || CIRCUIT_BREAKER
  const events = readTail({ n: 2000, env })
  const cutoff = Date.now() - config.windowMs
  const override = readOverrides(env)[overrideKey(agent, model)]
  const breakerResetAt = override?.breakerReset ? new Date(override.breakerReset).getTime() : null

  return events.filter((e) => {
    if (e.kind !== 'job.failed') return false
    if (e.agent !== agent || e.model !== model) return false

    // Determine category of the event failure
    const eventCategory = e.errorClass || classifyError(e.summary || e.error || e.errorKind, { errorKind: e.errorKind, ...e })
    if (eventCategory !== klass) return false

    const ts = new Date(e.ts).getTime()
    if (ts < cutoff) return false
    if (breakerResetAt != null && ts <= breakerResetAt) return false
    return true
  })
}

/**
 * Check if the circuit breaker is open for a specific agent, model, and class.
 *
 * @param {object} params
 * @param {string} params.agent
 * @param {string} params.model
 * @param {string} [params.klass] Error taxonomy class (e.g. 'billing', 'quota', 'timeout')
 * @param {object} [params.env=process.env]
 * @returns {boolean}
 */
export function circuitBreakerOpenByClass({ agent, model, klass, env = process.env }) {
  if (!klass) {
    return legacyCircuitBreakerOpen({ agent, model, env })
  }

  const config = CIRCUIT_BREAKER_BY_CLASS[klass] || CIRCUIT_BREAKER_BY_CLASS.default || CIRCUIT_BREAKER
  const failures = matchingFailuresByClass({ agent, model, klass, env })

  // Check if class or config specifies immediate open on first failure
  const isImmediate = config.immediate || ERROR_TAXONOMY[klass]?.immediate || false
  if (isImmediate && failures.length >= 1) {
    return true
  }

  return failures.length >= config.failureThreshold
}

/**
 * Circuit breaker wrapper that supports class-based checks when `klass` is provided,
 * otherwise delegating to the legacy preflight circuitBreakerOpen.
 *
 * @param {object} params
 * @param {string} params.agent
 * @param {string} params.model
 * @param {string} [params.klass]
 * @param {object} [params.env=process.env]
 * @returns {boolean}
 */
export function circuitBreakerOpen({ agent, model, klass, env = process.env }) {
  if (klass) {
    return circuitBreakerOpenByClass({ agent, model, klass, env })
  }
  return legacyCircuitBreakerOpen({ agent, model, env })
}

/**
 * Breaker status view for a specific class or legacy if klass is omitted.
 *
 * @param {object} params
 * @param {string} params.agent
 * @param {string} params.model
 * @param {string} [params.klass]
 * @param {object} [params.env=process.env]
 * @returns {object}
 */
export function breakerStatus({ agent, model, klass, env = process.env }) {
  if (!klass) {
    const config = CIRCUIT_BREAKER
    const events = readTail({ n: 2000, env })
    const cutoff = Date.now() - config.windowMs
    const override = readOverrides(env)[overrideKey(agent, model)]
    const breakerResetAt = override?.breakerReset ? new Date(override.breakerReset).getTime() : null
    const failures = events.filter((e) => {
      if (e.kind !== 'job.failed') return false
      if (e.agent !== agent || e.model !== model) return false
      if (!CIRCUIT_BREAKER.failureKinds.has(e.errorKind)) return false
      const ts = new Date(e.ts).getTime()
      if (ts < cutoff) return false
      if (breakerResetAt != null && ts <= breakerResetAt) return false
      return true
    })
    const open = failures.some((f) => CIRCUIT_BREAKER.immediateKinds.has(f.errorKind)) || failures.length >= CIRCUIT_BREAKER.failureThreshold
    return { agent, model, klass: null, open, failureCount: failures.length, lastFailureAt: failures.length > 0 ? failures[failures.length - 1].ts : null }
  }

  const failures = matchingFailuresByClass({ agent, model, klass, env })
  const config = CIRCUIT_BREAKER_BY_CLASS[klass] || CIRCUIT_BREAKER_BY_CLASS.default || CIRCUIT_BREAKER
  const isImmediate = config.immediate || ERROR_TAXONOMY[klass]?.immediate || false
  const open = isImmediate ? failures.length >= 1 : failures.length >= config.failureThreshold

  return {
    key: breakerKey(agent, model, klass),
    agent,
    model,
    klass,
    open,
    failureCount: failures.length,
    lastFailureAt: failures.length > 0 ? failures[failures.length - 1].ts : null,
  }
}
