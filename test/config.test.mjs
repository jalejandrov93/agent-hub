import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TIMEOUTS_S, resolveTimeoutS, KILL_GRACE_S, MODEL_REGISTRY, resolveVariant, CIRCUIT_BREAKER } from '../src/config.mjs'

test('agy timeouts match observed real runs (278s/303s on medium/high were being cut by the old 90s/180s defaults)', () => {
  assert.equal(DEFAULT_TIMEOUTS_S.agy['gemini-3.8-flash-low'], 300)
  assert.equal(DEFAULT_TIMEOUTS_S.agy['gemini-3.8-flash-medium'], 600)
  assert.equal(DEFAULT_TIMEOUTS_S.agy['gemini-3.8-flash-high'], 900)
  assert.equal(DEFAULT_TIMEOUTS_S.agy.default, 900)
  assert.equal(resolveTimeoutS('agy', 'gemini-3.8-flash-medium'), 600)
})

test('opencode default timeout is 600s', () => {
  assert.equal(DEFAULT_TIMEOUTS_S.opencode.default, 600)
  assert.equal(resolveTimeoutS('opencode', 'anything'), 600)
})

test('KILL_GRACE_S is exported and used as the buffer past the adapter timeout before the hub hard-kills', () => {
  assert.equal(KILL_GRACE_S, 30)
})

test('resolveVariant: explicit override beats the registry default', () => {
  assert.equal(resolveVariant('opencode', 'opencode/muse-spark-1.3-contributor-free', 'low'), 'low')
})

test('resolveVariant: falls back to the registry default when no override is given', () => {
  assert.equal(resolveVariant('opencode', 'opencode/muse-spark-1.3-contributor-free', undefined), 'high')
})

test('resolveVariant: null when neither an override nor a registry default exists', () => {
  assert.equal(resolveVariant('agy', 'gemini-3.8-flash-low', undefined), null)
})

test('the opencode Muse Spark 1.3 registry entry defaults to variant "high"', () => {
  assert.equal(MODEL_REGISTRY.opencode['opencode/muse-spark-1.3-contributor-free'].variant, 'high')
})

test('the circuit breaker treats billing as an immediate-open kind, distinct from the quota/canceled threshold', () => {
  assert.ok(CIRCUIT_BREAKER.failureKinds.has('billing'))
  assert.ok(CIRCUIT_BREAKER.immediateKinds.has('billing'))
  assert.ok(!CIRCUIT_BREAKER.immediateKinds.has('quota'))
})
