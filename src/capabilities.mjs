import { MODEL_REGISTRY } from './config.mjs'

export const CAPABILITY_KEYS = Object.freeze([
  'read',
  'write',
  'git',
  'github',
  'web',
  'sessionResume',
  'largeContext',
])

// sessionResume from adapter argv support (agy --conversation, opencode -s, codex exec resume; copilot none)
// github only where the CLI has built-in GitHub access (copilot) or works through GitHub PRs (jules)
// git because every local CLI runs in a checkout
// web is a RESERVED key with no adapter signal today so false everywhere
export const AGENT_CAPABILITIES = Object.freeze({
  // agy: sessionResume via '--conversation'; local git repo checkout; no github CLI or web signal
  agy: Object.freeze({ read: true, write: true, git: true, github: false, web: false, sessionResume: true, largeContext: false }),
  // opencode: sessionResume via '-s'; local git repo checkout; no github CLI or web signal
  opencode: Object.freeze({ read: true, write: true, git: true, github: false, web: false, sessionResume: true, largeContext: false }),
  // codex: sessionResume via 'exec resume'; local git repo checkout; no github CLI or web signal
  codex: Object.freeze({ read: true, write: true, git: true, github: false, web: false, sessionResume: true, largeContext: false }),
  // copilot: built-in GitHub access; no session resume support
  copilot: Object.freeze({ read: true, write: true, git: true, github: true, web: false, sessionResume: false, largeContext: false }),
  // claude: sessionResume supported; local git repo checkout; no github CLI or web signal
  claude: Object.freeze({ read: true, write: true, git: true, github: false, web: false, sessionResume: true, largeContext: false }),
  // jules: unattended background runner creating GitHub PRs; write/git/github only, not read
  jules: Object.freeze({ read: false, write: true, git: true, github: true, web: false, sessionResume: true, largeContext: false }),
})

export function capabilitiesFor(agent, model, { modelRegistry = MODEL_REGISTRY } = {}) {
  if (!agent || !AGENT_CAPABILITIES[agent]) {
    return Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, false]))
  }

  const base = AGENT_CAPABILITIES[agent]
  const strengths = modelRegistry?.[agent]?.[model]?.strengths
  const largeContext = String(strengths ?? '').includes('1M ctx')

  return {
    ...base,
    largeContext,
  }
}

export function hasCapabilities(caps, required = []) {
  if (!Array.isArray(required) || required.length === 0) return true
  return required.every((key) => Boolean(caps?.[key]))
}
