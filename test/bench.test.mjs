import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CORPUS } from '../bench/corpus.mjs'
import { runCorpus, runScenario, summarize } from '../bench/run.mjs'

test('bench: runCorpus over built-in CORPUS completes offline with zero duplicateDispatches', async () => {
  const result = await runCorpus()
  assert.ok(result.generatedAt, 'generatedAt timestamp must be present')
  assert.equal(result.scenarios.length, CORPUS.length)
  assert.equal(result.summary.total, CORPUS.length)
  assert.equal(result.summary.duplicates, 0, 'zero duplicate dispatches across corpus')
  for (const s of result.scenarios) {
    assert.equal(s.duplicateDispatches, 0, `scenario ${s.id} must have 0 duplicate dispatches`)
  }
})

test('bench: retry scenario shows exactly one extra dispatch for the failing step', async () => {
  const scenario = CORPUS.find((s) => s.id === 'retry-transient')
  assert.ok(scenario, 'retry-transient scenario must exist in CORPUS')
  const result = await runScenario({ scenario })
  assert.equal(result.status, 'succeeded')
  assert.equal(result.duplicateDispatches, 0)
  assert.equal(result.nodes.flaky_step.status, 'succeeded')
  assert.equal(result.nodes.flaky_step.attempt, 2)
  const flakyDispatches = result.dispatches.filter((d) => d.stepId === 'flaky_step')
  assert.equal(flakyDispatches.length, 2, 'expected exactly 2 dispatches (1 initial + 1 extra retry)')
})

test('bench: revision scenario shows revision >= 1 on the relevant step', async () => {
  const scenario = CORPUS.find((s) => s.id === 'revision-verification')
  assert.ok(scenario, 'revision-verification scenario must exist in CORPUS')
  const result = await runScenario({ scenario })
  assert.equal(result.status, 'succeeded')
  assert.ok(result.nodes.review_step.revision >= 1, 'revision must be >= 1')
  assert.equal(result.nodes.review_step.status, 'succeeded')
})

test('bench: fanout scenario reports the failing child and workflow status failed', async () => {
  const scenario = CORPUS.find((s) => s.id === 'fanout-child-failure')
  assert.ok(scenario, 'fanout-child-failure scenario must exist in CORPUS')
  const result = await runScenario({ scenario })
  assert.equal(result.status, 'failed')
  assert.equal(result.nodes.fanout_step_1.status, 'failed')
  assert.equal(result.nodes.fanout_step.status, 'failed')
})

test('bench: summarize is pure and deterministic for a fixed input', () => {
  const sample = [
    { status: 'succeeded', duplicateDispatches: 0, verification: { verified: true } },
    { status: 'succeeded', duplicateDispatches: 0, verification: { verified: false } },
    { status: 'failed', duplicateDispatches: 1, verification: null }
  ]
  const sum1 = summarize(sample)
  const sum2 = summarize(sample)
  assert.deepEqual(sum1, sum2)
  assert.deepEqual(sum1, {
    total: 3,
    completed: 2,
    verified: 1,
    failed: 1,
    duplicates: 1
  })

  const empty = summarize([])
  assert.deepEqual(empty, {
    total: 0,
    completed: 0,
    verified: 0,
    failed: 0,
    duplicates: 0
  })
})
