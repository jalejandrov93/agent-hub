/**
 * Claude Code harness profile: the harness suspends on attention and the
 * caller continues explicitly, so dispatch() observes until terminal OR
 * waiting/attention by default (waitMode 'attention').
 */
export const claudeCode = {
  id: 'claude-code',
  delegation: {
    defaultWaitMode: 'attention',
    preferredWaitTool: 'job_wait',
  },
  behavior: {
    requiresExplicitContinuation: true,
  },
}
