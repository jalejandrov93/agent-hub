import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveEffectiveTimeoutS } from '../src/timeouts.mjs'
import { resolveTimeoutS, ADAPTIVE_TIMEOUT, METRICS_MIN_SAMPLES } from '../src/config.mjs'

/**
 * Tests for P3 adaptive timeouts.
 *
 * Verifies that explicit overrides always take precedence, observed p95
 * latencies raise the static timeout default only when statistically
 * sufficient samples exist, and failures during metrics retrieval fall
 * back gracefully to default timeouts without aborting delegation.
 */

test('explicit timeout overrides all metrics and defaults', () => {
  const result = resolveEffectiveTimeoutS({
    agent: 'agy',
    model: 'gemini-3.8-flash-medium',
    explicit: 45,
    metricsForFn: () => ({ samples: 100, p95Ms: 120000 }),
  })
  assert.deepEqual(result, {
    timeoutS: 45,
    source: 'explicit',
    p95Ms: null,
    samples: 0,
  })
})

test('missing metrics row falls back to base default', () => {
  const base = resolveTimeoutS('agy', 'gemini-3.8-flash-medium')
  const result = resolveEffectiveTimeoutS({
    agent: 'agy',
    model: 'gemini-3.8-flash-medium',
    metricsForFn: () => null,
  })
  assert.deepEqual(result, {
    timeoutS: base,
    source: 'default',
    p95Ms: null,
    samples: 0,
  })
})

test('thin samples below METRICS_MIN_SAMPLES fall back to base default while reporting stats', () => {
  const base = resolveTimeoutS('copilot', 'gpt-5-mini')
  const row = { samples: METRICS_MIN_SAMPLES - 1, p95Ms: 500000 }
  const result = resolveEffectiveTimeoutS({
    agent: 'copilot',
    model: 'gpt-5-mini',
    metricsForFn: () => row,
  })
  assert.deepEqual(result, {
    timeoutS: base,
    source: 'default',
    p95Ms: 500000,
    samples: METRICS_MIN_SAMPLES - 1,
  })
})

test('metrics with null p95Ms fall back to base default', () => {
  const base = resolveTimeoutS('copilot', 'gpt-5-mini')
  const row = { samples: METRICS_MIN_SAMPLES + 5, p95Ms: null }
  const result = resolveEffectiveTimeoutS({
    agent: 'copilot',
    model: 'gpt-5-mini',
    metricsForFn: () => row,
  })
  assert.deepEqual(result, {
    timeoutS: base,
    source: 'default',
    p95Ms: null,
    samples: METRICS_MIN_SAMPLES + 5,
  })
})

test('adaptive timeout raises base when adaptive exceeds base', () => {
  const base = resolveTimeoutS('copilot', 'gpt-5-mini') // 300s
  // 300s * 1000 = 300000ms. Set p95Ms to 250000ms (250s * 1.5 = 375s > 300s).
  const p95Ms = 250000
  const expectedAdaptive = Math.ceil((p95Ms / 1000) * ADAPTIVE_TIMEOUT.multiplier)
  assert.ok(expectedAdaptive > base)

  const result = resolveEffectiveTimeoutS({
    agent: 'copilot',
    model: 'gpt-5-mini',
    metricsForFn: () => ({ samples: METRICS_MIN_SAMPLES, p95Ms }),
  })
  assert.deepEqual(result, {
    timeoutS: expectedAdaptive,
    source: 'adaptive',
    p95Ms,
    samples: METRICS_MIN_SAMPLES,
  })
})

test('adaptive timeout preserves base when adaptive is less than or equal to base', () => {
  const base = resolveTimeoutS('agy', 'gemini-3.8-flash-high') // 900s
  // 100s * 1.5 = 150s <= 900s
  const p95Ms = 100000
  const result = resolveEffectiveTimeoutS({
    agent: 'agy',
    model: 'gemini-3.8-flash-high',
    metricsForFn: () => ({ samples: METRICS_MIN_SAMPLES + 2, p95Ms }),
  })
  assert.deepEqual(result, {
    timeoutS: base,
    source: 'default',
    p95Ms,
    samples: METRICS_MIN_SAMPLES + 2,
  })
})

test('adaptive timeout is capped at ADAPTIVE_TIMEOUT.capS', () => {
  // 5000s * 1.5 = 7500s > capS (3600s)
  const p95Ms = 5000000
  const result = resolveEffectiveTimeoutS({
    agent: 'copilot',
    model: 'gpt-5-mini',
    metricsForFn: () => ({ samples: 50, p95Ms }),
  })
  assert.deepEqual(result, {
    timeoutS: ADAPTIVE_TIMEOUT.capS,
    source: 'adaptive',
    p95Ms,
    samples: 50,
  })
})

test('thin taskType row falls back to qualified taskType: null row', () => {
  const base = resolveTimeoutS('copilot', 'gpt-5-mini') // 300s
  const fallbackP95Ms = 400000 // 400s * 1.5 = 600s > 300s
  const expectedAdaptive = Math.ceil((fallbackP95Ms / 1000) * ADAPTIVE_TIMEOUT.multiplier)

  const metricsForFn = ({ taskType }) => {
    if (taskType === 'recon') {
      return { samples: 2, p95Ms: 100000 }
    }
    if (taskType === null) {
      return { samples: 20, p95Ms: fallbackP95Ms }
    }
    return null
  }

  const result = resolveEffectiveTimeoutS({
    agent: 'copilot',
    model: 'gpt-5-mini',
    taskType: 'recon',
    metricsForFn,
  })

  assert.deepEqual(result, {
    timeoutS: expectedAdaptive,
    source: 'adaptive',
    p95Ms: fallbackP95Ms,
    samples: 20,
  })
})

test('thin taskType row and thin fallback row default to base timeout', () => {
  const base = resolveTimeoutS('copilot', 'gpt-5-mini')

  const metricsForFn = ({ taskType }) => {
    if (taskType === 'recon') {
      return { samples: 2, p95Ms: 100000 }
    }
    if (taskType === null) {
      return { samples: 3, p95Ms: 200000 }
    }
    return null
  }

  const result = resolveEffectiveTimeoutS({
    agent: 'copilot',
    model: 'gpt-5-mini',
    taskType: 'recon',
    metricsForFn,
  })

  assert.deepEqual(result, {
    timeoutS: base,
    source: 'default',
    p95Ms: 100000,
    samples: 2,
  })
})

test('metricsForFn throwing an error safely falls back to base default', () => {
  const base = resolveTimeoutS('agy', 'gemini-3.8-flash-low')
  const result = resolveEffectiveTimeoutS({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    metricsForFn: () => {
      throw new Error('disk read failed')
    },
  })

  assert.deepEqual(result, {
    timeoutS: base,
    source: 'default',
    p95Ms: null,
    samples: 0,
  })
})
