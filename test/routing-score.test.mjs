import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PREFERENCES,
  metricKey,
  normalizePreferences,
  rankCandidates,
} from '../src/routing/score.mjs'

test('DEFAULT_PREFERENCES is frozen and metricKey joins with colon', () => {
  assert.ok(Object.isFrozen(DEFAULT_PREFERENCES))
  assert.deepEqual(DEFAULT_PREFERENCES, { quality: 0.5, cost: 0.2, latency: 0.3 })
  assert.equal(metricKey('agy', 'gemini-3.8-flash-high'), 'agy:gemini-3.8-flash-high')
})

test('normalizePreferences: defaults when empty or all zero/negative', () => {
  assert.deepEqual(normalizePreferences(), DEFAULT_PREFERENCES)
  assert.deepEqual(normalizePreferences({}), DEFAULT_PREFERENCES)
  assert.deepEqual(normalizePreferences({ quality: 0, cost: 0, latency: 0 }), DEFAULT_PREFERENCES)
  assert.deepEqual(normalizePreferences({ quality: -1, cost: -2, latency: -3 }), DEFAULT_PREFERENCES)
})

test('normalizePreferences: drops negatives and weights sum to exactly 1', () => {
  const norm1 = normalizePreferences({ quality: 1, cost: 1, latency: 1 })
  const sum1 = norm1.quality + norm1.cost + norm1.latency
  assert.equal(sum1, 1)

  const norm2 = normalizePreferences({ quality: -5, cost: 2, latency: 8 })
  assert.equal(norm2.quality, 0)
  assert.equal(norm2.cost, 0.2)
  assert.equal(norm2.latency, 0.8)
  assert.equal(norm2.cost + norm2.latency, 1)
})

test('rankCandidates: requirements filter moves ineligible candidate to excluded with exact missing key', () => {
  const candidates = [
    { agent: 'agy', model: 'gemini-3.8-flash-high' },
    { agent: 'copilot', model: 'auto' },
  ]
  const { ranking, excluded } = rankCandidates({
    candidates,
    requirements: ['sessionResume'],
  })

  assert.equal(ranking.length, 1)
  assert.equal(ranking[0].agent, 'agy')
  assert.equal(excluded.length, 1)
  assert.deepEqual(excluded[0], {
    agent: 'copilot',
    model: 'auto',
    missing: ['sessionResume'],
  })
})

test('rankCandidates: candidate with NO metrics scores 0 with no data notes and normalized is null, not 0', () => {
  const candidates = [{ agent: 'agy', model: 'gemini-3.8-flash-low' }]
  const { ranking, excluded } = rankCandidates({ candidates, metrics: {} })

  assert.equal(excluded.length, 0)
  assert.equal(ranking.length, 1)
  const candidate = ranking[0]
  assert.equal(candidate.score, 0)
  assert.equal(candidate.reasons.length, 3)

  const [qReason, lReason, cReason] = candidate.reasons
  assert.equal(qReason.dimension, 'quality')
  assert.equal(qReason.normalized, null)
  assert.notEqual(qReason.normalized, 0)
  assert.equal(qReason.note, 'no data')

  assert.equal(lReason.dimension, 'latency')
  assert.equal(lReason.normalized, null)
  assert.equal(lReason.note, 'no data')

  assert.equal(cReason.dimension, 'cost')
  assert.equal(cReason.normalized, null)
  assert.equal(cReason.note, 'no data')
})

test('rankCandidates: quality-heavy preference ranks qualityScore 0.9 vs 0.4 first', () => {
  const candidates = [
    { agent: 'agy', model: 'gemini-3.8-flash-medium' },
    { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free' },
  ]
  const metrics = {
    [metricKey('agy', 'gemini-3.8-flash-medium')]: { qualityScore: 9 },
    [metricKey('opencode', 'opencode/muse-spark-1.3-contributor-free')]: { qualityScore: 4 },
  }
  const { ranking } = rankCandidates({
    candidates,
    metrics,
    preferences: { quality: 0.8, cost: 0.1, latency: 0.1 },
  })

  assert.equal(ranking.length, 2)
  assert.equal(ranking[0].agent, 'agy')
  assert.equal(ranking[1].agent, 'opencode')
  assert.ok(ranking[0].score > ranking[1].score)
})

test('rankCandidates: cost-heavy preference ranks cheaper candidate first', () => {
  const candidates = [
    { agent: 'agy', model: 'gemini-3.8-flash-low' },
    { agent: 'copilot', model: 'auto' },
  ]
  const metrics = {
    [metricKey('agy', 'gemini-3.8-flash-low')]: { costUsdAvg: 0.05 },
    [metricKey('copilot', 'auto')]: { costUsdAvg: 0.01 },
  }
  const { ranking } = rankCandidates({
    candidates,
    metrics,
    preferences: { cost: 0.9, quality: 0.05, latency: 0.05 },
  })

  assert.equal(ranking.length, 2)
  assert.equal(ranking[0].agent, 'copilot')
  assert.equal(ranking[1].agent, 'agy')
  assert.ok(ranking[0].score > ranking[1].score)
})

test('rankCandidates: stable tie keeps chain order', () => {
  const candidates = [
    { agent: 'agy', model: 'gemini-3.8-flash-low', id: 1 },
    { agent: 'opencode', model: 'opencode/muse-spark-1.3-contributor-free', id: 2 },
  ]
  const { ranking } = rankCandidates({ candidates, metrics: {} })

  assert.equal(ranking[0].id, 1)
  assert.equal(ranking[1].id, 2)
})

test('rankCandidates: missing costUsdAvg/qualityScore (undefined) never becomes 0', () => {
  const candidates = [{ agent: 'agy', model: 'gemini-3.8-flash-low' }]
  const metrics = {
    [metricKey('agy', 'gemini-3.8-flash-low')]: { p95Ms: 120 },
  }
  const { ranking } = rankCandidates({ candidates, metrics })

  assert.equal(ranking.length, 1)
  const [qReason, lReason, cReason] = ranking[0].reasons
  assert.equal(qReason.raw, null)
  assert.equal(qReason.normalized, null)
  assert.notEqual(qReason.normalized, 0)
  assert.equal(qReason.note, 'no data')

  assert.equal(lReason.raw, 120)
  assert.equal(lReason.normalized, 1)
  assert.equal(lReason.note, null)

  assert.equal(cReason.raw, null)
  assert.equal(cReason.normalized, null)
  assert.notEqual(cReason.normalized, 0)
  assert.equal(cReason.note, 'no data')

  assert.equal(ranking[0].score, 1)
})
