import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectAccount } from '../../src/cloud/selectAccount.mjs'

const env = {}

function account(id, overrides = {}) {
  return {
    id,
    enabled: true,
    priority: 0,
    dailyLimit: 100,
    concurrentLimit: 15,
    lastUsedAt: null,
    ...overrides,
  }
}

function harness({ accounts, usage = {}, cache = {} }) {
  return {
    listAccountsFn: () => accounts,
    usageForFn: (id) => usage[id] ?? { running: 0, last24h: 0 },
    readSourcesCacheFn: () => cache,
  }
}

const select = (args) => selectAccount({ env, policy: 'round_robin', ...args })

test('round_robin prefers a never-used account over any used one', () => {
  const { listAccountsFn, usageForFn, readSourcesCacheFn } = harness({
    accounts: [
      account('used-recent', { lastUsedAt: '2026-09-15T00:00:00.000Z', priority: 0 }),
      account('never-used', { lastUsedAt: null, priority: 5 }),
      account('used-old', { lastUsedAt: '2026-01-01T00:00:00.000Z', priority: 1 }),
    ],
  })

  const result = select({ policy: 'round_robin', listAccountsFn, usageForFn, readSourcesCacheFn })
  assert.deepEqual(result, { accountId: 'never-used', reason: 'round_robin' })
})

test('round_robin picks the oldest lastUsedAt once every account has been used', () => {
  const { listAccountsFn, usageForFn, readSourcesCacheFn } = harness({
    accounts: [
      account('a', { lastUsedAt: '2026-09-15T00:00:00.000Z' }),
      account('b', { lastUsedAt: '2026-01-01T00:00:00.000Z' }),
      account('c', { lastUsedAt: '2026-05-01T00:00:00.000Z' }),
    ],
  })

  const result = select({ policy: 'round_robin', listAccountsFn, usageForFn, readSourcesCacheFn })
  assert.equal(result.accountId, 'b')
})

test('least_used picks the account with the lowest 24h usage', () => {
  const { listAccountsFn, usageForFn, readSourcesCacheFn } = harness({
    accounts: [account('busy'), account('idle'), account('medium')],
    usage: { busy: { running: 0, last24h: 40 }, idle: { running: 0, last24h: 3 }, medium: { running: 0, last24h: 12 } },
  })

  const result = select({ policy: 'least_used', listAccountsFn, usageForFn, readSourcesCacheFn })
  assert.deepEqual(result, { accountId: 'idle', reason: 'least_used' })
})

test('priority picks the lowest priority field regardless of usage', () => {
  const { listAccountsFn, usageForFn, readSourcesCacheFn } = harness({
    accounts: [account('p5', { priority: 5 }), account('p1', { priority: 1 }), account('p9', { priority: 9 })],
    usage: { p1: { running: 0, last24h: 90 } },
  })

  const result = select({ policy: 'priority', listAccountsFn, usageForFn, readSourcesCacheFn })
  assert.deepEqual(result, { accountId: 'p1', reason: 'priority' })
})

test('quota filter drops an account at its daily limit or concurrent limit', () => {
  const { listAccountsFn, usageForFn, readSourcesCacheFn } = harness({
    accounts: [
      account('daily-full', { dailyLimit: 100 }),
      account('concurrent-full', { concurrentLimit: 15 }),
      account('ok'),
    ],
    usage: {
      'daily-full': { running: 0, last24h: 100 },
      'concurrent-full': { running: 15, last24h: 1 },
      ok: { running: 1, last24h: 1 },
    },
  })

  const result = select({ policy: 'round_robin', listAccountsFn, usageForFn, readSourcesCacheFn })
  assert.equal(result.accountId, 'ok')
})

test('when every enabled account is quota-exhausted the result is empty with reason quota_exhausted', () => {
  const { listAccountsFn, usageForFn, readSourcesCacheFn } = harness({
    accounts: [account('a'), account('b')],
    usage: { a: { running: 0, last24h: 100 }, b: { running: 15, last24h: 0 } },
  })

  assert.deepEqual(select({ listAccountsFn, usageForFn, readSourcesCacheFn }), { accountId: null, reason: 'quota_exhausted' })
})

test('a disabled account is never selected; with none enabled the reason is no_accounts', () => {
  const { listAccountsFn, usageForFn, readSourcesCacheFn } = harness({
    accounts: [account('off', { enabled: false }), account('also-off', { enabled: false })],
  })

  assert.deepEqual(select({ listAccountsFn, usageForFn, readSourcesCacheFn }), { accountId: null, reason: 'no_accounts' })
})

test('preferredAccountId is honoured when it is enabled and has quota', () => {
  const { listAccountsFn, usageForFn, readSourcesCacheFn } = harness({
    accounts: [account('a', { lastUsedAt: null }), account('preferred', { lastUsedAt: '2026-09-15T00:00:00.000Z' })],
  })

  const result = select({ preferredAccountId: 'preferred', listAccountsFn, usageForFn, readSourcesCacheFn })
  assert.deepEqual(result, { accountId: 'preferred', reason: 'preferred' })
})

test('preferredAccountId is ignored when that account is disabled or quota-exhausted', () => {
  const disabled = harness({ accounts: [account('preferred', { enabled: false }), account('other')] })
  assert.equal(select({ preferredAccountId: 'preferred', ...disabled }).accountId, 'other')

  const exhausted = harness({
    accounts: [account('preferred'), account('other')],
    usage: { preferred: { running: 0, last24h: 100 } },
  })
  assert.equal(select({ preferredAccountId: 'preferred', ...exhausted }).accountId, 'other')
})

test('accounts KNOWN to have the source win over accounts whose sources are unknown (second tier)', () => {
  const { listAccountsFn, usageForFn, readSourcesCacheFn } = harness({
    accounts: [
      account('known', { lastUsedAt: '2026-09-15T00:00:00.000Z' }),
      // Older lastUsedAt, so without tiering round_robin would pick this one.
      account('unknown', { lastUsedAt: '2020-01-01T00:00:00.000Z' }),
    ],
    cache: {
      known: { status: 'ok', sources: ['sources/github/acme/widgets'] },
      unknown: { status: 'no_source_access', sources: [] },
    },
  })

  const result = select({ source: 'sources/github/acme/widgets', listAccountsFn, usageForFn, readSourcesCacheFn })
  assert.equal(result.accountId, 'known')
})

test('an account with unknown sources stays eligible when no account is known to have the source', () => {
  const { listAccountsFn, usageForFn, readSourcesCacheFn } = harness({
    accounts: [account('unknown', { lastUsedAt: '2020-01-01T00:00:00.000Z' }), account('lacks', { lastUsedAt: '2026-09-15T00:00:00.000Z' })],
    cache: {
      unknown: { status: 'error', sources: [] },
      lacks: { status: 'ok', sources: ['sources/github/acme/gadgets'] },
    },
  })

  const result = select({ source: 'sources/github/acme/widgets', listAccountsFn, usageForFn, readSourcesCacheFn })
  assert.equal(result.accountId, 'unknown', 'the unknown-sources account must not be dropped in favour of a known-lacking one')
})

test('an account with no cache entry at all is treated as unknown sources, not as lacking the source', () => {
  const { listAccountsFn, usageForFn, readSourcesCacheFn } = harness({
    accounts: [account('uncached'), account('lacks')],
    cache: { lacks: { status: 'ok', sources: ['sources/github/acme/gadgets'] } },
  })

  const result = select({ source: 'sources/github/acme/widgets', listAccountsFn, usageForFn, readSourcesCacheFn })
  assert.equal(result.accountId, 'uncached')
})

test('when the source is known to be absent from every account the result is empty with reason source_unavailable', () => {
  const { listAccountsFn, usageForFn, readSourcesCacheFn } = harness({
    accounts: [account('a'), account('b')],
    cache: {
      a: { status: 'ok', sources: ['sources/github/acme/gadgets'] },
      b: { status: 'ok', sources: ['sources/github/acme/other'] },
    },
  })

  assert.deepEqual(select({ source: 'sources/github/acme/widgets', listAccountsFn, usageForFn, readSourcesCacheFn }), {
    accountId: null,
    reason: 'source_unavailable',
  })
})

test('an invalid policy throws "invalid policy: <value>"', () => {
  const { listAccountsFn, usageForFn, readSourcesCacheFn } = harness({ accounts: [account('a')] })
  assert.throws(() => select({ policy: 'bogus', listAccountsFn, usageForFn, readSourcesCacheFn }), /invalid policy: bogus/)
})
