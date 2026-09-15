import fs from 'node:fs'
import { paths } from './config.mjs'
import { updateJsonLocked } from './fsutil.mjs'

/**
 * Manual, inspectable per-pair overrides: a hold (never route to this pair
 * until released) and/or a breakerReset timestamp (ignore circuit-breaker
 * failures at or before this instant — see preflight.mjs circuitBreakerOpen).
 * Read by both the MCP process (router.mjs) and the dashboard process, so
 * every write goes through updateJsonLocked.
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

/**
 * Merge `patch` into the existing entry for `key` (creating it if absent) and
 * persist atomically. Goes through updateJsonLocked (not a plain
 * read-modify-writeJsonAtomic) because the MCP process and the dashboard
 * process can both call this concurrently — without a lock, one process's
 * read-modify-write can silently clobber the other's.
 */
export function setOverride(key, patch, env = process.env) {
  const { overridesFile } = paths(env)
  const next = updateJsonLocked(
    overridesFile,
    (overrides) => {
      overrides[key] = { ...overrides[key], ...patch, setAt: new Date().toISOString() }
    },
    { defaultValue: {} }
  )
  return next[key]
}

/** Remove `key` entirely. A no-op (not an error) when the key was never set. */
export function clearOverride(key, env = process.env) {
  const { overridesFile } = paths(env)
  updateJsonLocked(
    overridesFile,
    (overrides) => {
      delete overrides[key]
    },
    { defaultValue: {} }
  )
  return { cleared: true }
}
