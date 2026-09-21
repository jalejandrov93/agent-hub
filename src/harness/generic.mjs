import { bridgeSupportsWake } from './bridge.mjs'

/**
 * Generic harness profile: plain MCP client with no continuation contract.
 * dispatch() returns immediately after create/start (waitMode 'none') and
 * the caller polls explicitly via job_wait/job_status.
 */
export const generic = {
  id: 'generic',
  delegation: {
    defaultWaitMode: 'none',
  },
  behavior: {
    requiresExplicitContinuation: false,
  },
  // C1.2: mapping-only (see src/harness/origin.mjs). No wake-up bridge
  // exists yet, so no profile supports waking its harness session.
  supportsWake: bridgeSupportsWake('generic'),
}
