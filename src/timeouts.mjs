import { resolveTimeoutS } from './config.mjs'

/**
 * Effective timeout for one job: an explicit timeoutS always wins; otherwise
 * the static default from config.mjs, raised (never lowered) from observed
 * p95 latency once there are enough samples.
 *
 * P0 contract stub: pinned by test/v2-contracts.test.mjs. Work package P3
 * replaces the adaptive branch.
 *
 * @returns {{timeoutS: number, source: 'explicit'|'adaptive'|'default', p95Ms: number|null, samples: number}}
 */
export function resolveEffectiveTimeoutS({ agent, model, mode = 'read', taskType = null, explicit, env = process.env } = {}) {
  void mode, taskType, env
  if (explicit != null) return { timeoutS: explicit, source: 'explicit', p95Ms: null, samples: 0 }
  return { timeoutS: resolveTimeoutS(agent, model), source: 'default', p95Ms: null, samples: 0 }
}
