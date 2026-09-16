import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fetchUsage } from '../src/quota/codexbar.mjs'

function isolated() {
  return { AGENT_HUB_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-codexbar-')) }
}

// A fetchImpl that respects the AbortSignal it's given, like the real global
// fetch does — so a background fetch using it settles (with codexbar_timeout)
// once its short timeoutMs fires, instead of leaving a promise permanently
// pending in codexbar.mjs's module-level dedupe map for the rest of the
// process (which would also keep a real 45s timer alive past this test).
function neverResolvesUntilAborted() {
  return (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      if (signal) signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })))
    })
}

function okJson(data) {
  return async () => ({ ok: true, json: async () => data })
}

const antigravityUsage = [{ provider: 'antigravity', usage: { primary: { usedPercent: 5 } } }]

test('cached mode returns without ever awaiting the network', async () => {
  const env = isolated()
  const before = Date.now()
  // Distinct provider name: this starts a background fetch (empty cache)
  // that only settles once its short timeoutMs fires, so it never collides
  // with another test's in-flight fetch for the same provider key.
  const result = await fetchUsage({
    providers: ['antigravity-never-resolves'],
    env,
    mode: 'cached',
    fetchImpl: neverResolvesUntilAborted(),
    timeoutMs: 50,
  })
  const elapsed = Date.now() - before
  assert.ok(elapsed < 200, `fetchUsage({mode:'cached'}) must not await the network, took ${elapsed}ms`)
  assert.deepEqual(result['antigravity-never-resolves'], { pending: true })
  await result.background // let the short-timeout background fetch settle before the test ends
})

test('cached mode with an empty cache: pending now, one background fetch, cache holds data after it resolves', async () => {
  const env = isolated()
  let calls = 0
  const fetchImpl = async (url) => {
    calls++
    return { ok: true, json: async () => antigravityUsage }
  }

  const first = await fetchUsage({ providers: ['antigravity'], env, mode: 'cached', fetchImpl })
  assert.deepEqual(first.antigravity, { pending: true })
  assert.equal(typeof first.background.then, 'function', 'background promise must be exposed')

  await first.background
  assert.equal(calls, 1)

  const second = await fetchUsage({ providers: ['antigravity'], env, mode: 'cached', fetchImpl })
  assert.equal(second.antigravity.stale, false)
  assert.ok(second.antigravity.cachedAt)
  assert.deepEqual(second.antigravity[0], antigravityUsage[0])
})

test('cached mode with a stale (past-TTL) entry: returns old data marked stale, refreshes in the background', async () => {
  const env = isolated()
  const cacheFile = path.join(env.AGENT_HUB_HOME, 'quota-cache.json')
  const oldData = [{ provider: 'antigravity', usage: { primary: { usedPercent: 1 } } }]
  const staleTimestamp = Date.now() - 6 * 60 * 1000 // 6 minutes ago, past the 5-minute TTL
  fs.writeFileSync(cacheFile, JSON.stringify({ antigravity: { data: oldData, timestamp: staleTimestamp } }))

  let calls = 0
  const fetchImpl = async () => {
    calls++
    return { ok: true, json: async () => antigravityUsage }
  }

  const result = await fetchUsage({ providers: ['antigravity'], env, mode: 'cached', fetchImpl })
  assert.equal(result.antigravity.stale, true)
  assert.ok(result.antigravity.cachedAt)
  assert.equal(result.antigravity[0].usage.primary.usedPercent, 1, 'old data is returned immediately, not the fresh fetch')

  await result.background
  assert.equal(calls, 1)

  const onDisk = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
  assert.deepEqual(onDisk.antigravity.data, antigravityUsage)
})

test('cached mode dedupes concurrent background fetches for the same missing provider', async () => {
  const env = isolated()
  let calls = 0
  const fetchImpl = async () => {
    calls++
    await new Promise((r) => setTimeout(r, 20))
    return { ok: true, json: async () => antigravityUsage }
  }

  const [a, b] = await Promise.all([
    fetchUsage({ providers: ['antigravity'], env, mode: 'cached', fetchImpl }),
    fetchUsage({ providers: ['antigravity'], env, mode: 'cached', fetchImpl }),
  ])

  await Promise.all([a.background, b.background])
  assert.equal(calls, 1, 'two concurrent cached calls for the same missing provider must start only one fetch')
})

test('a background fetch that rejects produces no unhandled rejection and writes nothing to the cache', async () => {
  const env = isolated()
  const cacheFile = path.join(env.AGENT_HUB_HOME, 'quota-cache.json')
  const fetchImpl = async () => {
    throw new Error('boom')
  }

  const result = await fetchUsage({ providers: ['antigravity'], env, mode: 'cached', fetchImpl })
  await result.background // must not throw

  assert.equal(fs.existsSync(cacheFile), false)
})

test('live mode keeps awaiting the network and defaults to a 45s timeout', async () => {
  const env = isolated()
  const originalTimeout = AbortSignal.timeout
  const seen = []
  AbortSignal.timeout = (ms) => {
    seen.push(ms)
    return originalTimeout(60000) // do not actually let the real timeout fire during the test
  }
  try {
    const result = await fetchUsage({ providers: ['antigravity'], env, mode: 'live', fetchImpl: okJson(antigravityUsage) })
    assert.deepEqual(result.antigravity, antigravityUsage)
    assert.deepEqual(seen, [45000])
  } finally {
    AbortSignal.timeout = originalTimeout
  }
})

test('timeout classification: TimeoutError and AbortError both become codexbar_timeout', async () => {
  const env = isolated()
  const timeoutError = async () => {
    throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })
  }
  const abortError = async () => {
    throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
  }

  const result1 = await fetchUsage({ providers: ['antigravity'], env, mode: 'live', fetchImpl: timeoutError })
  assert.equal(result1.antigravity.error, 'codexbar_timeout')

  const result2 = await fetchUsage({ providers: ['copilot'], env, mode: 'live', fetchImpl: abortError })
  assert.equal(result2.copilot.error, 'codexbar_timeout')
})

test('a generic network failure classifies as codexbar_unreachable, and a non-2xx as codexbar_http_<status>', async () => {
  const env = isolated()
  const networkFail = async () => {
    throw new Error('ECONNREFUSED')
  }
  const result1 = await fetchUsage({ providers: ['antigravity'], env, mode: 'live', fetchImpl: networkFail })
  assert.equal(result1.antigravity.error, 'codexbar_unreachable')

  const http500 = async () => ({ ok: false, status: 500 })
  const result2 = await fetchUsage({ providers: ['copilot'], env, mode: 'live', fetchImpl: http500 })
  assert.equal(result2.copilot.error, 'codexbar_http_500')
})
