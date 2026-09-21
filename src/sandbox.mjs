import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { SANDBOX } from './config.mjs'

/**
 * @typedef {'compatibility' | 'isolated-home' | 'isolated'} SandboxProfile
 *
 * Sandbox profiles control how the environment is filtered when spawning CLIs.
 *
 * Profile levels:
 * - 'compatibility': Redacts known secret env vars (SECRET_PATTERNS) but inherits
 *   the real HOME directory. Does NOT isolate disk credentials or filesystem.
 * - 'isolated-home': Redacts secret env vars and redirects HOME to a fresh empty
 *   temp directory. Does NOT isolate other paths, temp directories, or network.
 * - 'isolated': Redacts secret env vars, redirects HOME, TMPDIR, and XDG_* directories
 *   (XDG_CACHE_HOME, XDG_CONFIG_HOME, XDG_DATA_HOME) into a fresh per-call sandbox
 *   directory (created via fs.mkdtempSync under os.tmpdir()), creates the XDG subdirs,
 *   and exposes AGENT_HUB_SANDBOX_DIR. Opt-in credential copy via AGENT_HUB_SANDBOX_INCLUDE
 *   (comma-separated paths copied into sandbox; relative paths preserve relative path
 *   under sandbox, absolute paths copy to sandbox root; missing entries skipped; default
 *   unset/empty copies nothing; uses copy, not symlink).
 *
 * What these levels do and do NOT protect:
 * None of these profiles use OS containers, Linux namespaces, cgroups, or network
 * policies. 'isolated' is still NOT a container; child processes retain regular process
 * privileges and unrestricted network access.
 */

export const SANDBOX_PROFILES = Object.freeze({
  compatibility: { inheritHome: true, redactEnv: true },
  'isolated-home': { inheritHome: false, redactEnv: true },
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
      continue
    }
    filtered[key] = value
  }

  if (profile === 'isolated') {
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-isolated-'))
    filtered.AGENT_HUB_SANDBOX_DIR = sandboxDir
    filtered.HOME = sandboxDir
    filtered.TMPDIR = path.join(sandboxDir, 'tmp')
    filtered.XDG_CACHE_HOME = path.join(sandboxDir, '.cache')
    filtered.XDG_CONFIG_HOME = path.join(sandboxDir, '.config')
    filtered.XDG_DATA_HOME = path.join(sandboxDir, '.local', 'share')

    fs.mkdirSync(filtered.TMPDIR, { recursive: true })
    fs.mkdirSync(filtered.XDG_CACHE_HOME, { recursive: true })
    fs.mkdirSync(filtered.XDG_CONFIG_HOME, { recursive: true })
    fs.mkdirSync(filtered.XDG_DATA_HOME, { recursive: true })

    const rawInclude = env.AGENT_HUB_SANDBOX_INCLUDE ?? process.env.AGENT_HUB_SANDBOX_INCLUDE
    if (rawInclude) {
      const entries = rawInclude
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)

      for (const entry of entries) {
        if (!fs.existsSync(entry)) {
          continue
        }
        const dest = path.isAbsolute(entry)
          ? path.join(sandboxDir, path.basename(entry))
          : path.join(sandboxDir, entry)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.cpSync(entry, dest, { recursive: true })
      }
    }
  } else if (!config.inheritHome) {
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
  const config = SANDBOX_PROFILES[profile] ?? SANDBOX_PROFILES.compatibility
  let envRedactions = 0
  for (const [key, value] of Object.entries(originalEnv)) {
    if (filteredEnv[key] === '***' || (config.redactEnv && isSecretKey(key) && !Object.prototype.hasOwnProperty.call(filteredEnv, key))) {
      envRedactions++
    }
  }

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
