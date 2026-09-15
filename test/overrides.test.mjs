import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-overrides-'))
}

async function fresh(home) {
  process.env.AGENT_HUB_HOME = home
  return import('../src/overrides.mjs?t=' + Date.now() + Math.random())
}

test('readOverrides returns {} when overrides.json does not exist yet', async () => {
  const { readOverrides } = await fresh(tmpHome())
  assert.deepEqual(readOverrides(), {})
})

test('overrideKey builds "agent:model"', async () => {
  const { overrideKey } = await fresh(tmpHome())
  assert.equal(overrideKey('agy', 'gemini-3.8-flash-low'), 'agy:gemini-3.8-flash-low')
})

test('setOverride creates a new entry and readOverrides reflects it', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { setOverride, readOverrides, overrideKey } = await fresh(home)

  const key = overrideKey('agy', 'gemini-3.8-flash-low')
  const entry = setOverride(key, { hold: true, reason: 'manual' }, env)

  assert.equal(entry.hold, true)
  assert.equal(entry.reason, 'manual')
  assert.ok(entry.setAt)
  assert.deepEqual(readOverrides(env)[key], entry)
})

test('setOverride merges into an existing entry instead of replacing it', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { setOverride, overrideKey } = await fresh(home)
  const key = overrideKey('copilot', 'auto')

  setOverride(key, { hold: true, reason: 'manual' }, env)
  const merged = setOverride(key, { breakerReset: '2026-01-01T00:00:00.000Z' }, env)

  assert.equal(merged.hold, true, 'hold from the first call survives the merge')
  assert.equal(merged.breakerReset, '2026-01-01T00:00:00.000Z')
})

test('clearOverride removes the entry entirely', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { setOverride, clearOverride, readOverrides, overrideKey } = await fresh(home)
  const key = overrideKey('agy', 'gemini-3.8-flash-low')

  setOverride(key, { hold: true }, env)
  const result = clearOverride(key, env)

  assert.equal(result.cleared, true)
  assert.equal(key in readOverrides(env), false)
})

test('clearOverride on a key that was never set is a safe no-op', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { clearOverride, overrideKey } = await fresh(home)
  const result = clearOverride(overrideKey('agy', 'nope'), env)
  assert.equal(result.cleared, true)
})

test('setOverride leaves no .tmp file behind (atomic write)', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const { setOverride, overrideKey } = await fresh(home)
  setOverride(overrideKey('agy', 'gemini-3.8-flash-low'), { hold: true }, env)
  const leftovers = fs.readdirSync(home).filter((f) => f.includes('.tmp'))
  assert.deepEqual(leftovers, [])
})
