/**
 * Quota-gated codex routing (T4). codex is a LAST-resort-only fallback in the
 * `triage` and `mechanical-edit` chains (see src/router.mjs DELEGATION_MAP;
 * codex is tier 'limited' in src/config.mjs) because its plan quota is
 * scarce. This is the one deliberate exception to "quota is informational
 * only, never chooses/skips/reorders a candidate" (src/router.mjs): when
 * codex's OWN plan quota is low, it is dropped from the chain entirely
 * (never even attempted as a last resort); when it clearly has headroom to
 * spare, it is promoted ahead of the other fallback(s) instead of being
 * saved for last. Every other agent's ordering is untouched by this module.
 *
 * Pure with respect to its inputs: `quota` is a quotaFor()-shaped result
 * (src/quota/mapping.mjs) for {agent:'codex', model:'default'}, and `now` is
 * injectable so callers/tests never depend on wall-clock time.
 */

/** Below this remaining-quota percentage, codex is dropped from the chain entirely. */
export const CODEX_MIN_REMAINING_PCT = 20

/** At or above this remaining-quota percentage (and on pace), codex is promoted to position 2. */
export const CODEX_PROMOTE_REMAINING_PCT = 50

const UNKNOWN_DECISION = Object.freeze({ action: 'unchanged', reason: 'unknown', remainingPct: null })

/**
 * Reads one quotaFor() window into { remainingPct, onPace }, or null when
 * the window has no usable usedPercent. `onPace` is null (not false!) when
 * there is not enough data (resetsAt/windowMinutes) to compute a burn rate —
 * the caller must treat a null onPace as "cannot promote", never as "ahead
 * of pace".
 */
function readWindow(window, now) {
  if (!window || window.usageKnown === false || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) {
    return null
  }
  const remainingPct = 100 - window.usedPercent

  let onPace = null
  const resetMs = typeof window.resetsAt === 'string' ? Date.parse(window.resetsAt) : NaN
  const windowMinutes = typeof window.windowMinutes === 'number' ? window.windowMinutes : NaN
  if (Number.isFinite(resetMs) && Number.isFinite(windowMinutes) && windowMinutes > 0) {
    const totalMs = windowMinutes * 60_000
    const msUntilReset = resetMs - now
    const elapsedFraction = Math.max(0, Math.min(1, 1 - msUntilReset / totalMs))
    onPace = window.usedPercent / 100 <= elapsedFraction
  }

  return { remainingPct, onPace }
}

/**
 * Decides what to do with the codex candidate given its own quotaFor()
 * result: 'drop' (remove entirely), 'promote' (move to position 2), or
 * 'unchanged' (leave as the last-resort fallback it already is). Never
 * drops or promotes on missing/stale/unreachable data.
 */
export function codexQuotaDecision({ quota, now = Date.now() } = {}) {
  if (!quota || typeof quota !== 'object' || quota.quotaUnavailableReason || quota.stale === true) {
    return UNKNOWN_DECISION
  }

  const windows = Array.isArray(quota.windows) ? quota.windows : []
  const evaluated = windows.map((w) => readWindow(w, now)).filter((w) => w != null)
  if (evaluated.length === 0) {
    return UNKNOWN_DECISION
  }

  // The most constrained window (lowest remaining headroom) governs both the
  // drop threshold and the promote pace check: a job in this model's plan
  // would still 429 on the empty window even if another window has room.
  const worst = evaluated.reduce((a, b) => (b.remainingPct < a.remainingPct ? b : a))

  if (worst.remainingPct < CODEX_MIN_REMAINING_PCT) {
    return { action: 'drop', reason: 'quota_low', remainingPct: worst.remainingPct }
  }

  if (worst.remainingPct >= CODEX_PROMOTE_REMAINING_PCT && worst.onPace === true) {
    return { action: 'promote', reason: 'quota_headroom', remainingPct: worst.remainingPct }
  }

  return { action: 'unchanged', reason: 'ok', remainingPct: worst.remainingPct }
}
