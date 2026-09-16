import { paths } from '../config.mjs'
import { updateJsonLocked, readJsonSafe } from '../fsutil.mjs'

const CACHE_TTL_MS = 5 * 60 * 1000

export async function fetchUsage({ providers, baseUrl = 'http://127.0.0.1:8787', fetchImpl = fetch, timeoutMs = 10000, refresh = false, env = process.env }) {
  const urlBase = env.AGENT_HUB_CODEXBAR_URL || baseUrl
  const cacheFile = paths(env).quotaCacheFile

  // Deduplicate requested providers
  const uniqueProviders = [...new Set(providers)]

  if (uniqueProviders.length === 0) return {}

  // Read cache
  let cached = {}
  try {
    cached = readJsonSafe(cacheFile, {})
  } catch (error) {
    // Ignore cache read errors
  }

  const now = Date.now()
  const results = {}
  const toFetch = []

  for (const provider of uniqueProviders) {
    if (!refresh && cached[provider] && now - cached[provider].timestamp < CACHE_TTL_MS) {
      results[provider] = cached[provider].data
    } else {
      toFetch.push(provider)
    }
  }

  if (toFetch.length === 0) {
    return results
  }

  const fetchPromises = toFetch.map(async (provider) => {
    try {
      const url = new URL(`/usage?provider=${encodeURIComponent(provider)}`, urlBase).toString()
      let signal = AbortSignal.timeout(timeoutMs)

      const res = await fetchImpl(url, { signal })

      if (!res.ok) {
        return { provider, error: `CodexBar HTTP ${res.status}` }
      }
      
      const data = await res.json()
      return { provider, data }
    } catch (error) {
      return { provider, error: error.name === 'AbortError' ? 'timeout' : error.message, isNetworkError: true }
    }
  })

  const fetchedResults = await Promise.all(fetchPromises)
  
  const networkErrors = fetchedResults.filter(r => r.isNetworkError)
  if (networkErrors.length === fetchedResults.length && fetchedResults.length > 0) {
    return { reachable: false }
  }

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

  // Update cache
  if (Object.keys(updates).length > 0) {
    try {
      updateJsonLocked(cacheFile, (current) => {
        return { ...current, ...updates }
      }, { defaultValue: {} })
    } catch (error) {
      // Ignore cache write errors
    }
  }

  return results
}