import { bridgeSupportsWake } from './bridge.mjs'

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
  // C1.2: mapping-only (see src/harness/origin.mjs). No wake-up bridge
  // exists yet, so no profile supports waking its harness session.
  supportsWake: bridgeSupportsWake('opencode'),
}
