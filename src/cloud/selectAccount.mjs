import {
  POLICIES,
  listAccounts as defaultListAccounts,
  usageFor as defaultUsageFor,
  readPolicy,
} from '../accounts.mjs'
import { readSourcesCache as defaultReadSourcesCache } from './sources.mjs'

/**
 * Pick one Jules account for a delegation.
 *
 * Selection order (see the tests for each rule):
 *  1. only enabled accounts,
 *  2. drop any account at its rolling-24h daily limit or its concurrent limit
 *     (reason `quota_exhausted`),
 *  3. prefer accounts KNOWN to have the source. Accounts whose source list is
 *     unknown (no cache entry, or a 401 on /sources) are a SECOND TIER, never
 *     dropped — a valid key was observed being refused by /sources, so a
 *     missing source list must not disqualify a healthy account. An account
 *     known to LACK the source is dropped.
 *  4. honour preferredAccountId when it is still eligible (explicit user choice
 *     beats the source hint), otherwise
 *  5. apply the policy: round_robin (oldest lastUsedAt, never-used first),
 *     least_used (lowest 24h usage), priority (lowest priority field).
 *
 * Returns { accountId, reason } or { accountId: null, reason } explaining which
 * filter emptied the candidate list.
 */
export function selectAccount({
  source,
  preferredAccountId,
  policy,
  env = process.env,
  listAccountsFn = defaultListAccounts,
  usageForFn = defaultUsageFor,
  readSourcesCacheFn = defaultReadSourcesCache,
} = {}) {
  const effectivePolicy = policy ?? readPolicy(env)
  if (!POLICIES.includes(effectivePolicy)) throw new Error(`invalid policy: ${effectivePolicy}`)

  const enabled = listAccountsFn(env).filter((account) => account.enabled !== false)
  if (enabled.length === 0) return { accountId: null, reason: 'no_accounts' }

  const eligible = []
  for (const account of enabled) {
    const usage = usageForFn(account.id, env) ?? { running: 0, last24h: 0 }
    const dailyLimit = account.dailyLimit ?? 100
    const concurrentLimit = account.concurrentLimit ?? 15
    if (usage.last24h >= dailyLimit || usage.running >= concurrentLimit) continue
    eligible.push({ account, usage })
  }
  if (eligible.length === 0) return { accountId: null, reason: 'quota_exhausted' }

  if (preferredAccountId) {
    const preferred = eligible.find((entry) => entry.account.id === preferredAccountId)
    if (preferred) return { accountId: preferred.account.id, reason: 'preferred' }
  }

  let pool = eligible
  if (source) {
    const cache = readSourcesCacheFn(env) ?? {}
    const known = []
    const unknown = []
    for (const entry of eligible) {
      const cached = cache[entry.account.id]
      if (!cached || cached.status !== 'ok') unknown.push(entry)
      else if (Array.isArray(cached.sources) && cached.sources.includes(source)) known.push(entry)
      // else: cache is good and does not list the source -> known to lack it.
    }
    if (known.length > 0) pool = known
    else if (unknown.length > 0) pool = unknown
    else return { accountId: null, reason: 'source_unavailable' }
  }

  const chosen = applyPolicy(pool, effectivePolicy)
  return { accountId: chosen.account.id, reason: effectivePolicy }
}

/** Never-used accounts sort before every used one, matching round_robin intent. */
function lastUsedRank(account) {
  const parsed = account.lastUsedAt ? Date.parse(account.lastUsedAt) : NaN
  return Number.isFinite(parsed) ? parsed : -Infinity
}

function byPriority(a, b) {
  return (a.priority ?? 0) - (b.priority ?? 0)
}

function byId(a, b) {
  return String(a.id).localeCompare(String(b.id))
}

function applyPolicy(pool, policy) {
  const sorted = pool.slice()
  if (policy === 'least_used') {
    sorted.sort(
      (a, b) =>
        a.usage.last24h - b.usage.last24h ||
        lastUsedRank(a.account) - lastUsedRank(b.account) ||
        byPriority(a.account, b.account) ||
        byId(a.account, b.account)
    )
  } else if (policy === 'priority') {
    sorted.sort(
      (a, b) =>
        byPriority(a.account, b.account) ||
        lastUsedRank(a.account) - lastUsedRank(b.account) ||
        byId(a.account, b.account)
    )
  } else {
    sorted.sort(
      (a, b) =>
        lastUsedRank(a.account) - lastUsedRank(b.account) ||
        byPriority(a.account, b.account) ||
        byId(a.account, b.account)
    )
  }
  return sorted[0]
}
