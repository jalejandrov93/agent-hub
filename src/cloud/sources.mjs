import { paths } from '../config.mjs'
import { readJsonSafe, updateJsonLocked } from '../fsutil.mjs'
import * as defaultClient from './jules/client.mjs'

/**
 * Per-account cache of each account's /sources list.
 *
 * WHY this exists at all: a perfectly valid Jules key can be refused by
 * /sources. Observed live — one account's GET /sources returns 401 on every
 * call while GET /sessions works fine and returns real sessions. So a source
 * list is a HINT for selection, never a health signal: an account whose
 * /sources fails is stored with status 'no_source_access' and stays eligible
 * (its sources are simply unknown). Account health is decided elsewhere, by
 * GET /sessions — see selectAccount.mjs.
 *
 * Shape: { [accountId]: { fetchedAt, status, sources } } with status one of
 * 'ok' | 'no_source_access' | 'error'. `sources` is a list of resource names
 * ('sources/github/{owner}/{repo}'), the identifier jules_delegate accepts.
 */

function sourceName(source) {
  return typeof source?.name === 'string' && source.name.length > 0 ? source.name : null
}

function cachePath(env) {
  return paths(env).sourcesCacheFile
}

/**
 * Fetch one account's sources and record the outcome. Never throws: a failed
 * read is stored as a status so the caller can refresh several accounts without
 * one bad key aborting the rest.
 */
export async function refreshSources({ accountId, env = process.env, client = defaultClient, apiKey } = {}) {
  if (!accountId) throw new Error('refreshSources requires an accountId')

  let entry
  try {
    const page = await client.listSources({ apiKey })
    const sources = Array.isArray(page?.sources) ? page.sources.map(sourceName).filter((name) => name !== null) : []
    entry = { fetchedAt: new Date().toISOString(), status: 'ok', sources }
  } catch (error) {
    // Only an error carrying an HTTP status came from the API. Anything else
    // (a TypeError from a bad client, a bug in this module) is a defect, and
    // caching it as status:'error' would disguise it as an account problem and
    // silently hide a working account's real source list.
    if (typeof error?.status !== 'number') throw error
    // A 401/403 here means "this account cannot list sources", NOT "this key is
    // rejected" — a working account was observed returning exactly this.
    const noSourceAccess = error.status === 401 || error.status === 403
    entry = {
      fetchedAt: new Date().toISOString(),
      status: noSourceAccess ? 'no_source_access' : 'error',
      sources: [],
      ...(noSourceAccess ? {} : { error: String(error?.message ?? error) }),
    }
  }

  updateJsonLocked(cachePath(env), (cache) => {
    cache[accountId] = entry
  }, { defaultValue: {} })

  return entry
}

export function readSourcesCache(env = process.env) {
  return readJsonSafe(cachePath(env), {})
}

/**
 * Which accounts are KNOWN to have `source`. Returns { accounts, unknown }:
 * accounts whose cached list contains the source, and accounts whose source
 * list is unknown (no cache entry, or status != 'ok'). An account with a good
 * cache that does not contain the source is in neither list — it is known to
 * LACK it, so callers must not fall back to it.
 */
export function accountsForSource(source, env = process.env) {
  const cache = readSourcesCache(env)
  const accounts = []
  const unknown = []

  for (const [accountId, entry] of Object.entries(cache)) {
    if (entry?.status !== 'ok') {
      unknown.push(accountId)
      continue
    }
    if (Array.isArray(entry.sources) && entry.sources.includes(source)) accounts.push(accountId)
  }

  return { accounts, unknown }
}
