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

/**
 * Extract the model-group buckets (`agys quota --json` real shape:
 * quota.groups[].{displayName, buckets}), or [] when the entry has no group
 * structure (legacy flat shapes fall back to extractBuckets elsewhere).
 */
function extractGroups(quotaEntry) {
  if (!quotaEntry || typeof quotaEntry !== 'object') return []
  if (Array.isArray(quotaEntry.quota?.groups)) return quotaEntry.quota.groups
  if (Array.isArray(quotaEntry.groups)) return quotaEntry.groups
  return []
}

/**
 * Maps a job's model id to the agys quota group it draws from. agys splits
 * quota into "Gemini Models" and "Claude and GPT models" — models starting
 * with `gemini` draw from the former, `claude`/`gpt` from the latter.
 * Anything else (or no model) is unknown: callers treat that conservatively
 * (see profileStateFor/remainingQuotaForModel) rather than assuming a group.
 */
export function modelGroupFor(model) {
  if (typeof model !== 'string') return null
  const m = model.trim().toLowerCase()
  if (!m) return null
  if (m.startsWith('gemini')) return 'gemini'
  if (m.startsWith('claude') || m.startsWith('gpt')) return 'claude-gpt'
  return null
}

function displayNameGroupKey(displayName) {
  if (!displayName) return null
  const d = String(displayName).toLowerCase()
  if (d.includes('gemini')) return 'gemini'
  if (d.includes('claude') || d.includes('gpt')) return 'claude-gpt'
  return null
}

/** Buckets of `quotaEntry`'s groups that belong to `groupKey` ('gemini' | 'claude-gpt'). */
function bucketsForGroupKey(groups, groupKey) {
  return groups
    .filter((g) => displayNameGroupKey(g?.displayName ?? g?.name) === groupKey)
    .flatMap((g) => (Array.isArray(g.buckets) ? g.buckets : []))
}

/**
 * A group is exhausted when ANY of its windows (5h, weekly, ...) is
 * exhausted — a job in that model group would still 429 on the empty window.
 */
function isModelExhaustedInGroups(groups, model) {
  const modelGroup = modelGroupFor(model)
  if (modelGroup) {
    const buckets = bucketsForGroupKey(groups, modelGroup)
    if (buckets.length === 0) return false // no data for that group: not exhausted
    return buckets.some(isBucketExhausted)
  }
  // Unrecognized model family: conservative — exhausted if ANY group has any
  // exhausted window, since we cannot rule out that group being the one used.
  return groups.some((g) => (Array.isArray(g.buckets) ? g.buckets : []).some(isBucketExhausted))
}

function isBucketExhausted(bucket) {
  if (!bucket || typeof bucket !== 'object') return false
  if (bucket.exhausted === true) return true
  if (typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)) {
    return bucket.remainingFraction <= 0
  }
  if (typeof bucket.remainingPercent === 'number' && Number.isFinite(bucket.remainingPercent)) {
    return bucket.remainingPercent <= 0
  }
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

function bucketRemainingFraction(bucket) {
  if (!bucket || typeof bucket !== 'object') return null
  if (typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)) {
    return bucket.remainingFraction
  }
  if (typeof bucket.remainingPercent === 'number' && Number.isFinite(bucket.remainingPercent)) {
    return bucket.remainingPercent / 100
  }
  const pct = bucket.usedPercent ?? bucket.percentage ?? bucket.percent ?? bucket.usedPercentage
  if (typeof pct === 'number' && Number.isFinite(pct)) {
    return Math.max(0, Math.min(1, 1 - pct / 100))
  }
  return null
}

/**
 * Headroom (0..1) for `model`'s group in `quotaEntry`: the minimum
 * remainingFraction across that group's windows (5h, weekly, ...), so a
 * profile that is about to run out in any one window ranks low even if
 * another window still has plenty left. Returns null when there is no usable
 * quota data (unknown profile, no groups, or every bucket unreadable).
 * An unrecognized model conservatively considers ALL groups combined.
 */
export function remainingQuotaForModel(quotaEntry, model) {
  const groups = extractGroups(quotaEntry)
  if (groups.length === 0) return null
  const modelGroup = modelGroupFor(model)
  const buckets = modelGroup
    ? bucketsForGroupKey(groups, modelGroup)
    : groups.flatMap((g) => (Array.isArray(g.buckets) ? g.buckets : []))
  const fractions = buckets.map(bucketRemainingFraction).filter((f) => typeof f === 'number' && Number.isFinite(f))
  if (fractions.length === 0) return null
  return Math.min(...fractions)
}

/**
 * Determine the lifecycle state of a profile.
 *
 * Precedence rules:
 * 1. errorClass: 'quota' -> 'exhausted'
 * 2. errorClass: 'auth' | 'billing' -> 'unavailable'
 * 3. quotaEntry: explicit exhausted flag -> 'exhausted'
 * 4. quotaEntry with a `model`: exhausted when that model's group (Gemini vs
 *    Claude/GPT) has ANY window exhausted (an unrecognized model
 *    conservatively checks every group) — see isModelExhaustedInGroups.
 * 5. quotaEntry without a `model` (backward compat, no group scoping):
 *    exhausted only when EVERY bucket across every group is exhausted.
 * 6. profile.active / default profile -> 'selected'
 * 7. otherwise -> 'fallback'
 */
export function profileStateFor({ profile, quotaEntry = null, errorClass = null, model = null }) {
  if (errorClass === 'quota') return 'exhausted'
  if (errorClass === 'auth' || errorClass === 'billing') return 'unavailable'

  if (quotaEntry && typeof quotaEntry === 'object') {
    if (quotaEntry.exhausted === true || quotaEntry.quota?.exhausted === true) {
      return 'exhausted'
    }

    const groups = extractGroups(quotaEntry)
    if (model != null && groups.length > 0) {
      if (isModelExhaustedInGroups(groups, model)) return 'exhausted'
    } else {
      const buckets = extractBuckets(quotaEntry)
      if (buckets.length > 0 && buckets.every(isBucketExhausted)) {
        return 'exhausted'
      }
    }
  }

  const normalized = normalizeProfile(profile)
  if (normalized.active) return 'selected'
  return 'fallback'
}

// Each in-flight job on a profile costs 0.15 (15 percentage points) of its
// remaining-quota headroom in the load-aware score. Chosen so that a burst of
// same-quota jobs spreads across accounts immediately (a single in-flight job
// is already enough to flip a tie), while a profile with meaningfully more
// quota (e.g. +0.5 headroom) still wins several jobs in a row before a
// similar-quota idle profile becomes more attractive — see the T2 tests in
// test/providers-agys.test.mjs for the exact break-even math.
export const LOAD_PENALTY = 0.15

/**
 * Pure load-aware score for one profile: its remaining quota headroom (0..1)
 * minus a penalty per in-flight job it is already juggling in the same model
 * group. Returns null (never a number) when remainingQuota is null/unknown,
 * so the caller's sort keeps sorting "unknown quota" profiles last exactly
 * like plain remainingQuota did before load-awareness existed.
 */
export function scoreProfile(remainingQuota, inFlight = 0, loadPenalty = LOAD_PENALTY) {
  if (remainingQuota == null) return null
  const safeInFlight = Number.isFinite(inFlight) ? inFlight : 0
  return remainingQuota - loadPenalty * safeInFlight
}

// Two scores this close are treated as an exact tie (floating-point rounding
// noise from quota fraction math), not a real ranking difference.
const SCORE_TIE_EPSILON = 1e-9

/**
 * Ascending "least-recently-assigned" comparator: a profile with no recorded
 * assignment (never used for this model group) sorts as the OLDEST possible
 * assignment, so it wins a tie over any profile that was assigned at all.
 */
function byLastAssigned(a, b, lastAssignedByProfile) {
  const rawA = lastAssignedByProfile?.[a.normalized.name]
  const rawB = lastAssignedByProfile?.[b.normalized.name]
  const ta = typeof rawA === 'number' && Number.isFinite(rawA) ? rawA : -Infinity
  const tb = typeof rawB === 'number' && Number.isFinite(rawB) ? rawB : -Infinity
  if (ta === tb) return 0
  return ta - tb
}

function lastUsedRank(profile, usage) {
  const rawTs = usage?.lastUsedAt ?? profile?.lastUsedAt
  const parsed = rawTs ? Date.parse(rawTs) : NaN
  return Number.isFinite(parsed) ? parsed : -Infinity
}

// agys documents 'higher number = higher priority', so sort descending:
// b.priority - a.priority ensures the highest priority number is preferred first.
function byPriority(a, b) {
  return (b.normalized.priority ?? 0) - (a.normalized.priority ?? 0)
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
 *
 * When `model` is given, selection ignores `policy` and instead picks the
 * viable profile with the highest load-aware SCORE for that model's group:
 * `score = remainingQuota - LOAD_PENALTY * inFlight` (see scoreProfile()).
 * `inFlightByProfile` (profileName -> count of jobs currently running/queued
 * on it, already scoped to this model's group by the caller) and
 * `lastAssignedByProfile` (profileName -> most recent assignment timestamp
 * in that group) default to {}, which reduces the score to plain
 * remainingQuota and the tie-break to priority-then-name — byte-identical to
 * selectProfile()'s pre-T2 behaviour for any caller that does not pass them.
 * Two scores within SCORE_TIE_EPSILON tie-break by least-recently-assigned,
 * then priority, then name. A profile with no readable quota data (null
 * score) sorts after every profile with a known score, regardless of load.
 */
export function selectProfile({
  profiles = [],
  policy = 'priority',
  usageByProfile = {},
  model = null,
  inFlightByProfile = {},
  lastAssignedByProfile = {},
}) {
  if (!Array.isArray(profiles) || profiles.length === 0) return null
  if (!POLICIES.includes(policy)) throw new Error(`invalid policy: ${policy}`)

  const entries = profiles.map((p) => {
    const norm = normalizeProfile(p)
    const state = p?.state ?? profileStateFor({ profile: norm, quotaEntry: p?.quotaEntry ?? null, model })
    const usage = usageByProfile[norm.name] ?? usageByProfile[p?.id] ?? null
    const remainingQuota = model != null ? remainingQuotaForModel(p?.quotaEntry ?? null, model) : null
    const inFlight = inFlightByProfile?.[norm.name] ?? 0
    const score = model != null ? scoreProfile(remainingQuota, inFlight) : null
    return {
      profile: p,
      normalized: norm,
      state,
      usage,
      remainingQuota,
      inFlight,
      score,
    }
  })

  const viable = entries.filter((e) => e.state !== 'exhausted' && e.state !== 'unavailable')
  const pool = viable.length > 0 ? viable : []
  if (pool.length === 0) return null

  const sorted = pool.slice()
  if (model != null) {
    // Load-aware selection: highest score (remaining headroom minus in-flight
    // penalty) in the job's model group wins; unknown headroom (null score)
    // sorts last; a near-tie breaks by least-recently-assigned, then
    // priority, then name.
    sorted.sort((a, b) => {
      if (a.score == null && b.score == null) return byLastAssigned(a, b, lastAssignedByProfile) || byPriority(a, b) || byName(a, b)
      if (a.score == null) return 1
      if (b.score == null) return -1
      const diff = b.score - a.score
      if (Math.abs(diff) < SCORE_TIE_EPSILON) return byLastAssigned(a, b, lastAssignedByProfile) || byPriority(a, b) || byName(a, b)
      return diff
    })
  } else if (policy === 'least_used') {
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
