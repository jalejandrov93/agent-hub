import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JUDGE_VERDICTS, judgeVerdict } from '../src/judge.mjs'

test('JUDGE_VERDICTS is frozen and has exactly the four verdicts', () => {
  assert.equal(Object.isFrozen(JUDGE_VERDICTS), true)
  assert.deepEqual(JUDGE_VERDICTS, ['accepted', 'needs_revision', 'rejected', 'blocked'])
})

test('no verification -> accepted with reason "no verification configured"', () => {
  const fromEmpty = judgeVerdict()
  assert.deepEqual(fromEmpty, {
    verdict: 'accepted',
    reason: 'no verification configured',
    revision: 0,
    maxRevisionAttempts: 0,
    required: false,
    failed: []
  })

  const fromNull = judgeVerdict({ verification: null })
  assert.equal(fromNull.verdict, 'accepted')
  assert.equal(fromNull.reason, 'no verification configured')
  assert.deepEqual(fromNull.failed, [])

  const fromUndefined = judgeVerdict({ verification: undefined })
  assert.equal(fromUndefined.verdict, 'accepted')
  assert.equal(fromUndefined.reason, 'no verification configured')
  assert.deepEqual(fromUndefined.failed, [])
})

test('verified true -> accepted with "all checks passed" and failed []', () => {
  const verification = {
    verified: true,
    checks: [
      { name: 'unit-tests', kind: 'argv', passed: true }
    ]
  }
  const result = judgeVerdict({ verification })
  assert.deepEqual(result, {
    verdict: 'accepted',
    reason: 'all checks passed',
    revision: 0,
    maxRevisionAttempts: 0,
    required: false,
    failed: []
  })
})

test('verified false, maxRevisionAttempts 0 -> rejected', () => {
  const verification = {
    verified: false,
    checks: [
      { name: 'unit-tests', kind: 'argv', passed: false }
    ]
  }
  const result = judgeVerdict({ verification, maxRevisionAttempts: 0 })
  assert.deepEqual(result, {
    verdict: 'rejected',
    reason: 'verification failed: unit-tests; no revision attempts left',
    revision: 0,
    maxRevisionAttempts: 0,
    required: false,
    failed: ['unit-tests']
  })
})

test('verified false, revision 0, maxRevisionAttempts 2 -> needs_revision and reason contains "revision 1/2"', () => {
  const verification = {
    verified: false,
    checks: [
      { name: 'lint', kind: 'argv', passed: false },
      { name: 'typecheck', kind: 'argv', passed: false }
    ]
  }
  const result = judgeVerdict({ verification, revision: 0, maxRevisionAttempts: 2 })
  assert.deepEqual(result, {
    verdict: 'needs_revision',
    reason: 'verification failed: lint, typecheck; revision 1/2',
    revision: 0,
    maxRevisionAttempts: 2,
    required: false,
    failed: ['lint', 'typecheck']
  })
})

test('verified false, revision 1, maxRevisionAttempts 2 -> needs_revision (2/2)', () => {
  const verification = {
    verified: false,
    checks: [
      { name: 'build', kind: 'argv', passed: false }
    ]
  }
  const result = judgeVerdict({ verification, revision: 1, maxRevisionAttempts: 2 })
  assert.deepEqual(result, {
    verdict: 'needs_revision',
    reason: 'verification failed: build; revision 2/2',
    revision: 1,
    maxRevisionAttempts: 2,
    required: false,
    failed: ['build']
  })
})

test('verified false, revision 2, maxRevisionAttempts 2 -> rejected, reason contains "no revision attempts left"', () => {
  const verification = {
    verified: false,
    checks: [
      { name: 'build', kind: 'argv', passed: false }
    ]
  }
  const result = judgeVerdict({ verification, revision: 2, maxRevisionAttempts: 2 })
  assert.deepEqual(result, {
    verdict: 'rejected',
    reason: 'verification failed: build; no revision attempts left',
    revision: 2,
    maxRevisionAttempts: 2,
    required: false,
    failed: ['build']
  })
})

test('blocked: failed artifact check with upstream ref -> blocked even with maxRevisionAttempts 2', () => {
  const verification = {
    verified: false,
    checks: [
      { name: 'unit-tests', kind: 'argv', passed: false },
      { name: 'upstream-spec', kind: 'artifact', ref: 'artifact://wf/up/brief.md', passed: false }
    ]
  }
  const result = judgeVerdict({
    verification,
    stepId: 'down',
    revision: 0,
    maxRevisionAttempts: 2
  })
  assert.deepEqual(result, {
    verdict: 'blocked',
    reason: 'upstream evidence missing: artifact://wf/up/brief.md',
    revision: 0,
    maxRevisionAttempts: 2,
    required: false,
    failed: ['unit-tests', 'upstream-spec']
  })
})

test('NOT blocked: failed artifact check pointing to SAME stepId -> needs_revision or rejected', () => {
  const verification = {
    verified: false,
    checks: [
      { name: 'self-output', kind: 'artifact', ref: 'artifact://wf/down/brief.md', passed: false }
    ]
  }
  const revisionResult = judgeVerdict({
    verification,
    stepId: 'down',
    revision: 0,
    maxRevisionAttempts: 2
  })
  assert.equal(revisionResult.verdict, 'needs_revision')
  assert.equal(revisionResult.reason, 'verification failed: self-output; revision 1/2')

  const rejectedResult = judgeVerdict({
    verification,
    stepId: 'down',
    revision: 2,
    maxRevisionAttempts: 2
  })
  assert.equal(rejectedResult.verdict, 'rejected')
  assert.equal(rejectedResult.reason, 'verification failed: self-output; no revision attempts left')
})

test('NOT blocked: failed artifact check with unparseable or missing ref', () => {
  const verification = {
    verified: false,
    checks: [
      { name: 'bad-ref', kind: 'artifact', ref: 'not-an-artifact-ref', passed: false },
      { name: 'no-ref', kind: 'artifact', passed: false }
    ]
  }
  const result = judgeVerdict({
    verification,
    stepId: 'down',
    revision: 0,
    maxRevisionAttempts: 1
  })
  assert.equal(result.verdict, 'needs_revision')
})

test('malformed revision and maxRevisionAttempts are normalized to 0', () => {
  const cases = [
    { revision: -1, maxRevisionAttempts: -2 },
    { revision: '1', maxRevisionAttempts: '2' },
    { revision: 1.5, maxRevisionAttempts: 2.5 },
    { revision: NaN, maxRevisionAttempts: NaN },
    { revision: null, maxRevisionAttempts: null }
  ]

  for (const { revision, maxRevisionAttempts } of cases) {
    const res = judgeVerdict({ revision, maxRevisionAttempts })
    assert.equal(res.revision, 0)
    assert.equal(res.maxRevisionAttempts, 0)
  }
})

test('required is echoed and does not change the verdict', () => {
  const pass = judgeVerdict({ required: true })
  assert.equal(pass.verdict, 'accepted')
  assert.equal(pass.required, true)

  const verification = {
    verified: false,
    checks: [{ name: 't', kind: 'argv', passed: false }]
  }
  const fail = judgeVerdict({ verification, required: true, maxRevisionAttempts: 0 })
  assert.equal(fail.verdict, 'rejected')
  assert.equal(fail.required, true)

  const blocked = judgeVerdict({
    verification: {
      verified: false,
      checks: [{ name: 'a', kind: 'artifact', ref: 'artifact://wf/up/b.md', passed: false }]
    },
    stepId: 'down',
    required: true
  })
  assert.equal(blocked.verdict, 'blocked')
  assert.equal(blocked.required, true)
})
