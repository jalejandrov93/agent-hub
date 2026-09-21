import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CAPABILITY_KEYS } from '../src/capabilities.mjs'
import { resolveHandoffSchema } from '../src/handoff.mjs'
import {
  ROLES,
  getRole,
  listRoles,
  requirementsForRole,
  validateRoles
} from '../src/roles.mjs'

const EXPECTED_ROLE_NAMES = Object.freeze([
  'TRACE_ANALYST',
  'SECURITY_REVIEWER',
  'ARCHITECT',
  'IMPLEMENTER',
  'TEST_ANALYST',
  'ADVERSARIAL_REVIEWER'
])

test('ROLES and each role object are frozen', () => {
  assert.equal(Object.isFrozen(ROLES), true)
  for (const name of EXPECTED_ROLE_NAMES) {
    const role = ROLES[name]
    assert.ok(role, `role ${name} exists`)
    assert.equal(Object.isFrozen(role), true, `role ${name} is frozen`)
    assert.equal(Object.isFrozen(role.capabilities), true, `role ${name}.capabilities is frozen`)
    assert.equal(Object.isFrozen(role.acceptance), true, `role ${name}.acceptance is frozen`)
  }
})

test('ROLES contains exactly the six expected names', () => {
  assert.deepEqual(Object.keys(ROLES), EXPECTED_ROLE_NAMES)
})

test('listRoles returns array of the six role names', () => {
  assert.deepEqual(listRoles(), EXPECTED_ROLE_NAMES)
})

test('every capabilities entry is in CAPABILITY_KEYS', () => {
  for (const name of EXPECTED_ROLE_NAMES) {
    const role = ROLES[name]
    assert.ok(Array.isArray(role.capabilities), `${name}.capabilities is array`)
    for (const cap of role.capabilities) {
      assert.ok(CAPABILITY_KEYS.includes(cap), `${name} capability "${cap}" is in CAPABILITY_KEYS`)
    }
  }

  assert.deepEqual(ROLES.TRACE_ANALYST.capabilities, [])
  assert.deepEqual(ROLES.SECURITY_REVIEWER.capabilities, ['read'])
  assert.deepEqual(ROLES.ARCHITECT.capabilities, ['read'])
  assert.deepEqual(ROLES.IMPLEMENTER.capabilities, ['read', 'write'])
  assert.deepEqual(ROLES.TEST_ANALYST.capabilities, ['read', 'write'])
  assert.deepEqual(ROLES.ADVERSARIAL_REVIEWER.capabilities, ['read'])
})

test('every handoffSchema resolves via resolveHandoffSchema', () => {
  for (const name of EXPECTED_ROLE_NAMES) {
    const role = ROLES[name]
    assert.equal(typeof role.handoffSchema, 'string')
    const resolved = resolveHandoffSchema(role.handoffSchema)
    assert.ok(resolved, `${name} handoffSchema "${role.handoffSchema}" resolves`)
  }

  assert.equal(ROLES.TRACE_ANALYST.handoffSchema, 'ResearchHandoff')
  assert.equal(ROLES.SECURITY_REVIEWER.handoffSchema, 'SecurityReviewHandoff')
  assert.equal(ROLES.ARCHITECT.handoffSchema, 'BaseHandoff')
  assert.equal(ROLES.IMPLEMENTER.handoffSchema, 'ImplementationHandoff')
  assert.equal(ROLES.TEST_ANALYST.handoffSchema, 'BaseHandoff')
  assert.equal(ROLES.ADVERSARIAL_REVIEWER.handoffSchema, 'ReviewHandoff')
})

test('handoffRequired is a boolean and matches contract', () => {
  for (const name of EXPECTED_ROLE_NAMES) {
    const role = ROLES[name]
    assert.equal(typeof role.handoffRequired, 'boolean', `${name}.handoffRequired is boolean`)
  }

  assert.equal(ROLES.TRACE_ANALYST.handoffRequired, false)
  assert.equal(ROLES.SECURITY_REVIEWER.handoffRequired, true)
  assert.equal(ROLES.ARCHITECT.handoffRequired, false)
  assert.equal(ROLES.IMPLEMENTER.handoffRequired, true)
  assert.equal(ROLES.TEST_ANALYST.handoffRequired, false)
  assert.equal(ROLES.ADVERSARIAL_REVIEWER.handoffRequired, true)
})

test('acceptance matches contract for each role', () => {
  assert.deepEqual(ROLES.TRACE_ANALYST.acceptance, ['findings cite file:line'])
  assert.deepEqual(ROLES.SECURITY_REVIEWER.acceptance, ['every finding names the risk and the evidence'])
  assert.deepEqual(ROLES.ARCHITECT.acceptance, ['decisions list tradeoffs'])
  assert.deepEqual(ROLES.IMPLEMENTER.acceptance, ['changedFiles matches the diff'])
  assert.deepEqual(ROLES.TEST_ANALYST.acceptance, ['findings include the failing test'])
  assert.deepEqual(ROLES.ADVERSARIAL_REVIEWER.acceptance, ['decisions explain what must change'])
})

test('each role has name and description strings', () => {
  for (const name of EXPECTED_ROLE_NAMES) {
    const role = ROLES[name]
    assert.equal(role.name, name)
    assert.equal(typeof role.description, 'string')
    assert.ok(role.description.length > 0)
  }
})

test('validateRoles returns { ok: true } for valid ROLES', () => {
  const result = validateRoles()
  assert.deepEqual(result, { ok: true })
})

test('validateRoles detects invalid capability and invalid handoffSchema', () => {
  const invalidRoles = {
    INVALID_CAP: {
      capabilities: ['nonexistent_capability'],
      handoffSchema: 'BaseHandoff'
    },
    INVALID_SCHEMA: {
      capabilities: ['read'],
      handoffSchema: 'NonexistentHandoff'
    }
  }

  const result = validateRoles(invalidRoles)
  assert.equal(result.ok, false)
  assert.equal(result.errors.length, 2)
  assert.deepEqual(result.errors[0], {
    role: 'INVALID_CAP',
    field: 'capabilities',
    message: 'unknown capability: nonexistent_capability'
  })
  assert.deepEqual(result.errors[1], {
    role: 'INVALID_SCHEMA',
    field: 'handoffSchema',
    message: 'unknown handoff schema: NonexistentHandoff'
  })
})

test('requirementsForRole returns capabilities or empty array', () => {
  assert.deepEqual(requirementsForRole('IMPLEMENTER'), ['read', 'write'])
  assert.deepEqual(requirementsForRole('TRACE_ANALYST'), [])
  assert.deepEqual(requirementsForRole('UNKNOWN_ROLE'), [])
  assert.deepEqual(requirementsForRole(''), [])
  assert.deepEqual(requirementsForRole(null), [])
  assert.deepEqual(requirementsForRole(undefined), [])
  assert.deepEqual(requirementsForRole(123), [])
})

test('getRole returns the role object or null', () => {
  assert.equal(getRole('ARCHITECT'), ROLES.ARCHITECT)
  assert.equal(getRole('SECURITY_REVIEWER'), ROLES.SECURITY_REVIEWER)
  assert.equal(getRole('UNKNOWN'), null)
  assert.equal(getRole(''), null)
  assert.equal(getRole(null), null)
  assert.equal(getRole(undefined), null)
  assert.equal(getRole(42), null)
})
