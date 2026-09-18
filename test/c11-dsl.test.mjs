import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateValue, evaluateConditionSafe } from '../src/workflow/dsl.mjs'
import { evaluateCondition } from '../src/workflow/resolver.mjs'
import { resolveFanoutItems } from '../src/workflow/engine.mjs'

const STEPS = {
  review: { status: 'succeeded', attempt: 1, result: { ok: true, count: 3 } },
  test: { status: 'failed', attempt: 2, result: null },
}

test('C1.1 DSL: comparadores ==, !=, ===, !==', () => {
  assert.equal(evaluateValue("steps.review.status == 'succeeded'", { steps: STEPS }), true)
  assert.equal(evaluateValue("steps.test.status != 'succeeded'", { steps: STEPS }), true)
  assert.equal(evaluateValue('steps.review.result.ok === true', { steps: STEPS }), true)
  assert.equal(evaluateValue('steps.review.result.ok !== false', { steps: STEPS }), true)
  assert.equal(evaluateValue("steps.test.status == 'succeeded'", { steps: STEPS }), false)
})

test('C1.1 DSL: AND, OR, NOT (keywords y símbolos)', () => {
  assert.equal(
    evaluateValue("steps.review.status == 'succeeded' AND steps.test.status == 'failed'", { steps: STEPS }),
    true
  )
  assert.equal(
    evaluateValue("steps.review.status == 'failed' OR steps.test.status == 'failed'", { steps: STEPS }),
    true
  )
  assert.equal(evaluateValue("NOT steps.test.status == 'succeeded'", { steps: STEPS }), true)
  assert.equal(
    evaluateValue("steps.review.status == 'succeeded' && steps.test.status == 'succeeded'", { steps: STEPS }),
    false
  )
  assert.equal(
    evaluateValue("steps.review.status == 'nope' || steps.test.status == 'failed'", { steps: STEPS }),
    true
  )
})

test('C1.1 DSL: exists() y paths steps.X.*', () => {
  assert.equal(evaluateValue('exists(steps.review.result)', { steps: STEPS }), true)
  assert.equal(evaluateValue('exists(steps.test.result)', { steps: STEPS }), false)
  assert.equal(evaluateValue('exists(steps.missing.result)', { steps: STEPS }), false)
  assert.equal(evaluateValue('steps.review.result.count == 3', { steps: STEPS }), true)
  assert.equal(evaluateValue('steps.missing.status == 3', { steps: STEPS }), false)
})

test('C1.1 DSL: rechazo — constructor, __proto__, prototype', () => {
  for (const evil of [
    "steps.review.constructor == 'x'",
    "steps.review.__proto__ == 'x'",
    'steps.review.prototype == 1',
    "steps.constructor.status == 'succeeded'",
  ]) {
    assert.throws(() => evaluateValue(evil, { steps: STEPS }), /blocked|rejects|prototype/i, evil)
  }
})

test('C1.1 DSL: rechazo — paréntesis de llamada', () => {
  assert.throws(() => evaluateValue("steps.review.status.toString() == 'succeeded'", { steps: STEPS }), /call/i)
  assert.throws(() => evaluateValue('foo() == 1', { steps: STEPS }), /call|unexpected/i)
})

test('C1.1 DSL: rechazo — punto-y-coma, backticks, asignación', () => {
  assert.throws(() => evaluateValue("steps.a == 1; steps.b == 2", { steps: STEPS }), /semicolon/i)
  assert.throws(() => evaluateValue('`injected` == 1', { steps: STEPS }), /backtick/i)
  assert.throws(() => evaluateValue('steps.a = 1', { steps: STEPS }), /assignment/i)
  assert.throws(() => evaluateValue('steps.a => steps.b', { steps: STEPS }), /arrow|rejects/i)
})

test('C1.1 DSL: evaluateCondition compat (vacío=true, inseguro=false)', () => {
  assert.equal(evaluateCondition('', { steps: STEPS }), true)
  assert.equal(evaluateCondition(undefined, { steps: STEPS }), true)
  assert.equal(evaluateCondition("steps.review.status == 'succeeded'", { steps: STEPS }), true)
  assert.equal(evaluateCondition("steps.test.status == 'succeeded'", { steps: STEPS }), false)
  assert.equal(evaluateCondition('steps.review.constructor == 1', { steps: STEPS }), false)
  assert.equal(evaluateConditionSafe('', {}), true)
})

test('C1.1 DSL: fanout items como expresión segura del DSL', () => {
  const nodeStates = new Map([
    ['parent', { status: 'succeeded', result: { items: ['a', 'b'] } }],
  ])
  const items = resolveFanoutItems({
    node: { id: 'fan', type: 'fanout', items: 'steps.parent.result.items' },
    nodeStates,
  })
  assert.deepEqual(items, ['a', 'b'])
  const evil = resolveFanoutItems({
    node: { id: 'fan', type: 'fanout', items: "steps.parent.constructor == 'x'" },
    nodeStates,
  })
  assert.deepEqual(evil, [])
})
