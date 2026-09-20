/**
 * Harness registry: which client harness a dispatch is serving, and what
 * that implies for the default wait contract.
 *
 * Priority: explicit arg > AGENT_HUB_HARNESS env > MCP clientHint > generic.
 *
 * The clientHint NEVER decides anything security-sensitive (write gates,
 * locks, routing): it only selects the DEFAULT waitMode when the caller
 * passed neither an explicit harness nor waitMode. An explicit waitMode
 * always wins over every profile default.
 */
import { generic } from './generic.mjs'
import { claudeCode } from './claude-code.mjs'
import { opencode } from './opencode.mjs'

export const WAIT_MODES = Object.freeze(['none', 'attention', 'terminal'])

export const HARNESS_IDS = Object.freeze(['generic', 'claude-code', 'opencode'])

const PROFILES = { generic, 'claude-code': claudeCode, opencode }

function normalizeId(value) {
  if (value == null) return null
  const v = String(value).trim().toLowerCase()
  if (v === 'claude-code' || v === 'claude' || v === 'claudecode') return 'claude-code'
  if (v === 'opencode' || v === 'open-code') return 'opencode'
  if (v === 'generic') return 'generic'
  return null
}

/**
 * Normalize a waitMode, throwing on unknown values so typos fail fast
 * instead of silently changing the wait contract.
 */
export function normalizeWaitMode(value) {
  if (value == null) return null
  if (WAIT_MODES.includes(value)) return value
  throw new Error(`unknown waitMode: ${value} (expected one of ${WAIT_MODES.join('|')})`)
}

/**
 * Map an MCP clientInfo.name to a harness hint id. Returns null when the
 * client is not a known harness — the caller then falls back to generic.
 * Matching is substring-based and case-insensitive ('Claude Code v1.2' and
 * 'opencode' both match); anything else is null, never a guess.
 */
export function clientHintForName(name) {
  if (name == null) return null
  const v = String(name).toLowerCase()
  if (v.includes('claude')) return 'claude-code'
  if (v.includes('opencode')) return 'opencode'
  return null
}

/**
 * Resolve the harness profile. Unknown explicit/env ids fall back to
 * generic rather than throwing, so a typo degrades to the safe default
 * (return immediately, no waiting) instead of breaking the dispatch.
 */
export function resolveHarness({ explicit = null, env = process.env, clientHint = null } = {}) {
  const fromExplicit = normalizeId(explicit)
  if (fromExplicit) return PROFILES[fromExplicit]

  const fromEnv = normalizeId(env?.AGENT_HUB_HARNESS)
  if (fromEnv) return PROFILES[fromEnv]

  const fromHint = normalizeId(clientHint)
  if (fromHint && fromHint !== 'generic') return PROFILES[fromHint]

  return PROFILES.generic
}

// Stored MCP client hint, captured at the stdio handshake (see
// src/index.mjs). Module state only — resolveHarness() stays pure and takes
// the hint as an argument, so tests never touch this.
let storedClientHint = null

export function setClientHint(hint) {
  storedClientHint = normalizeId(hint) === 'generic' ? null : normalizeId(hint)
  return storedClientHint
}

export function getClientHint() {
  return storedClientHint
}
