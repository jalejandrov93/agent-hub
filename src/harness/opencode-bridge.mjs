import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SERVICE_CACHE_TTL_MS = 5000
const MAX_READ_ATTEMPTS = 2
const MAX_SUMMARY_CHARS = 300
const DEFAULT_TIMEOUT_MS = 5000

const defaultCache = {
  entry: null,
  expiresAt: 0,
  path: null,
}

/**
 * Check whether a version string matches opencode >= 2.0.0.
 */
export function isSupportedOpencodeVersion(version) {
  if (!version || (typeof version !== 'string' && typeof version !== 'number')) {
    return false
  }
  const str = String(version).trim()
  const match = str.match(/(?:opencode\s+)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/i)
  if (!match) return false
  const major = parseInt(match[1], 10)
  if (Number.isNaN(major)) return false
  return major >= 2
}

/**
 * Resolve opencode service credentials { url, password } from service.json.
 * Bounded read retry (2 attempts) handles rotating/rewritten service.json.
 * Never throws.
 */
export function resolveOpencodeService({
  env = process.env,
  readFileFn = fs.readFileSync,
  cache = defaultCache,
  now = Date.now,
} = {}) {
  try {
    const servicePath =
      env?.AGENT_HUB_OPENCODE_SERVICE_FILE ||
      path.join(os.homedir(), '.local', 'state', 'opencode', 'service.json')

    const currentTime = typeof now === 'function' ? now() : Date.now()

    if (
      cache &&
      cache.entry &&
      cache.path === servicePath &&
      typeof cache.expiresAt === 'number' &&
      currentTime < cache.expiresAt
    ) {
      return cache.entry
    }

    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
      try {
        const raw = readFileFn(servicePath, 'utf8')
        const str = typeof raw === 'string' ? raw : raw?.toString?.('utf8')
        if (!str || str.trim().length === 0) continue

        const parsed = JSON.parse(str)
        if (
          parsed &&
          typeof parsed.url === 'string' &&
          parsed.url.trim().length > 0 &&
          typeof parsed.password === 'string' &&
          parsed.password.length > 0
        ) {
          const entry = {
            url: parsed.url.trim(),
            password: parsed.password,
          }
          if (cache && typeof cache === 'object') {
            cache.entry = entry
            cache.expiresAt = currentTime + SERVICE_CACHE_TTL_MS
            cache.path = servicePath
          }
          return entry
        }
      } catch {
        // Retry on transient read/parse error (e.g. file mid-rewrite)
      }
    }

    if (cache && typeof cache === 'object') {
      cache.entry = null
      cache.expiresAt = 0
    }
    return null
  } catch {
    return null
  }
}

function buildPromptText(payload) {
  const jobId = payload?.jobId ? String(payload.jobId) : 'unknown'
  const rawSummary = payload?.summary ?? ''
  const summary =
    typeof rawSummary === 'string'
      ? rawSummary.slice(0, MAX_SUMMARY_CHARS)
      : ''
  if (summary.length > 0) {
    return `Job ${jobId} completed: ${summary}`
  }
  return `Job ${jobId} completed.`
}

/**
 * OpenCode lifecycle bridge implementation.
 * Supports waking an existing OpenCode session via authenticated HTTP API.
 */
export function opencodeBridge({
  env = process.env,
  fetchFn = fetch,
  resolveServiceFn = resolveOpencodeService,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  version = null,
  getVersionFn = null,
} = {}) {
  return {
    id: 'opencode',

    canWake(origin) {
      if (!origin || typeof origin !== 'object') return false
      if (origin.harness !== 'opencode') return false

      const sessionId = origin.sessionId ?? origin.harness_session_id
      if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
        return false
      }

      if (env?.AGENT_HUB_OPENCODE_BRIDGE !== '1') return false

      const resolvedVersion =
        origin.version ??
        version ??
        (typeof getVersionFn === 'function' ? getVersionFn() : null) ??
        env?.AGENT_HUB_OPENCODE_VERSION ??
        null

      if (!isSupportedOpencodeVersion(resolvedVersion)) return false

      const service = resolveServiceFn({ env })
      if (!service || !service.url || !service.password) return false

      return true
    },

    async wake(origin, payload) {
      try {
        const service = resolveServiceFn({ env })
        if (!service?.url || !service?.password) {
          return { delivered: false, reason: 'no-service' }
        }

        const sessionId =
          origin?.sessionId ??
          origin?.harness_session_id ??
          payload?.sessionId ??
          null

        if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
          return { delivered: false, reason: 'missing-session-id' }
        }

        const baseUrl = service.url.replace(/\/+$/, '')
        const endpoint = `${baseUrl}/api/session/${encodeURIComponent(sessionId)}/prompt`
        const text = buildPromptText(payload)

        const credentials = Buffer.from(`opencode:${service.password}`).toString('base64')

        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)

        let response
        try {
          response = await fetchFn(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Basic ${credentials}`,
            },
            body: JSON.stringify({ text, resume: true }),
            signal: controller.signal,
          })
        } catch (fetchError) {
          return {
            delivered: false,
            reason: fetchError?.message ?? 'network-error',
          }
        } finally {
          clearTimeout(timer)
        }

        if (response.ok) {
          return { delivered: true, status: response.status }
        }

        return {
          delivered: false,
          status: response.status,
          reason: `HTTP ${response.status}`,
        }
      } catch (err) {
        return {
          delivered: false,
          reason: err?.message ?? 'wake-error',
        }
      }
    },
  }
}
