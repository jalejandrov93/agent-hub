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
}
