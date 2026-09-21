import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRevisionFeedback, REVISION_LIMITS } from '../src/revision.mjs'

test('revision: returns empty string for null judge or non-needs_revision verdict', () => {
  assert.equal(buildRevisionFeedback(), '')
  assert.equal(buildRevisionFeedback({ judge: null }), '')
  assert.equal(buildRevisionFeedback({ judge: { verdict: 'accepted' } }), '')
  assert.equal(buildRevisionFeedback({ judge: { verdict: 'rejected' } }), '')
  assert.equal(buildRevisionFeedback({ judge: { verdict: 'blocked' } }), '')
})

test('revision: exact block shape for a sample verdict', () => {
  const judge = {
    verdict: 'needs_revision',
    reason: 'verification failed: unit-tests; revision 1/2',
    failed: ['unit-tests']
  }
  const feedback = buildRevisionFeedback({ judge })
  const expected = [
    '<agent-hub-revision>',
    'Failed checks:',
    '- unit-tests',
    'Findings:',
    '- verification failed: unit-tests; revision 1/2',
    'Do not change unrelated files.',
    '</agent-hub-revision>'
  ].join('\n')

  assert.equal(feedback, expected)
})

test('revision: maxFindings cap (5 failed names -> at most 3 in output)', () => {
  const judge = {
    verdict: 'needs_revision',
    reason: 'verification failed',
    failed: ['check1', 'check2', 'check3', 'check4', 'check5']
  }
  const feedback = buildRevisionFeedback({ judge })

  assert.ok(feedback.includes('- check1'))
  assert.ok(feedback.includes('- check2'))
  assert.ok(feedback.includes('- check3'))
  assert.ok(!feedback.includes('- check4'))
  assert.ok(!feedback.includes('- check5'))

  const verification = {
    checks: [
      { name: 'check1', passed: false, detail: 'detail 1' },
      { name: 'check2', passed: false, detail: 'detail 2' },
      { name: 'check3', passed: false, detail: 'detail 3' },
      { name: 'check4', passed: false, detail: 'detail 4' }
    ]
  }
  const fbWithDetails = buildRevisionFeedback({ judge, verification })
  assert.ok(fbWithDetails.includes('- detail 2'))
  assert.ok(!fbWithDetails.includes('- detail 3'))
})

test('revision: each finding truncated to maxChars with trailing ...', () => {
  const longReason = 'x'.repeat(350)
  const judge = {
    verdict: 'needs_revision',
    reason: longReason,
    failed: ['check1']
  }
  const feedback = buildRevisionFeedback({ judge })
  const expectedTruncated = 'x'.repeat(REVISION_LIMITS.maxChars) + '...'
  assert.ok(feedback.includes(expectedTruncated))
  assert.ok(!feedback.includes('x'.repeat(REVISION_LIMITS.maxChars + 1)))
})

test('revision: malformed input returns empty string or valid block without throwing', () => {
  assert.doesNotThrow(() => buildRevisionFeedback(null))
  assert.doesNotThrow(() => buildRevisionFeedback('not-an-object'))
  assert.doesNotThrow(() => buildRevisionFeedback({ judge: 'needs_revision' }))
  assert.doesNotThrow(() => buildRevisionFeedback({
    judge: {
      verdict: 'needs_revision',
      failed: 'not-an-array',
      reason: 12345
    },
    verification: 'not-an-object'
  }))
  assert.doesNotThrow(() => buildRevisionFeedback({
    judge: {
      verdict: 'needs_revision',
      failed: [null, 123, {}],
      reason: null
    },
    verification: {
      checks: [null, 'invalid', { name: 123, passed: false }]
    }
  }))
})
