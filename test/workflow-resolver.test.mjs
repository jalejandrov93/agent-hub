import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkflow } from '../src/workflow/schema.mjs'
import { resolveDependencies, evaluateCondition } from '../src/workflow/resolver.mjs'
import { NODE_STATUS } from '../src/workflow/state.mjs'

test('resolver: evaluateCondition evaluates simple JS expressions against steps safely', () => {
  const steps = {
    review: { status: 'succeeded', result: { approved: true, score: 95 } },
    deploy: { status: 'failed', error: 'network down' },
  }

  assert.equal(evaluateCondition("steps.review.status == 'succeeded'", { steps }), true)
  assert.equal(evaluateCondition("steps.review.result.approved === true", { steps }), true)
  assert.equal(evaluateCondition("steps.review.result.score > 90", { steps }), true)
  assert.equal(evaluateCondition("steps.deploy.status == 'succeeded'", { steps }), false)
  // Missing property does not throw
  assert.equal(evaluateCondition("steps.unknownStep.status == 'succeeded'", { steps }), false)
  // Empty condition evaluates to true
  assert.equal(evaluateCondition(undefined, { steps }), true)
  assert.equal(evaluateCondition('', { steps }), true)
})

test('resolver: root nodes without dependencies become ready', () => {
  const workflow = createWorkflow({
    id: 'wf-root',
    name: 'root test',
    nodes: [
      { id: 'step-1', type: 'delegate', task: 't1' },
      { id: 'step-2', type: 'delegate', task: 't2', dependsOn: ['step-1'] },
    ],
  })

  const nodeStates = new Map([
    ['step-1', { status: NODE_STATUS.PENDING }],
    ['step-2', { status: NODE_STATUS.PENDING }],
  ])

  const { ready, skipped, isComplete } = resolveDependencies({ workflow, nodeStates })
  assert.equal(ready.length, 1)
  assert.equal(ready[0].id, 'step-1')
  assert.equal(skipped.length, 0)
  assert.equal(isComplete, false)
})

test('resolver: dependent node waits until all dependsOn nodes are terminal', () => {
  const workflow = createWorkflow({
    id: 'wf-wait',
    name: 'wait test',
    nodes: [
      { id: 'step-1', type: 'delegate', task: 't1' },
      { id: 'step-2', type: 'delegate', task: 't2' },
      { id: 'step-3', type: 'delegate', task: 't3', dependsOn: ['step-1', 'step-2'] },
    ],
  })

  const nodeStates = new Map([
    ['step-1', { status: NODE_STATUS.SUCCEEDED }],
    ['step-2', { status: NODE_STATUS.RUNNING }],
    ['step-3', { status: NODE_STATUS.PENDING }],
  ])

  const { ready, skipped } = resolveDependencies({ workflow, nodeStates })
  // step-3 must NOT be ready because step-2 is still running
  assert.equal(ready.length, 0)
  assert.equal(skipped.length, 0)
})

test('resolver: dependent node becomes ready when all dependencies succeed', () => {
  const workflow = createWorkflow({
    id: 'wf-ready',
    name: 'ready test',
    nodes: [
      { id: 'step-1', type: 'delegate', task: 't1' },
      { id: 'step-2', type: 'delegate', task: 't2', dependsOn: ['step-1'] },
    ],
  })

  const nodeStates = new Map([
    ['step-1', { status: NODE_STATUS.SUCCEEDED }],
    ['step-2', { status: NODE_STATUS.PENDING }],
  ])

  const { ready, skipped } = resolveDependencies({ workflow, nodeStates })
  assert.equal(ready.length, 1)
  assert.equal(ready[0].id, 'step-2')
  assert.equal(skipped.length, 0)
})

test('resolver: condition false causes node to become skipped', () => {
  const workflow = createWorkflow({
    id: 'wf-cond-false',
    name: 'condition false test',
    nodes: [
      { id: 'check', type: 'delegate', task: 'check' },
      {
        id: 'deploy',
        type: 'delegate',
        task: 'deploy',
        dependsOn: ['check'],
        condition: "steps.check.result.readyToDeploy === true",
      },
    ],
  })

  const nodeStates = new Map([
    ['check', { status: NODE_STATUS.SUCCEEDED, result: { readyToDeploy: false } }],
    ['deploy', { status: NODE_STATUS.PENDING }],
  ])

  const { ready, skipped } = resolveDependencies({ workflow, nodeStates })
  assert.equal(ready.length, 0)
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].node.id, 'deploy')
  assert.equal(skipped[0].reason, 'condition_false')
})

test('resolver: failure in dependency propagates skipped to dependents by default (onFailure-skip)', () => {
  const workflow = createWorkflow({
    id: 'wf-fail-prop',
    name: 'failure propagation test',
    nodes: [
      { id: 'build', type: 'delegate', task: 'build' },
      { id: 'test', type: 'delegate', task: 'test', dependsOn: ['build'] },
      { id: 'deploy', type: 'delegate', task: 'deploy', dependsOn: ['test'] },
    ],
  })

  const nodeStates = new Map([
    ['build', { status: NODE_STATUS.FAILED, error: 'compilation error' }],
    ['test', { status: NODE_STATUS.PENDING }],
    ['deploy', { status: NODE_STATUS.PENDING }],
  ])

  const { ready, skipped } = resolveDependencies({ workflow, nodeStates })
  assert.equal(ready.length, 0)
  assert.equal(skipped.length, 1)
  assert.equal(skipped[0].node.id, 'test')
  assert.match(skipped[0].reason, /dependency_failed:build/)
})

test('resolver: condition can explicitly handle dependency failure', () => {
  const workflow = createWorkflow({
    id: 'wf-fail-handle',
    name: 'error handler test',
    nodes: [
      { id: 'primary', type: 'delegate', task: 'primary task' },
      {
        id: 'fallback_cleanup',
        type: 'delegate',
        task: 'cleanup after failure',
        dependsOn: ['primary'],
        condition: "steps.primary.status == 'failed'",
      },
    ],
  })

  const nodeStates = new Map([
    ['primary', { status: NODE_STATUS.FAILED, error: 'out of memory' }],
    ['fallback_cleanup', { status: NODE_STATUS.PENDING }],
  ])

  const { ready, skipped } = resolveDependencies({ workflow, nodeStates })
  assert.equal(ready.length, 1)
  assert.equal(ready[0].id, 'fallback_cleanup')
  assert.equal(skipped.length, 0)
})
