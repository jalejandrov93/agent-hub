import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveHarness, normalizeWaitMode, clientHintForName, getClientHint, setClientHint } from '../src/harness/registry.mjs'
import { generic } from '../src/harness/generic.mjs'
import { claudeCode } from '../src/harness/claude-code.mjs'
import { opencode } from '../src/harness/opencode.mjs'

test('profiles: cada harness declara su defaultWaitMode y continuation contract', () => {
  assert.equal(generic.id, 'generic')
  assert.equal(generic.delegation.defaultWaitMode, 'none')
  assert.equal(generic.behavior.requiresExplicitContinuation, false)

  assert.equal(claudeCode.id, 'claude-code')
  assert.equal(claudeCode.delegation.defaultWaitMode, 'attention')
  assert.equal(claudeCode.behavior.requiresExplicitContinuation, true)

  assert.equal(opencode.id, 'opencode')
  assert.equal(opencode.delegation.defaultWaitMode, 'attention')
  assert.equal(opencode.behavior.requiresExplicitContinuation, true)
})

test('registry: override por env AGENT_HUB_HARNESS', () => {
  assert.equal(resolveHarness({ env: { AGENT_HUB_HARNESS: 'claude-code' } }).id, 'claude-code')
  assert.equal(resolveHarness({ env: { AGENT_HUB_HARNESS: 'opencode' } }).delegation.defaultWaitMode, 'attention')
  assert.equal(resolveHarness({ env: {} }).id, 'generic')
})

test('registry: prioridad explicito > env > hint > generic', () => {
  const env = { AGENT_HUB_HARNESS: 'opencode' }
  // explicit gana a env + hint
  assert.equal(resolveHarness({ explicit: 'generic', env, clientHint: 'claude-code' }).id, 'generic')
  assert.equal(resolveHarness({ explicit: 'claude-code', env, clientHint: 'opencode' }).id, 'claude-code')
  // env gana a hint
  assert.equal(resolveHarness({ env, clientHint: 'claude-code' }).id, 'opencode')
  // hint solo cuando no hay explicit ni env
  assert.equal(resolveHarness({ env: {}, clientHint: 'claude-code' }).id, 'claude-code')
  assert.equal(resolveHarness({ env: {}, clientHint: 'opencode' }).id, 'opencode')
  // sin nada: generic
  assert.equal(resolveHarness({ env: {}, clientHint: null }).id, 'generic')
  assert.equal(resolveHarness({ env: {}, clientHint: 'unknown-client' }).id, 'generic')
})

test('registry: ids desconocidos degradan a generic (nunca rompen el dispatch)', () => {
  assert.equal(resolveHarness({ explicit: 'typo-harness', env: {} }).id, 'generic')
  assert.equal(resolveHarness({ env: { AGENT_HUB_HARNESS: 'typo' } }).id, 'generic')
})

test('clientHintForName: mapea clientInfo.name sin adivinar', () => {
  assert.equal(clientHintForName('Claude Code v1.2'), 'claude-code')
  assert.equal(clientHintForName('claude-code'), 'claude-code')
  assert.equal(clientHintForName('opencode'), 'opencode')
  assert.equal(clientHintForName('test'), null)
  assert.equal(clientHintForName(null), null)
  assert.equal(clientHintForName(undefined), null)
})

test('normalizeWaitMode: acepta los tres modos y rechaza el resto', () => {
  assert.equal(normalizeWaitMode('none'), 'none')
  assert.equal(normalizeWaitMode('attention'), 'attention')
  assert.equal(normalizeWaitMode('terminal'), 'terminal')
  assert.equal(normalizeWaitMode(null), null)
  assert.throws(() => normalizeWaitMode('smart'), /unknown waitMode/)
})

test('stored client hint: set/get round-trip', () => {
  setClientHint('claude-code')
  assert.equal(getClientHint(), 'claude-code')
  setClientHint(null)
  assert.equal(getClientHint(), null)
})
