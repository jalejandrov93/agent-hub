import { runCommand as defaultRunCommand } from '../process.mjs'
import { normalizeProfile, selectProfile, profileStateFor } from './profiles.mjs'

/**
 * agys is an external Go CLI (~/.local/bin/agys) that isolates multi-account profiles
 * under ~/.agys/profiles/<name>/ by overriding HOME.
 *
 * CRITICAL: `agys run` defaults to '--model gemini-3.8-flash --effort high' when no model
 * is passed, so callers must always pass the model explicitly in agyArgv.
 */

/**
 * Parses stdout from `agys list` into normalized profile objects.
 * Handles headers, '(default)' active indicators, '(-)' placeholders, and variable column spacing.
 */
export function parseAgysList(stdout) {
  if (typeof stdout !== 'string') return []
  const lines = stdout.split(/\r?\n/)
  const profiles = []

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^Active Profiles:/i.test(line)) continue
    if (/^PROFILE\b/i.test(line)) continue
    if (/^[-=]+$/.test(line)) continue

    let name = ''
    let active = false
    let rest = ''

    const defaultMatch = line.match(/^(\S+)\s+\(default\)(?:\s+(.*))?$/)
    if (defaultMatch) {
      name = defaultMatch[1].trim()
      active = true
      rest = defaultMatch[2]?.trim() ?? ''
    } else {
      const parts = line.split(/\s+/)
      name = parts[0]
      rest = parts.slice(1).join(' ')
    }

    if (!name) continue

    const tokens = rest ? rest.split(/\s+/) : []
    // Columns: PRIO, EMAIL, CONFIG, PATH
    const rawPrio = tokens[0]
    const rawEmail = tokens[1]
    const rawPath = tokens.slice(3).join(' ') || tokens[3]

    const priority = Number.isFinite(Number(rawPrio)) ? Number(rawPrio) : 0
    const email = rawEmail && rawEmail !== '(-)' ? rawEmail : null
    const path = rawPath && rawPath !== '(-)' ? rawPath : null

    profiles.push(
      normalizeProfile({
        name,
        email,
        active,
        priority,
        path,
      })
    )
  }

  return profiles
}

/**
 * Tolerantly parses `agys quota --json` stdout or parsed JSON array/object into a map
 * keyed by profileName. Never throws on invalid JSON or unexpected formats, returns {}.
 */
export function parseAgysQuota(input) {
  if (input == null) return {}
  let data = input
  if (typeof input === 'string') {
    const trimmed = input.trim()
    if (!trimmed) return {}
    try {
      data = JSON.parse(trimmed)
    } catch {
      return {}
    }
  }
  if (!data || typeof data !== 'object') return {}

  const result = {}
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === 'object') {
        const name = item.profileName ?? item.name
        if (typeof name === 'string' && name.trim()) {
          result[name.trim()] = item
        }
      }
    }
    return result
  }

  if (typeof (data.profileName ?? data.name) === 'string') {
    const name = (data.profileName ?? data.name).trim()
    if (name) {
      result[name] = data
      return result
    }
  }

  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object') {
      result[key] = value
    }
  }
  return result
}

export function agysRunArgv({ profile, agyArgv = [] } = {}) {
  return ['run', profile, '--', ...agyArgv]
}

export function agysAutoArgv({ agyArgv = [] } = {}) {
  return ['auto', '--', ...agyArgv]
}

export async function isAgysAvailable({ runCommandFn = defaultRunCommand, env = process.env } = {}) {
  try {
    const res = await runCommandFn('agys', ['--version'], { env, timeoutMs: 10_000 })
    return res?.code === 0 && !res?.timedOut && !res?.error
  } catch {
    return false
  }
}

export async function listAgysProfiles({ runCommandFn = defaultRunCommand, env = process.env } = {}) {
  try {
    const res = await runCommandFn('agys', ['list'], { env, timeoutMs: 10_000 })
    if (!res || res.code !== 0 || res.timedOut || res.error || !res.stdout) {
      return []
    }
    return parseAgysList(res.stdout)
  } catch {
    return []
  }
}

export async function readAgysQuota({ runCommandFn = defaultRunCommand, env = process.env } = {}) {
  try {
    const res = await runCommandFn('agys', ['quota', '--json'], { env, timeoutMs: 15_000 })
    if (!res || res.code !== 0 || res.timedOut || res.error || !res.stdout) {
      return {}
    }
    return parseAgysQuota(res.stdout)
  } catch {
    return {}
  }
}

/**
 * Runs agy with the designated agys profile, falling back to plain agy only when
 * profile is falsy.
 *
 * NOTE: Caller handles fallback wiring when a profile run fails (e.g. on quota exhaustion),
 * that wiring is the next slice.
 */
export async function runAgyWithProfile({
  profile,
  agyArgv = [],
  runCommandFn = defaultRunCommand,
  env = process.env,
  cwd,
  timeoutMs,
  ...opts
} = {}) {
  try {
    if (profile) {
      const args = agysRunArgv({ profile, agyArgv })
      return await runCommandFn('agys', args, { env, cwd, timeoutMs, ...opts })
    }
    return await runCommandFn('agy', agyArgv, { env, cwd, timeoutMs, ...opts })
  } catch (error) {
    return {
      stdout: '',
      stderr: String(error?.message ?? error),
      code: 1,
      error,
      timedOut: false,
    }
  }
}

export function resolveAgyCommand({ profile = null, agyCmd = 'agy', agyArgv = [] } = {}) {
  if (profile) {
    return { cmd: 'agys', args: agysRunArgv({ profile, agyArgv }) }
  }
  return { cmd: agyCmd, args: [...agyArgv] }
}

/**
 * Synchronous profile resolution from the environment only.
 *
 * startJob() is and must stay SYNCHRONOUS: delegate() and dispatch() read
 * `startJob(...).job` immediately. The async quota-based 'auto' selection
 * (resolveAgyProfile) therefore belongs to an async caller (dispatch), not
 * here — resolving it inside startJob would only be possible by returning a
 * thenable whose `job` is null until it settles, which breaks every caller.
 */
export function profileFromEnv(env = process.env) {
  const value = env?.AGENT_HUB_AGYS_PROFILE
  return typeof value === 'string' && value.trim() !== ''
    ? { profile: value.trim(), status: 'selected' }
    : { profile: null, status: null }
}

export async function resolveAgyProfile({
  env = process.env,
  runCommandFn = defaultRunCommand,
  listFn,
  quotaFn,
  selectFn = selectProfile,
} = {}) {
  try {
    const safeEnv = env || {}
    const explicit = safeEnv.AGENT_HUB_AGYS_PROFILE
    if (typeof explicit === 'string' && explicit.trim() !== '') {
      return { profile: explicit.trim(), status: 'selected' }
    }

    if (safeEnv.AGENT_HUB_AGYS === 'auto') {
      const available = await isAgysAvailable({ runCommandFn, env: safeEnv })
      if (!available) {
        return { profile: null, status: 'unavailable' }
      }

      const effectiveListFn = listFn ?? listAgysProfiles
      const effectiveQuotaFn = quotaFn ?? readAgysQuota
      const [rawProfiles, quotaMap] = await Promise.all([
        effectiveListFn({ runCommandFn, env: safeEnv }),
        effectiveQuotaFn({ runCommandFn, env: safeEnv }),
      ])

      const profiles = Array.isArray(rawProfiles) ? rawProfiles : []
      const candidates = profiles.map((p) => {
        const quotaEntry = quotaMap && typeof quotaMap === 'object' ? quotaMap[p.name] : null
        const state = p?.state ?? profileStateFor({ profile: p, quotaEntry })
        return { ...p, state }
      })

      const chosen = selectFn({ profiles: candidates })
      if (!chosen) {
        return { profile: null, status: null }
      }
      return {
        profile: chosen.name ?? null,
        status: chosen.active ? 'selected' : 'fallback',
      }
    }

    return { profile: null, status: null }
  } catch {
    return { profile: null, status: null }
  }
}

