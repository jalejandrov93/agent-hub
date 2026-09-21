import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HANDOFF_FIELDS,
  HANDOFF_LIMITS,
  HANDOFF_SCHEMAS,
  emptyHandoff,
  normalizeHandoff,
  validateHandoff,
  resolveHandoffSchema,
  listHandoffSchemas
} from '../src/handoff.mjs'

test('HANDOFF_FIELDS is frozen and matches the contract', () => {
  assert.equal(Object.isFrozen(HANDOFF_FIELDS), true)
  assert.deepEqual(HANDOFF_FIELDS, [
    'summary',
    'findings',
    'decisions',
    'constraints',
    'changedFiles',
    'openQuestions',
    'artifacts'
  ])
})

test('HANDOFF_LIMITS is frozen and defines limits', () => {
  assert.equal(Object.isFrozen(HANDOFF_LIMITS), true)
  assert.deepEqual(HANDOFF_LIMITS, {
    maxItems: 20,
    maxItemChars: 2000,
    maxSummaryChars: 4000
  })
})

test('emptyHandoff returns empty summary and array fields', () => {
  const h1 = emptyHandoff()
  assert.deepEqual(h1, {
    summary: '',
    findings: [],
    decisions: [],
    constraints: [],
    changedFiles: [],
    openQuestions: [],
    artifacts: []
  })

  // Mutating one instance does not affect another
  h1.findings.push('leak')
  const h2 = emptyHandoff()
  assert.deepEqual(h2.findings, [])
})

test('normalizeHandoff handles defaults for {} and garbage inputs without throwing', () => {
  const expectedDefault = {
    summary: '',
    findings: [],
    decisions: [],
    constraints: [],
    changedFiles: [],
    openQuestions: [],
    artifacts: []
  }

  assert.deepEqual(normalizeHandoff({}), expectedDefault)
  assert.deepEqual(normalizeHandoff(null), expectedDefault)
  assert.deepEqual(normalizeHandoff(undefined), expectedDefault)
  assert.deepEqual(normalizeHandoff(42), expectedDefault)
  assert.deepEqual(normalizeHandoff('not an object'), expectedDefault)
  assert.deepEqual(normalizeHandoff([]), expectedDefault)
  assert.deepEqual(normalizeHandoff({
    nested: { a: 1 },
    summary: 999,
    findings: { unexpected: 'shape' },
    decisions: null,
    constraints: false
  }), expectedDefault)
})

test('normalizeHandoff trims strings and caps summary at maxSummaryChars', () => {
  const trimmed = normalizeHandoff({
    summary: '  trimmed summary  ',
    findings: ['  item 1  ', '  item 2  ']
  })
  assert.equal(trimmed.summary, 'trimmed summary')
  assert.deepEqual(trimmed.findings, ['item 1', 'item 2'])

  const longSummary = 's'.repeat(5000)
  const normalized = normalizeHandoff({ summary: longSummary })
  assert.equal(normalized.summary.length, HANDOFF_LIMITS.maxSummaryChars)
  assert.equal(normalized.summary, 's'.repeat(HANDOFF_LIMITS.maxSummaryChars))
})

test('normalizeHandoff truncates long string items with ... marker', () => {
  const longItem = 'x'.repeat(2500)
  const normalized = normalizeHandoff({ findings: [longItem] })
  assert.equal(normalized.findings.length, 1)
  assert.equal(normalized.findings[0].length, HANDOFF_LIMITS.maxItemChars + 3)
  assert.equal(normalized.findings[0], 'x'.repeat(HANDOFF_LIMITS.maxItemChars) + '...')
})

test('normalizeHandoff caps arrays at maxItems', () => {
  const items = Array.from({ length: 30 }, (_, i) => `item-${i}`)
  const normalized = normalizeHandoff({ decisions: items })
  assert.equal(normalized.decisions.length, HANDOFF_LIMITS.maxItems)
  assert.equal(normalized.decisions[0], 'item-0')
  assert.equal(normalized.decisions[HANDOFF_LIMITS.maxItems - 1], `item-${HANDOFF_LIMITS.maxItems - 1}`)
})

test('validateHandoff succeeds for valid BaseHandoff and returns normalized value', () => {
  const valid = {
    summary: '  A robust implementation handoff  ',
    findings: ['found a bug']
  }
  const result = validateHandoff(valid)
  assert.equal(result.ok, true)
  assert.equal(result.value.summary, 'A robust implementation handoff')
  assert.deepEqual(result.value.findings, ['found a bug'])
  assert.deepEqual(result.value.decisions, [])
})

test('validateHandoff fails with path summary when summary is missing or empty', () => {
  const r1 = validateHandoff({})
  assert.equal(r1.ok, false)
  assert.equal(r1.errors.length, 1)
  assert.equal(r1.errors[0].path, 'summary')

  const r2 = validateHandoff({ summary: '   ' })
  assert.equal(r2.ok, false)
  assert.equal(r2.errors[0].path, 'summary')
})

test('validateHandoff rejects unknown schema with path schema', () => {
  const result = validateHandoff({ summary: 'Valid' }, { schema: 'NoSuchSchema' })
  assert.equal(result.ok, false)
  assert.deepEqual(result.errors, [
    { path: 'schema', message: 'unknown handoff schema: NoSuchSchema' }
  ])
})

test('each named schema requires its specific fields', () => {
  // BaseHandoff requires summary
  assert.equal(validateHandoff({ summary: 'ok' }, { schema: 'BaseHandoff' }).ok, true)
  assert.equal(validateHandoff({}, { schema: 'BaseHandoff' }).ok, false)

  // ResearchHandoff requires summary + findings
  const resEmpty = validateHandoff({ summary: 'ok' }, { schema: 'ResearchHandoff' })
  assert.equal(resEmpty.ok, false)
  assert.equal(resEmpty.errors[0].path, 'findings')
  const resValid = validateHandoff({ summary: 'ok', findings: ['f1'] }, { schema: 'ResearchHandoff' })
  assert.equal(resValid.ok, true)

  // SecurityReviewHandoff requires summary + findings + constraints
  const secMissingBoth = validateHandoff({ summary: 'ok' }, { schema: 'SecurityReviewHandoff' })
  assert.equal(secMissingBoth.ok, false)
  assert.deepEqual(secMissingBoth.errors.map(e => e.path), ['findings', 'constraints'])
  const secMissingConstraints = validateHandoff({ summary: 'ok', findings: ['f1'] }, { schema: 'SecurityReviewHandoff' })
  assert.equal(secMissingConstraints.ok, false)
  assert.equal(secMissingConstraints.errors[0].path, 'constraints')
  const secValid = validateHandoff({ summary: 'ok', findings: ['f1'], constraints: ['c1'] }, { schema: 'SecurityReviewHandoff' })
  assert.equal(secValid.ok, true)

  // ImplementationHandoff requires summary + changedFiles
  const impMissing = validateHandoff({ summary: 'ok' }, { schema: 'ImplementationHandoff' })
  assert.equal(impMissing.ok, false)
  assert.equal(impMissing.errors[0].path, 'changedFiles')
  const impValid = validateHandoff({ summary: 'ok', changedFiles: ['src/handoff.mjs'] }, { schema: 'ImplementationHandoff' })
  assert.equal(impValid.ok, true)

  // ReviewHandoff requires summary + decisions
  const revMissing = validateHandoff({ summary: 'ok' }, { schema: 'ReviewHandoff' })
  assert.equal(revMissing.ok, false)
  assert.equal(revMissing.errors[0].path, 'decisions')
  const revValid = validateHandoff({ summary: 'ok', decisions: ['approved'] }, { schema: 'ReviewHandoff' })
  assert.equal(revValid.ok, true)
})

test('listHandoffSchemas returns exactly the five names and resolveHandoffSchema resolves them', () => {
  const schemas = listHandoffSchemas()
  assert.deepEqual(schemas, [
    'BaseHandoff',
    'ResearchHandoff',
    'SecurityReviewHandoff',
    'ImplementationHandoff',
    'ReviewHandoff'
  ])

  for (const name of schemas) {
    const s = resolveHandoffSchema(name)
    assert.ok(s)
    assert.equal(s.name, name)
    assert.ok(Array.isArray(s.requires))
    assert.equal(typeof s.description, 'string')
    assert.equal(Object.isFrozen(s), true)
  }

  assert.equal(resolveHandoffSchema('Unknown'), null)
  assert.equal(resolveHandoffSchema(null), null)
})

test('normalizeHandoff drops non-string list items so every field stays an array of strings', () => {
  const normalized = normalizeHandoff({ summary: 's', findings: [42, ' real finding ', null, { a: 1 }, 'second'] })
  assert.deepEqual(normalized.findings, ['real finding', 'second'])
  for (const field of HANDOFF_FIELDS) {
    const value = normalized[field]
    if (Array.isArray(value)) {
      assert.ok(value.every((v) => typeof v === 'string'), field + ' must contain only strings')
    }
  }
})
