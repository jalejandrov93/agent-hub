import fs from 'node:fs'
import { paths } from './config.mjs'
import { writeJsonAtomic } from './fsutil.mjs'

/**
 * Manual, inspectable per-pair overrides: a hold (never route to this pair
 * until released) and/or a breakerReset timestamp (ignore circuit-breaker
 * failures at or before this instant — see preflight.mjs circuitBreakerOpen).
 * Read by both the MCP process (router.mjs) and the dashboard process, so
 * every write goes through writeJsonAtomic.
 *
 * Schema: { "agy:gemini-3.8-flash-low": { hold: true, reason: "manual", setAt: "ISO" },
 *           "copilot:auto": { breakerReset: "ISO" } }
 */
export function readOverrides(env = process.env) {
  const { overridesFile } = paths(env)
  try {
    return JSON.parse(fs.readFileSync(overridesFile, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    return {}
  }
}

export function overrideKey(agent, model) {
  return `${agent}:${model}`
}

/** Merge `patch` into the existing entry for `key` (creating it if absent) and persist atomically. */
export function setOverride(key, patch, env = process.env) {
  const overrides = readOverrides(env)
  overrides[key] = { ...overrides[key], ...patch, setAt: new Date().toISOString() }
  writeJsonAtomic(paths(env).overridesFile, overrides)
  return overrides[key]
}

/** Remove `key` entirely. A no-op (not an error) when the key was never set. */
export function clearOverride(key, env = process.env) {
  const overrides = readOverrides(env)
  delete overrides[key]
  writeJsonAtomic(paths(env).overridesFile, overrides)
  return { cleared: true }
}
