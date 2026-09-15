import { readCache, circuitBreakerOpen } from './preflight.mjs'

/**
 * The delegation map from the plan, expressed as ordered candidate chains.
 * Claude subagent tiers are {agent:'claude', model:'haiku'|'sonnet'|'opus'}
 * — the caller (Claude Code itself) runs those via the Agent tool; they are
 * never preflighted or breaker-checked here.
 */
export const DELEGATION_MAP = {
  recon: {
    why: 'proven context compression, cheap refreshable quota',
    chain: [
      { agent: 'agy', model: 'gemini-3.8-flash-low', mode: 'read' },
      { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', mode: 'read' },
      { agent: 'claude', model: 'haiku' },
    ],
  },
  'call-chain-trace': {
    why: 'needs multi-hop reasoning, 1M ctx',
    chain: [
      { agent: 'agy', model: 'gemini-3.8-flash-high', mode: 'read' },
      { agent: 'opencode', model: 'opencode/nemotron-3-ultra-free', mode: 'read' },
      { agent: 'claude', model: 'sonnet' },
    ],
  },
  research: {
    why: 'zero cost, 1M ctx',
    chain: [
      { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', mode: 'read' },
      { agent: 'opencode', model: 'opencode/mimo-v2.5-free', mode: 'read' },
      { agent: 'agy', model: 'gemini-3.8-flash-medium', mode: 'read' },
    ],
  },
  triage: {
    why: 'lowest latency',
    chain: [
      // nemotron-3.5-lightning-free hung indefinitely in live tests (2026-09-11);
      // muse-spark-1.3 is the free model verified to answer.
      { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', mode: 'read' },
      // copilot's --model allowlist is account-specific and unstable (most
      // documented ids were rejected live); 'auto' is the one value verified
      // reliable. See config.mjs MODEL_REGISTRY for accounts that do allow
      // an explicit id.
      { agent: 'copilot', model: 'auto', mode: 'read' },
    ],
  },
  'second-opinion': {
    why: 'different model lineage than Claude Code',
    chain: [
      { agent: 'agy', model: 'gemini-3.1-pro-high', mode: 'read' },
      { agent: 'copilot', model: 'auto', mode: 'read' },
    ],
  },
  'adversarial-review': {
    why: 'dual blind review off the Claude Code quota',
    chain: [
      { agent: 'agy', model: 'claude-sonnet-4-6', mode: 'read', parallelWith: { agent: 'copilot', model: 'auto', mode: 'read' } },
      { agent: 'agy', model: 'claude-opus-4-6-thinking', mode: 'read' },
    ],
  },
  'github-context': {
    why: 'built-in GitHub MCP; cheap models keep premium quota',
    // gpt-4.1 removed: rejected live by --model on this account, same as
    // every other explicit id we tried except 'auto'. No second copilot
    // fallback remains — 'auto' is the only value verified reliable.
    chain: [{ agent: 'copilot', model: 'auto', mode: 'read' }],
  },
  'mechanical-edit': {
    why: 'cheap write-capable; single writer',
    chain: [
      { agent: 'opencode', model: 'deepseek/deepseek-v4-flash', mode: 'write' },
      { agent: 'copilot', model: 'auto', mode: 'write' },
    ],
  },
  'implementation-with-repo-rules': {
    why: 'only Claude Code loads CLAUDE.md + skills + hooks',
    chain: [{ agent: 'claude', model: 'sonnet' }],
  },
  architecture: {
    why: 'highest reasoning',
    chain: [
      { agent: 'claude', model: 'opus' },
      { agent: 'agy', model: 'claude-opus-4-6-thinking', mode: 'read' },
    ],
  },
  'structured-mechanical': {
    why: 'cheapest Claude tier',
    chain: [{ agent: 'claude', model: 'haiku' }],
  },
}

function isUsable(candidate, env) {
  if (candidate.agent === 'claude') return true // Claude subagents are never CLI-preflighted
  const cached = readCache(env)[`${candidate.agent}:${candidate.model}`]
  if (cached?.status === 'unavailable') return false
  if (circuitBreakerOpen({ agent: candidate.agent, model: candidate.model, env })) return false
  return true
}

/**
 * route({taskType}) -> {primary, fallbacks, reason}. Filters out candidates
 * whose cached preflight is 'unavailable' or whose circuit breaker is open,
 * then returns the first survivor as primary and the rest as fallbacks.
 */
export async function route({ taskType, mode, env = process.env }) {
  const entry = DELEGATION_MAP[taskType]
  if (!entry) {
    throw new Error(`unknown task type: "${taskType}". Known types: ${Object.keys(DELEGATION_MAP).join(', ')}`)
  }

  const survivors = entry.chain.filter((c) => isUsable(c, env))

  if (survivors.length === 0) {
    return { primary: null, fallbacks: [], reason: `every candidate for "${taskType}" is unavailable or breaker-open (${entry.why})` }
  }

  const [primary, ...fallbacks] = survivors
  return { primary, fallbacks, reason: entry.why }
}

export function knownTaskTypes() {
  return Object.keys(DELEGATION_MAP)
}
