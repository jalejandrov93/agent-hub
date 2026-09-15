import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-router-'))
}

async function fresh(home) {
  process.env.AGENT_HUB_HOME = home
  return import('../src/router.mjs?t=' + Date.now() + Math.random())
}

test('route returns a primary and fallbacks for a known task type', async () => {
  const { route } = await fresh(tmpHome())
  const result = await route({ taskType: 'recon' })
  assert.ok(result.primary.agent)
  assert.ok(Array.isArray(result.fallbacks))
  assert.ok(result.reason)
})

test('route includes Claude subagent tiers as {agent:"claude", model} entries where the map specifies them', async () => {
  const { route } = await fresh(tmpHome())
  const result = await route({ taskType: 'implementation-with-repo-rules' })
  assert.equal(result.primary.agent, 'claude')
  assert.equal(result.primary.model, 'sonnet')
})

test('route skips a pair whose cached preflight is unavailable, promoting the next fallback', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { writeCacheEntry, cacheKey } = await import('../src/preflight.mjs?t=' + Date.now())
  const { route } = await fresh(home)

  const first = await route({ taskType: 'recon' })
  const primaryPair = first.primary

  writeCacheEntry(cacheKey(primaryPair.agent, primaryPair.model), {
    agent: primaryPair.agent,
    model: primaryPair.model,
    status: 'unavailable',
    reason: 'test',
    ladderLevel: 'L2',
    checkedAt: new Date().toISOString(),
  })

  const second = await route({ taskType: 'recon' })
  assert.notDeepEqual(second.primary, primaryPair, 'an unavailable primary must not be re-selected')
})

test('route skips a pair whose circuit breaker is open, even if its cached preflight is "ready"', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { writeCacheEntry, cacheKey } = await import('../src/preflight.mjs?t=' + Date.now())
  const { appendEvent } = await import('../src/eventlog.mjs?t=' + Date.now())
  const { route } = await fresh(home)

  const first = await route({ taskType: 'recon' })
  const primaryPair = first.primary

  writeCacheEntry(cacheKey(primaryPair.agent, primaryPair.model), {
    agent: primaryPair.agent,
    model: primaryPair.model,
    status: 'ready',
    reason: null,
    ladderLevel: 'L2',
    checkedAt: new Date().toISOString(),
  })
  appendEvent({ kind: 'job.failed', agent: primaryPair.agent, model: primaryPair.model, errorKind: 'quota', cwd: '/tmp', title: 'x' })
  appendEvent({ kind: 'job.failed', agent: primaryPair.agent, model: primaryPair.model, errorKind: 'canceled', cwd: '/tmp', title: 'x' })

  const second = await route({ taskType: 'recon' })
  assert.notDeepEqual(second.primary, primaryPair, 'a breaker-open pair must not be re-selected even when cached ready')
})

test('an unknown task type throws a clear error', async () => {
  const { route } = await fresh(tmpHome())
  await assert.rejects(() => route({ taskType: 'not-a-real-task-type' }), /unknown task ?type/i)
})

test('every copilot candidate in the delegation map uses "auto", and gpt-4.1 is gone', async () => {
  const { DELEGATION_MAP } = await fresh(tmpHome())
  const copilotModels = new Set()
  for (const entry of Object.values(DELEGATION_MAP)) {
    for (const candidate of entry.chain) {
      if (candidate.agent === 'copilot') copilotModels.add(candidate.model)
      if (candidate.parallelWith?.agent === 'copilot') copilotModels.add(candidate.parallelWith.model)
    }
  }
  assert.deepEqual([...copilotModels], ['auto'])
})
