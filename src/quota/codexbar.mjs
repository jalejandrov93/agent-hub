import { paths } from '../config.mjs'
import { updateJsonLocked, readJsonSafe } from '../fsutil.mjs'

const CACHE_TTL_MS = 5 * 60 * 1000

// CodexBar's own cache goes cold periodically; a cold agy probe was measured
// at ~19.2s on the real machine. The old 10s default aborted mid-probe and
// leaked "The operation was aborted due to timeout" as the reason. 45s gives
// real (live-mode) network calls enough margin to complete instead.
const LIVE_TIMEOUT_MS = 45000

// Background refreshes started by cached mode, keyed by provider, so a burst
// of route()/agents_status calls in the same tick shares one in-flight fetch
// instead of fanning out N requests at CodexBar. Module-level and therefore
// process-wide, matching the "at most one in-flight fetch per provider"
// requirement.
const inFlightBackgroundFetches = new Map()

/**
 * AbortSignal.timeout() rejects with a DOMException named 'TimeoutError', not
 * 'AbortError' — checking only 'AbortError' is what let the raw timeout
 * message leak to callers instead of a stable code.
 */
function classifyError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'codexbar_timeout'
  return 'codexbar_unreachable'
}

async function fetchOneProvider({ provider, urlBase, fetchImpl, timeoutMs }) {
  try {
    const url = new URL(`/usage?provider=${encodeURIComponent(provider)}`, urlBase).toString()
    const signal = AbortSignal.timeout(timeoutMs)
    const res = await fetchImpl(url, { signal })

    if (!res.ok) {
      return { provider, error: `codexbar_http_${res.status}` }
    }

    const data = await res.json()
    return { provider, data }
  } catch (error) {
    return { provider, error: classifyError(error) }
  }
}

/**
 * Fire a background refresh for `provider`, deduped in-process. Never throws
 * and never writes the cache on failure — the whole point is that a slow or
 * unreachable CodexBar cannot ever surface as a rejection to a cached-mode
 * caller; the next call just sees the cache untouched and tries again.
 */
function startBackgroundFetch({ provider, urlBase, fetchImpl, timeoutMs, cacheFile }) {
  const existing = inFlightBackgroundFetches.get(provider)
  if (existing) return existing

  const promise = fetchOneProvider({ provider, urlBase, fetchImpl, timeoutMs })
    .then((result) => {
      if (result.error) return // do not cache errors
      try {
        updateJsonLocked(
          cacheFile,
          (current) => ({ ...current, [provider]: { data: result.data, timestamp: Date.now() } }),
          { defaultValue: {} }
        )
      } catch {
        // Ignore cache write errors — the next refresh just retries.
      }
    })
    .catch(() => {
      // A background refresh must never become an unhandled rejection.
    })
    .finally(() => {
      inFlightBackgroundFetches.delete(provider)
    })

  inFlightBackgroundFetches.set(provider, promise)
  return promise
}

/**
 * @param {object} opts
 * @param {'live'|'cached'} [opts.mode] - 'live' (default) awaits the network
 *   for anything missing, stale, or when `refresh` is set — today's original
 *   behaviour, meant for a human-triggered read (agents_quota). 'cached'
 *   NEVER awaits the network: it returns immediately from the cache file
 *   (marking a past-TTL entry `stale: true`) and starts an un-awaited
 *   background refresh for anything missing/stale/refresh-requested, meant
 *   for route()/agents_status, which must never block a delegation on quota.
 *
 * In 'cached' mode, the returned object carries a non-enumerable
 * `background` promise (Promise.allSettled of every background fetch this
 * call started or joined) so tests can await the background work instead of
 * relying on real timers. It resolves once every such fetch has settled,
 * successful or not.
 */
export async function fetchUsage({
  providers,
  baseUrl = 'http://127.0.0.1:8787',
  fetchImpl = fetch,
  timeoutMs = LIVE_TIMEOUT_MS,
  refresh = false,
  env = process.env,
  mode = 'live',
}) {
  const urlBase = env.AGENT_HUB_CODEXBAR_URL || baseUrl
  const cacheFile = paths(env).quotaCacheFile

  const uniqueProviders = [...new Set(providers)]
  if (uniqueProviders.length === 0) return {}

  let cached = {}
  try {
    cached = readJsonSafe(cacheFile, {})
  } catch {
    // Ignore cache read errors
  }

  const now = Date.now()

  if (mode === 'cached') {
    const results = {}
    const backgroundPromises = []

    for (const provider of uniqueProviders) {
      const entry = cached[provider]
      const isStale = !entry || now - entry.timestamp >= CACHE_TTL_MS

      if (entry) {
        // Own properties on the CodexBar response (an array) so mapping.mjs
        // can read them alongside the existing shape — callers who only know
        // the old array-of-usage-rows contract keep working untouched.
        entry.data.stale = isStale
        entry.data.cachedAt = new Date(entry.timestamp).toISOString()
        results[provider] = entry.data
      } else {
        results[provider] = { pending: true }
      }

      if (!entry || isStale || refresh) {
        backgroundPromises.push(startBackgroundFetch({ provider, urlBase, fetchImpl, timeoutMs, cacheFile }))
      }
    }

    Object.defineProperty(results, 'background', {
      value: Promise.allSettled(backgroundPromises),
      enumerable: false,
    })

    return results
  }

  // mode === 'live': await the network for anything missing/stale/refreshed.
  const results = {}
  const toFetch = []

  for (const provider of uniqueProviders) {
    if (!refresh && cached[provider] && now - cached[provider].timestamp < CACHE_TTL_MS) {
      results[provider] = cached[provider].data
    } else {
      toFetch.push(provider)
    }
  }

  if (toFetch.length === 0) return results

  const fetchedResults = await Promise.all(toFetch.map((provider) => fetchOneProvider({ provider, urlBase, fetchImpl, timeoutMs })))

  const updates = {}
  for (const result of fetchedResults) {
    if (result.error) {
      results[result.provider] = { error: result.error }
      // Do not cache errors
    } else {
      results[result.provider] = result.data
      updates[result.provider] = { data: result.data, timestamp: now }
    }
  }

  if (Object.keys(updates).length > 0) {
    try {
      updateJsonLocked(cacheFile, (current) => ({ ...current, ...updates }), { defaultValue: {} })
    } catch {
      // Ignore cache write errors
    }
  }

  return results
}
