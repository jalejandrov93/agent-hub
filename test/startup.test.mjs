import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { scheduleStartupDiscovery, scheduleQuotaWarmup } from '../src/startup.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-startup-'))
}

function fakeRunner(responses) {
  const calls = []
  const runner = async (cmd, args) => {
    calls.push({ cmd, args })
    const key = `${cmd} ${args.join(' ')}`
    for (const [pattern, response] of responses) {
      if (typeof pattern === 'string' ? key.includes(pattern) : pattern.test(key)) return response
    }
    throw new Error(`fakeRunner: no response configured for "${key}"`)
  }
  runner.calls = calls
  return runner
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return predicate()
}

test('scheduleStartupDiscovery returns immediately without awaiting the discovery work (never blocks the caller)', () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home, PATH: '/nonexistent' }
  const runner = fakeRunner([])
  const before = Date.now()
  scheduleStartupDiscovery({ env, commandRunner: runner })
  const elapsed = Date.now() - before
  assert.ok(elapsed < 50, `scheduleStartupDiscovery must return synchronously, took ${elapsed}ms`)
})

test('scheduleStartupDiscovery writes discovery.json shortly after being called, in the background', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home, PATH: '/nonexistent' }
  const runner = fakeRunner([])

  scheduleStartupDiscovery({ env, commandRunner: runner })

  const appeared = await waitFor(() => fs.existsSync(path.join(home, 'discovery.json')))
  assert.ok(appeared, 'discovery.json should appear shortly after startup')
  const parsed = JSON.parse(fs.readFileSync(path.join(home, 'discovery.json'), 'utf8'))
  assert.ok(parsed.agy)
  assert.equal(parsed.agy.error, 'not found on PATH')
})

test('scheduleStartupDiscovery never runs an L3 ping at boot', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home, PATH: '/nonexistent' }
  const runner = fakeRunner([])

  scheduleStartupDiscovery({ env, commandRunner: runner })
  await waitFor(() => fs.existsSync(path.join(home, 'discovery.json')))

  assert.ok(!runner.calls.some((c) => c.args.includes('Reply exactly: PONG')), 'startup discovery must never ping')
})

test('scheduleStartupDiscovery prunes preflight-cache.json rows no longer in DELEGATION_MAP', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { writeCacheEntry } = await import('../src/preflight.mjs?t=' + Date.now())
  writeCacheEntry('copilot:gpt-5-mini', { agent: 'copilot', model: 'gpt-5-mini', status: 'unavailable', checkedAt: new Date().toISOString() })

  const env = { AGENT_HUB_HOME: home, PATH: '/nonexistent' }
  const runner = fakeRunner([])
  scheduleStartupDiscovery({ env, commandRunner: runner })
  await waitFor(() => fs.existsSync(path.join(home, 'discovery.json')))

  const { readCache } = await import('../src/preflight.mjs?t=' + Date.now())
  assert.equal('copilot:gpt-5-mini' in readCache(env), false)
})

test('scheduleStartupDiscovery is a no-op when AGENT_HUB_DISABLE_STARTUP_DISCOVERY=1', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home, PATH: '/nonexistent', AGENT_HUB_DISABLE_STARTUP_DISCOVERY: '1' }
  const runner = fakeRunner([])

  scheduleStartupDiscovery({ env, commandRunner: runner })
  await new Promise((r) => setTimeout(r, 100))

  assert.equal(fs.existsSync(path.join(home, 'discovery.json')), false)
  assert.equal(runner.calls.length, 0)
})

test('scheduleQuotaWarmup returns immediately without awaiting the quota fetch (never blocks the caller)', () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const fetchUsageFn = () => new Promise(() => {}) // never resolves
  const before = Date.now()
  scheduleQuotaWarmup({ env, fetchUsageFn })
  const elapsed = Date.now() - before
  assert.ok(elapsed < 50, `scheduleQuotaWarmup must return synchronously, took ${elapsed}ms`)
})

test('scheduleQuotaWarmup fetches live usage for every provider named by DELEGATION_MAP, in the background', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  let seenArgs = null
  const fetchUsageFn = async (args) => {
    seenArgs = args
    return {}
  }

  scheduleQuotaWarmup({ env, fetchUsageFn })
  const appeared = await waitFor(() => seenArgs !== null)

  assert.ok(appeared, 'scheduleQuotaWarmup should call fetchUsageFn shortly after being scheduled')
  assert.equal(seenArgs.mode, 'live')
  assert.ok(seenArgs.providers.length > 0)
  assert.equal(seenArgs.env, env)
})

test('scheduleQuotaWarmup never throws or crashes startup when the quota fetch rejects', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  let called = false
  const fetchUsageFn = async () => {
    called = true
    throw new Error('CodexBar unreachable')
  }

  assert.doesNotThrow(() => scheduleQuotaWarmup({ env, fetchUsageFn }))
  await waitFor(() => called)
})

test('scheduleQuotaWarmup is a no-op when AGENT_HUB_DISABLE_STARTUP_DISCOVERY=1', async () => {
  const env = { AGENT_HUB_HOME: tmpHome(), AGENT_HUB_DISABLE_STARTUP_DISCOVERY: '1' }
  let called = false
  const fetchUsageFn = async () => {
    called = true
    return {}
  }

  scheduleQuotaWarmup({ env, fetchUsageFn })
  await new Promise((r) => setTimeout(r, 100))

  assert.equal(called, false)
})
