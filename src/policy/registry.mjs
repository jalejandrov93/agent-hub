/**
 * Policy registry for Fase A execution policies.
 * Maps error categories to recovery policies (retry, resume, fallback, escalation).
 */

export const POLICY_TABLE = {
  timeout: { retry: true, resume: true, fallback: false, escalation: 'verifier' },
  transport: { retry: true, fallback: true },
  auth: { retry: false, fallback: false, escalation: 'human' },
  quality: { retry: false, fallback: true, escalation: 'verifier' },
  'write-conflict': { retry: false, resume: false, escalation: 'human' },
}

/**
 * Returns the ExecutionPolicy for a given error category.
 *
 * @param {string} category
 * @returns {object|null}
 */
export function policyFor(category) {
  return POLICY_TABLE[category] ?? null
}
