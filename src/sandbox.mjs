import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { SANDBOX } from './config.mjs'

/**
 * @typedef {'compatibility' | 'isolated-home' | 'isolated'} SandboxProfile
 *
 * Sandbox profiles control how the environment is filtered when spawning CLIs.
 *
 * IMPORTANT: compatibility is NOT a security sandbox. It inherits the real HOME
 * directory and only redacts well-known secret env vars. Use 'isolated-home' or
 * 'isolated' for stronger credential isolation.
 *
 * Note on 'isolated': currently `isolated = isolated-home + reserved extension point`
 * until real filesystem and network isolation (e.g. bubblewrap/cgroups/namespaces)
 * is implemented.
 */

export const SANDBOX_PROFILES = Object.freeze({
  compatibility: { inheritHome: true, redactEnv: true },
  'isolated-home': { inheritHome: false, redactEnv: true },
  // isolated = isolated-home + reserved extension point until real filesystem/network
  isolated: { inheritHome: false, redactEnv: true },
})

/**
 * Secret env var families that are always redacted regardless of profile.
 * Patterns: *_TOKEN, *_SECRET, *_API_KEY, AWS_*, GH_TOKEN, ANTHROPIC_*, OPENAI_*, JULES_API_KEY.
 */
const SECRET_PATTERNS = [
  /_TOKEN$/,
  /_SECRET$/,
  /_API_KEY$/,
  /^AWS_/,
  /^GH_TOKEN$/,
  /^ANTHROPIC_/,
  /^OPENAI_/,
  /^JULES_API_KEY$/,
]

function isSecretKey(key) {
  return SECRET_PATTERNS.some((re) => re.test(key))
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {SandboxProfile} profile
 * @returns {Record<string, string | undefined>}
 */
export function filterEnv(env, profile) {
  const config = SANDBOX_PROFILES[profile] ?? SANDBOX_PROFILES.compatibility
  const filtered = {}

  for (const [key, value] of Object.entries(env)) {
    if (config.redactEnv && isSecretKey(key)) {
      filtered[key] = '***'
    } else {
      filtered[key] = value
    }
  }

  if (!config.inheritHome) {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-sandbox-home-'))
    filtered.HOME = tmpHome
  }

  return filtered
}

/**
 * Produce telemetry for a sandbox run.
 * @param {Record<string, string | undefined>} filteredEnv
 * @param {Record<string, string | undefined>} originalEnv
 * @param {SandboxProfile} profile
 */
export function sandboxTelemetry(filteredEnv, originalEnv, profile) {
  let envRedactions = 0
  for (const [key, value] of Object.entries(originalEnv)) {
    if (filteredEnv[key] === '***') envRedactions++
  }

  const config = SANDBOX_PROFILES[profile] ?? SANDBOX_PROFILES.compatibility
  return {
    profile,
    envRedactions,
    homeIsolation: !config.inheritHome,
  }
}

/**
 * Resolve a sandbox profile name to a valid profile, falling back to
 * 'compatibility' for unknown values.
 * @param {string | undefined} name
 * @returns {SandboxProfile}
 */
export function resolveSandboxProfile(name) {
  if (name && name in SANDBOX_PROFILES) return name
  return SANDBOX.defaultProfile ?? 'compatibility'
}
