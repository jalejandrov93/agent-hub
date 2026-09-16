import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adapterFor, modelsArgv, REMOTE_AGENTS } from '../src/adapters/index.mjs'
import * as julesAdapter from '../src/cloud/jules/adapter.mjs'

test('adapterFor("jules") returns the Jules adapter module', () => {
  assert.equal(adapterFor('jules'), julesAdapter)
  assert.equal(adapterFor('jules').id, 'jules')
})

test('REMOTE_AGENTS contains only agents whose adapter is remote:true', () => {
  assert.ok(REMOTE_AGENTS instanceof Set)
  assert.ok(REMOTE_AGENTS.has('jules'))
  assert.ok(!REMOTE_AGENTS.has('agy'))
  assert.ok(!REMOTE_AGENTS.has('opencode'))
  assert.ok(!REMOTE_AGENTS.has('copilot'))
})

test('modelsArgv("jules") throws a clear error — Jules has no CLI to list models from', () => {
  assert.throws(() => modelsArgv('jules'), /jules/i)
  assert.throws(() => modelsArgv('jules'), /no CLI/i)
})

test('modelsArgv still works for the existing local agents', () => {
  assert.deepEqual(modelsArgv('agy'), ['models'])
  assert.deepEqual(modelsArgv('copilot'), ['help', 'config'])
})
