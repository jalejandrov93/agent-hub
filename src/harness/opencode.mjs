/**
 * OpenCode harness profile: same continuation contract as Claude Code —
 * dispatch() observes until terminal OR waiting/attention by default.
 */
export const opencode = {
  id: 'opencode',
  delegation: {
    defaultWaitMode: 'attention',
    preferredWaitTool: 'job_wait',
  },
  behavior: {
    requiresExplicitContinuation: true,
  },
}
