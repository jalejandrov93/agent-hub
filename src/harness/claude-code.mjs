import { bridgeSupportsWake } from './bridge.mjs'

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
  // C1.2: mapping-only (see src/harness/origin.mjs). No wake-up bridge
  // exists yet, so no profile supports waking its harness session.
  supportsWake: bridgeSupportsWake('claude-code'),
}
