import child_process from 'node:child_process'
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

export const defaultSyncCache = new Map()
export const SYNC_PROFILE_CACHE_TTL_MS = 60_000

export function resetSyncProfileCache() {
  defaultSyncCache.clear()
}

export function resolveAgyProfileSync({
  env = process.env,
  execFn,
  cache = defaultSyncCache,
  now = Date.now,
} = {}) {
  try {
    const safeEnv = env || {}
    const explicit = safeEnv.AGENT_HUB_AGYS_PROFILE
    if (typeof explicit === 'string' && explicit.trim() !== '') {
      const profile = explicit.trim()
      return { profile, status: 'selected', profiles: [{ name: profile, status: 'selected' }] }
    }

    const agysMode = safeEnv.AGENT_HUB_AGYS
    const isAuto = agysMode === 'auto'
    const isAgysSet = typeof agysMode === 'string' && agysMode.trim() !== ''

    if (!isAgysSet) {
      return { profile: null, status: null, profiles: [] }
    }

    const cacheKey = `agys:${agysMode}`
    if (cache && typeof cache.get === 'function') {
      const cached = cache.get(cacheKey)
      if (cached && typeof cached.expiresAt === 'number' && now() < cached.expiresAt) {
        return cached.value
      }
    }

    const effectiveExecFn = execFn ?? child_process.execFileSync
    let stdoutList = ''
    let stdoutQuota = ''

    try {
      stdoutList = effectiveExecFn('agys', ['list'], {
        encoding: 'utf8',
        timeout: 2500,
        env: safeEnv,
      })
      if (typeof stdoutList !== 'string') {
        stdoutList = stdoutList?.toString?.('utf8') ?? ''
      }
    } catch (err) {
      const isUnavailable = err?.code === 'ENOENT' || err?.code === 127
      const failureResult = {
        profile: null,
        status: isUnavailable ? 'unavailable' : null,
        profiles: [],
      }
      if (cache && typeof cache.set === 'function') {
        cache.set(cacheKey, { value: failureResult, expiresAt: now() + SYNC_PROFILE_CACHE_TTL_MS })
      }
      return failureResult
    }

    try {
      stdoutQuota = effectiveExecFn('agys', ['quota', '--json'], {
        encoding: 'utf8',
        timeout: 2500,
        env: safeEnv,
      })
      if (typeof stdoutQuota !== 'string') {
        stdoutQuota = stdoutQuota?.toString?.('utf8') ?? ''
      }
    } catch {
      stdoutQuota = ''
    }

    const rawProfiles = parseAgysList(stdoutList)
    const quotaMap = parseAgysQuota(stdoutQuota)
    const profiles = Array.isArray(rawProfiles) ? rawProfiles : []

    const candidates = profiles.map((p) => {
      const quotaEntry = quotaMap && typeof quotaMap === 'object' ? quotaMap[p.name] : null
      const state = p?.state ?? profileStateFor({ profile: p, quotaEntry })
      return { ...p, state }
    })

    const annotatedProfiles = candidates.map((c) => ({
      name: c.name,
      status: c.state,
    }))

    let chosen = null
    if (isAuto) {
      chosen = selectProfile({ profiles: candidates })
    }

    const result = {
      profile: chosen?.name ?? null,
      status: chosen ? (chosen.active ? 'selected' : 'fallback') : null,
      profiles: annotatedProfiles,
    }

    if (cache && typeof cache.set === 'function') {
      cache.set(cacheKey, { value: result, expiresAt: now() + SYNC_PROFILE_CACHE_TTL_MS })
    }

    return result
  } catch {
    return { profile: null, status: null, profiles: [] }
  }
}


