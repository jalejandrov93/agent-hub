import { test } from 'node:test'
import assert from 'node:assert/strict'
import { catalogTier, effectiveTier, computeCatalogDrift } from '../src/catalog.mjs'

const FRESH = new Date().toISOString()
const STALE = new Date(Date.now() - 20 * 60 * 1000).toISOString() // > PREFLIGHT_TTL_MS (15m)

// --- catalogTier ---

test('catalogTier: free when the first cost entry has input:0 and output:0', () => {
  const entry = { id: 'opencode/big-pickle', cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] }
  assert.equal(catalogTier(entry), 'free')
})

test('catalogTier: paid when input > 0', () => {
  const entry = { id: 'deepseek/deepseek-v4-pro', cost: [{ input: 0.27, output: 1.1 }] }
  assert.equal(catalogTier(entry), 'paid')
})

test('catalogTier: paid when only output > 0', () => {
  const entry = { id: 'x', cost: [{ input: 0, output: 0.5 }] }
  assert.equal(catalogTier(entry), 'paid')
})

test('catalogTier: unknown (null), never free, when cost is missing', () => {
  assert.equal(catalogTier({ id: 'x' }), null)
})

test('catalogTier: unknown (null) when cost is an empty array', () => {
  assert.equal(catalogTier({ id: 'x', cost: [] }), null)
})

// --- effectiveTier ---

test('effectiveTier: uses the live catalog tier when the discovery row is fresh, error-free and lists the model', () => {
  const discovery = {
    opencode: {
      checkedAt: FRESH,
      error: null,
      models: [{ id: 'opencode/big-pickle', cost: [{ input: 0, output: 0 }] }],
    },
  }
  const registry = { opencode: {} } // no registry entry at all -- catalog wins
  const result = effectiveTier({ agent: 'opencode', model: 'opencode/big-pickle', discovery, registry })
  assert.deepEqual(result, { tier: 'free', tierSource: 'catalog' })
})

test('effectiveTier: falls back to the registry tier when the discovery row is stale', () => {
  const discovery = {
    opencode: {
      checkedAt: STALE,
      error: null,
      models: [{ id: 'opencode/big-pickle', cost: [{ input: 0, output: 0 }] }],
    },
  }
  const registry = { opencode: { 'opencode/big-pickle': { tier: 'free' } } }
  const result = effectiveTier({ agent: 'opencode', model: 'opencode/big-pickle', discovery, registry })
  assert.deepEqual(result, { tier: 'free', tierSource: 'registry' })
})

test('effectiveTier: falls back to the registry tier when the discovery row has an error', () => {
  const discovery = {
    opencode: { checkedAt: FRESH, error: 'model list timed out', models: [] },
  }
  const registry = { opencode: { 'opencode/big-pickle': { tier: 'free' } } }
  const result = effectiveTier({ agent: 'opencode', model: 'opencode/big-pickle', discovery, registry })
  assert.deepEqual(result, { tier: 'free', tierSource: 'registry' })
})

test('effectiveTier: falls back to the registry tier when the fresh catalog does not list the model', () => {
  const discovery = { opencode: { checkedAt: FRESH, error: null, models: [{ id: 'opencode/other-model' }] } }
  const registry = { opencode: { 'opencode/big-pickle': { tier: 'free' } } }
  const result = effectiveTier({ agent: 'opencode', model: 'opencode/big-pickle', discovery, registry })
  assert.deepEqual(result, { tier: 'free', tierSource: 'registry' })
})

test('effectiveTier: null tier, registry source, when neither the catalog nor the registry knows the model', () => {
  const result = effectiveTier({ agent: 'opencode', model: 'opencode/unknown', discovery: {}, registry: { opencode: {} } })
  assert.deepEqual(result, { tier: null, tierSource: 'registry' })
})

// --- computeCatalogDrift ---

const MAP = {
  recon: { why: 'x', chain: [{ agent: 'opencode', model: 'opencode/nemotron-3-ultra-free', mode: 'read' }] },
}

test('computeCatalogDrift: reports a pinned registry id that vanished from the live catalog', () => {
  const discovery = { opencode: { checkedAt: FRESH, error: null, models: [{ id: 'opencode/big-pickle', cost: [{ input: 0, output: 0 }] }] } }
  const registry = { opencode: { 'opencode/mimo-v2.5-free': { tier: 'free' } } }
  const drift = computeCatalogDrift({ discovery, map: {}, registry })
  assert.ok(drift.some((d) => d.type === 'vanished' && d.model === 'opencode/mimo-v2.5-free'))
})

test('computeCatalogDrift: reports a pinned MODEL_REGISTRY/DELEGATION_MAP id that vanished, even if only referenced by the map', () => {
  const discovery = { opencode: { checkedAt: FRESH, error: null, models: [{ id: 'opencode/big-pickle', cost: [{ input: 0, output: 0 }] }] } }
  const drift = computeCatalogDrift({ discovery, map: MAP, registry: { opencode: {} } })
  assert.ok(drift.some((d) => d.type === 'vanished' && d.model === 'opencode/nemotron-3-ultra-free'))
})

test('computeCatalogDrift: reports a registry tier:free model whose live cost is now > 0 (a money bug)', () => {
  const discovery = {
    opencode: { checkedAt: FRESH, error: null, models: [{ id: 'opencode/mimo-v2.5-free', cost: [{ input: 0.1, output: 0.1 }] }] },
  }
  const registry = { opencode: { 'opencode/mimo-v2.5-free': { tier: 'free' } } }
  const drift = computeCatalogDrift({ discovery, map: {}, registry })
  assert.ok(drift.some((d) => d.type === 'now_paid' && d.model === 'opencode/mimo-v2.5-free'))
})

test('computeCatalogDrift: reports a catalog free model absent from the registry', () => {
  const discovery = {
    opencode: { checkedAt: FRESH, error: null, models: [{ id: 'opencode/space-bunny-free', cost: [{ input: 0, output: 0 }] }] },
  }
  const drift = computeCatalogDrift({ discovery, map: {}, registry: { opencode: {} } })
  assert.ok(drift.some((d) => d.type === 'new_free' && d.model === 'opencode/space-bunny-free'))
})

test('computeCatalogDrift: reports a pinned registry variant no longer in the catalog variants[]', () => {
  const discovery = {
    opencode: {
      checkedAt: FRESH,
      error: null,
      models: [{ id: 'opencode/nemotron-3-ultra-free', cost: [{ input: 0, output: 0 }], variants: [] }],
    },
  }
  const registry = { opencode: { 'opencode/nemotron-3-ultra-free': { tier: 'free', variant: 'high' } } }
  const drift = computeCatalogDrift({ discovery, map: {}, registry })
  assert.ok(drift.some((d) => d.type === 'variant_unavailable' && d.model === 'opencode/nemotron-3-ultra-free' && d.variant === 'high'))
})

test('computeCatalogDrift: returns nothing for a stale discovery row (never falsely flags "vanished")', () => {
  const discovery = { opencode: { checkedAt: STALE, error: null, models: [] } }
  const registry = { opencode: { 'opencode/big-pickle': { tier: 'free' } } }
  assert.deepEqual(computeCatalogDrift({ discovery, map: {}, registry }), [])
})

test('computeCatalogDrift: returns nothing for an errored discovery row', () => {
  const discovery = { opencode: { checkedAt: FRESH, error: 'model list timed out', models: [] } }
  const registry = { opencode: { 'opencode/big-pickle': { tier: 'free' } } }
  assert.deepEqual(computeCatalogDrift({ discovery, map: {}, registry }), [])
})

test('computeCatalogDrift: returns nothing when there is no discovery row for the agent at all', () => {
  assert.deepEqual(computeCatalogDrift({ discovery: {}, map: {}, registry: { opencode: {} } }), [])
})
