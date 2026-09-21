export const PROFILE_STATES = Object.freeze(['selected', 'fallback', 'exhausted', 'unavailable'])

export const POLICIES = Object.freeze(['priority', 'least_used', 'round_robin'])

/**
 * Normalizes a raw profile object into a standard shape with safe defaults.
 */
export function normalizeProfile(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      name: '',
      email: null,
      active: false,
      priority: 0,
      path: null,
    }
  }

  const rawName = raw.name ?? raw.profileName ?? raw.profile ?? ''
  const name = typeof rawName === 'string' ? rawName.trim() : String(rawName)

  let email = null
  if (raw.email && raw.email !== '(-)') {
    email = String(raw.email).trim()
  }

  const active = Boolean(raw.active ?? raw.default)

  let priority = 0
  if (typeof raw.priority === 'number' && Number.isFinite(raw.priority)) {
    priority = raw.priority
  } else if (raw.priority != null && !Number.isNaN(Number(raw.priority))) {
    priority = Number(raw.priority)
  }

  let path = null
  if (raw.path && raw.path !== '(-)') {
    path = String(raw.path).trim()
  }

  return {
    name,
    email,
    active,
    priority,
    path,
  }
}

/**
 * Normalizes a list of raw profiles.
 */
export function normalizeProfiles(rawList) {
  if (!Array.isArray(rawList)) return []
  return rawList.map(normalizeProfile)
}

function extractBuckets(quotaEntry) {
  if (!quotaEntry || typeof quotaEntry !== 'object') return []
  if (Array.isArray(quotaEntry.buckets)) return quotaEntry.buckets
  if (Array.isArray(quotaEntry.quota?.buckets)) return quotaEntry.quota.buckets
  if (Array.isArray(quotaEntry.quota?.groups)) {
    return quotaEntry.quota.groups.flatMap((g) => (Array.isArray(g.buckets) ? g.buckets : []))
  }
  return []
}

function isBucketExhausted(bucket) {
  if (!bucket || typeof bucket !== 'object') return false
  if (bucket.exhausted === true) return true
  const pct =
    bucket.usedPercent ??
    bucket.percentage ??
    bucket.percent ??
    bucket.usedPercentage ??
    (typeof bucket.window === 'object' ? bucket.window?.usedPercent : null)
  if (typeof pct === 'number') return pct >= 100
  if (typeof pct === 'string') {
    const parsed = parseFloat(pct)
    if (!Number.isNaN(parsed)) return parsed >= 100
  }
  return false
}

/**
 * Determine the lifecycle state of a profile.
 *
 * Precedence rules:
 * 1. errorClass: 'quota' -> 'exhausted'
 * 2. errorClass: 'auth' | 'billing' -> 'unavailable'
 * 3. quotaEntry: explicit exhausted flag or when every bucket reports >= 100% used -> 'exhausted'
 * 4. profile.active / default profile -> 'selected'
 * 5. otherwise -> 'fallback'
 */
export function profileStateFor({ profile, quotaEntry = null, errorClass = null }) {
  if (errorClass === 'quota') return 'exhausted'
  if (errorClass === 'auth' || errorClass === 'billing') return 'unavailable'

  if (quotaEntry && typeof quotaEntry === 'object') {
    if (quotaEntry.exhausted === true || quotaEntry.quota?.exhausted === true) {
      return 'exhausted'
    }
    const buckets = extractBuckets(quotaEntry)
    if (buckets.length > 0 && buckets.every(isBucketExhausted)) {
      return 'exhausted'
    }
  }

  const normalized = normalizeProfile(profile)
  if (normalized.active) return 'selected'
  return 'fallback'
}

function lastUsedRank(profile, usage) {
  const rawTs = usage?.lastUsedAt ?? profile?.lastUsedAt
  const parsed = rawTs ? Date.parse(rawTs) : NaN
  return Number.isFinite(parsed) ? parsed : -Infinity
}

function byPriority(a, b) {
  return (a.normalized.priority ?? 0) - (b.normalized.priority ?? 0)
}

function byName(a, b) {
  return String(a.normalized.name).localeCompare(String(b.normalized.name))
}

function usageCount(usage) {
  if (typeof usage === 'number') return usage
  return usage?.last24h ?? usage?.count ?? usage?.usage ?? 0
}

/**
 * Pick one profile from candidate profiles by policy.
 * Viable profiles are those whose state is NOT 'exhausted' and NOT 'unavailable'.
 * If viable candidates exist, dead profiles are never selected.
 */
export function selectProfile({ profiles = [], policy = 'priority', usageByProfile = {} }) {
  if (!Array.isArray(profiles) || profiles.length === 0) return null
  if (!POLICIES.includes(policy)) throw new Error(`invalid policy: ${policy}`)

  const entries = profiles.map((p) => {
    const norm = normalizeProfile(p)
    const state = p?.state ?? profileStateFor({ profile: norm })
    const usage = usageByProfile[norm.name] ?? usageByProfile[p?.id] ?? null
    return {
      profile: p,
      normalized: norm,
      state,
      usage,
    }
  })

  const viable = entries.filter((e) => e.state !== 'exhausted' && e.state !== 'unavailable')
  const pool = viable.length > 0 ? viable : []
  if (pool.length === 0) return null

  const sorted = pool.slice()
  if (policy === 'least_used') {
    sorted.sort(
      (a, b) =>
        usageCount(a.usage) - usageCount(b.usage) ||
        lastUsedRank(a.profile, a.usage) - lastUsedRank(b.profile, b.usage) ||
        byPriority(a, b) ||
        byName(a, b)
    )
  } else if (policy === 'priority') {
    sorted.sort(
      (a, b) =>
        byPriority(a, b) ||
        lastUsedRank(a.profile, a.usage) - lastUsedRank(b.profile, b.usage) ||
        byName(a, b)
    )
  } else {
    // round_robin
    sorted.sort(
      (a, b) =>
        lastUsedRank(a.profile, a.usage) - lastUsedRank(b.profile, b.usage) ||
        byPriority(a, b) ||
        byName(a, b)
    )
  }

  return sorted[0].profile
}
