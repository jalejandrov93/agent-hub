import { paths } from '../config.mjs'
import { readJsonSafe, updateJsonLocked } from '../fsutil.mjs'
import * as defaultClient from './jules/client.mjs'
import { listAllSources } from './jules/client.mjs'

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
 * 'ok' | 'no_source_access' | 'error'. `sources` is a list of
 * { name, owner, repo, defaultBranch, branches } — everything a caller needs
 * to pick a startingBranch for jules_delegate without a second live call.
 * `name` ('sources/github/{owner}/{repo}') is the identifier jules_delegate
 * accepts. A cache written before this shape existed may still hold plain
 * name strings; every reader here treats both shapes as equivalent.
 */

function sourceName(source) {
  return typeof source?.name === 'string' && source.name.length > 0 ? source.name : null
}

// The one shape the Jules alpha API pins down for a source is its resource
// name, 'sources/github/{owner}/{repo}' — githubRepo is an observed-in-the-
// wild convenience field, not a documented guarantee, so it is only ever a
// preferred value, never the sole source of owner/repo.
function ownerRepoFromName(name) {
  const match = typeof name === 'string' ? name.match(/^sources\/github\/([^/]+)\/(.+)$/) : null
  return match ? { owner: match[1], repo: match[2] } : { owner: null, repo: null }
}

/** Raw Jules API source item -> the cached shape: {name, owner, repo, defaultBranch, branches}. */
function mapSource(raw) {
  const name = sourceName(raw)
  const fallback = ownerRepoFromName(name)
  const githubRepo = raw?.githubRepo
  const defaultBranchName = githubRepo?.defaultBranch?.displayName
  return {
    name,
    owner: githubRepo?.owner ?? fallback.owner,
    repo: githubRepo?.repo ?? fallback.repo,
    defaultBranch: typeof defaultBranchName === 'string' && defaultBranchName.length > 0 ? defaultBranchName : null,
    branches: Array.isArray(githubRepo?.branches)
      ? githubRepo.branches.map((branch) => branch?.displayName).filter((name) => typeof name === 'string' && name.length > 0)
      : [],
  }
}

/**
 * Normalize one cache entry's `sources` to the richer shape regardless of
 * whether it was written before or after that shape existed. A legacy plain
 * string becomes {name, owner: null, repo: null, defaultBranch: null,
 * branches: []} — the caller loses nothing it had (the name), and gains
 * nothing it never had either.
 */
export function normalizedSources(entry) {
  if (!Array.isArray(entry?.sources)) return []
  return entry.sources
    .map((source) =>
      typeof source === 'string'
        ? { name: source, owner: null, repo: null, defaultBranch: null, branches: [] }
        : source
    )
    .filter((source) => typeof source?.name === 'string' && source.name.length > 0)
}

/** Plain source names out of a cache entry, in either shape. */
export function sourceNamesFromEntry(entry) {
  return normalizedSources(entry).map((source) => source.name)
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
    // The Jules API defaults pageSize to 30 (max 100): a single-page read left
    // sources-cache.json holding only the first 30 of 53 sources on a real
    // account, so every read here pages through the full list.
    const page = await listAllSources(client, { apiKey })
    const sources = Array.isArray(page?.sources) ? page.sources.map(mapSource).filter((source) => source.name !== null) : []
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
    if (sourceNamesFromEntry(entry).includes(source)) accounts.push(accountId)
  }

  return { accounts, unknown }
}
