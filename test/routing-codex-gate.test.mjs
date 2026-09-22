import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CODEX_MIN_REMAINING_PCT,
  CODEX_PROMOTE_REMAINING_PCT,
  codexQuotaDecision,
} from '../src/routing/codex-gate.mjs'

// Fixed reference instant so window/pace math is deterministic across runs.
const NOW = Date.parse('2026-09-22T12:00:00Z')

function isoAfterMinutes(minutes) {
  return new Date(NOW + minutes * 60_000).toISOString()
}

/** Builds a quotaFor()-shaped result with one primary window. */
function quotaWithPrimary({ usedPercent, windowMinutes = 100, resetInMinutes = 50 }) {
  return {
    provider: 'codex',
    windows: [
      {
        id: 'codex-primary',
        label: 'Primary',
        usedPercent,
        usageKnown: true,
        resetsAt: isoAfterMinutes(resetInMinutes),
        windowMinutes,
      },
    ],
    exhausted: false,
    nextResetAt: null,
    dataConfidence: 'exact',
    fetchedAt: isoAfterMinutes(0),
  }
}

test('CODEX_MIN_REMAINING_PCT is 20 and CODEX_PROMOTE_REMAINING_PCT is 50', () => {
  assert.equal(CODEX_MIN_REMAINING_PCT, 20)
  assert.equal(CODEX_PROMOTE_REMAINING_PCT, 50)
})

test('codexQuotaDecision: real-shape example (usedPercent 89) drops codex — remaining 11% < 20%', () => {
  // {usage:{primary:{usedPercent:89, windowMinutes:43200, resetsAt:...}, secondary:null, dataConfidence:'exact'}}
  const quota = quotaWithPrimary({ usedPercent: 89, windowMinutes: 43200, resetInMinutes: 1000 })
  const decision = codexQuotaDecision({ quota, now: NOW })
  assert.deepEqual(decision, { action: 'drop', reason: 'quota_low', remainingPct: 11 })
})

test('codexQuotaDecision: remaining exactly 20% (usedPercent 80) is NOT dropped (strict <20)', () => {
  const quota = quotaWithPrimary({ usedPercent: 80, resetInMinutes: 50 })
  const decision = codexQuotaDecision({ quota, now: NOW })
  assert.equal(decision.action, 'unchanged')
  assert.equal(decision.remainingPct, 20)
})

test('codexQuotaDecision: remaining >=50% AND on pace (usedPercent/100 <= elapsedFraction) promotes', () => {
  // windowMinutes 100, resets in 50 -> elapsedFraction 0.5; usedPercent 30 -> 0.30 <= 0.5 -> on pace.
  const quota = quotaWithPrimary({ usedPercent: 30, windowMinutes: 100, resetInMinutes: 50 })
  const decision = codexQuotaDecision({ quota, now: NOW })
  assert.deepEqual(decision, { action: 'promote', reason: 'quota_headroom', remainingPct: 70 })
})

test('codexQuotaDecision: remaining exactly 50% AND on pace promotes (inclusive threshold)', () => {
  const quota = quotaWithPrimary({ usedPercent: 50, windowMinutes: 100, resetInMinutes: 50 })
  const decision = codexQuotaDecision({ quota, now: NOW })
  assert.equal(decision.action, 'promote')
  assert.equal(decision.remainingPct, 50)
})

test('codexQuotaDecision: remaining >=50% but AHEAD of pace (burn rate ahead of window) stays unchanged, not promoted', () => {
  // windowMinutes 100, resets in 70 -> elapsedFraction 0.3; usedPercent 45 -> remaining 55 (>=50) but 0.45 > 0.3 -> not on pace.
  const quota = quotaWithPrimary({ usedPercent: 45, windowMinutes: 100, resetInMinutes: 70 })
  const decision = codexQuotaDecision({ quota, now: NOW })
  assert.equal(decision.action, 'unchanged')
  assert.equal(decision.remainingPct, 55)
})

test('codexQuotaDecision: remaining between 20% and 50% stays unchanged regardless of pace', () => {
  const quota = quotaWithPrimary({ usedPercent: 65, windowMinutes: 100, resetInMinutes: 50 })
  const decision = codexQuotaDecision({ quota, now: NOW })
  assert.equal(decision.action, 'unchanged')
  assert.equal(decision.remainingPct, 35)
})

test('codexQuotaDecision: uses the MOST CONSTRAINED window when secondary is present and worse than primary', () => {
  const quota = {
    provider: 'codex',
    windows: [
      { id: 'codex-primary', label: 'Primary', usedPercent: 40, usageKnown: true, resetsAt: isoAfterMinutes(50), windowMinutes: 100 },
      { id: 'codex-secondary', label: 'Secondary', usedPercent: 85, usageKnown: true, resetsAt: isoAfterMinutes(50), windowMinutes: 100 },
    ],
  }
  const decision = codexQuotaDecision({ quota, now: NOW })
  assert.equal(decision.action, 'drop', 'secondary (remaining 15%) is more constrained than primary (remaining 60%)')
  assert.equal(decision.remainingPct, 15)
})

test('codexQuotaDecision: unknown/unreachable/stale quota never drops or promotes', () => {
  assert.deepEqual(codexQuotaDecision({ quota: null, now: NOW }), { action: 'unchanged', reason: 'unknown', remainingPct: null })
  assert.deepEqual(codexQuotaDecision({ quota: { quotaUnavailableReason: 'quota_pending' }, now: NOW }), { action: 'unchanged', reason: 'unknown', remainingPct: null })
  assert.deepEqual(
    codexQuotaDecision({ quota: { provider: 'codex', windows: [{ usageKnown: false }] }, now: NOW }),
    { action: 'unchanged', reason: 'unknown', remainingPct: null }
  )
  assert.deepEqual(
    codexQuotaDecision({ quota: { ...quotaWithPrimary({ usedPercent: 89 }), stale: true }, now: NOW }),
    { action: 'unchanged', reason: 'unknown', remainingPct: null }
  )
})

test('codexQuotaDecision: missing pace data (no resetsAt/windowMinutes) never promotes even with high remaining', () => {
  const quota = {
    provider: 'codex',
    windows: [{ id: 'codex-primary', label: 'Primary', usedPercent: 10, usageKnown: true, resetsAt: null, windowMinutes: null }],
  }
  const decision = codexQuotaDecision({ quota, now: NOW })
  assert.equal(decision.action, 'unchanged')
  assert.equal(decision.remainingPct, 90)
})
