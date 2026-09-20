import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWorkflow, findCycleInGraph, WorkflowSchema } from '../src/workflow/schema.mjs'

test('schema: valid linear workflow passes', () => {
  const wf = createWorkflow({
    id: 'wf-1',
    name: 'linear',
    nodes: [
      { id: 'step-1', type: 'delegate', task: 'do step 1' },
      { id: 'step-2', type: 'delegate', task: 'do step 2', dependsOn: ['step-1'] },
    ],
  })

  assert.equal(wf.id, 'wf-1')
  assert.equal(wf.nodes.length, 2)
  assert.equal(wf.nodes[0].step_id, 'step-1')
  assert.equal(wf.nodes[1].dependsOn[0], 'step-1')
})

test('schema: supports step_id as alias for id', () => {
  const wf = createWorkflow({
    id: 'wf-alias',
    name: 'alias test',
    nodes: [
      { step_id: 'step-a', type: 'delegate', task: 'a' },
      { id: 'step-b', type: 'delegate', task: 'b', dependsOn: ['step-a'] },
    ],
  })

  assert.equal(wf.nodes[0].id, 'step-a')
  assert.equal(wf.nodes[0].step_id, 'step-a')
})

test('schema: rejects duplicate node IDs', () => {
  assert.throws(
    () => {
      createWorkflow({
        id: 'wf-dup',
        name: 'duplicate',
        nodes: [
          { id: 'step-1', type: 'delegate', task: 'first' },
          { id: 'step-1', type: 'delegate', task: 'second' },
        ],
      })
    },
    (err) => {
      assert.match(err.message, /Duplicate node id "step-1"/)
      return true
    }
  )
})

test('schema: rejects unknown dependency', () => {
  assert.throws(
    () => {
      createWorkflow({
        id: 'wf-unknown',
        name: 'unknown dep',
        nodes: [
          { id: 'step-1', type: 'delegate', task: 'do 1', dependsOn: ['non-existent'] },
        ],
      })
    },
    (err) => {
      assert.match(err.message, /depends on unknown node "non-existent"/)
      return true
    }
  )
})

test('schema: rejects self-cycle (A -> A)', () => {
  assert.throws(
    () => {
      createWorkflow({
        id: 'wf-self',
        name: 'self cycle',
        nodes: [
          { id: 'step-1', type: 'delegate', task: 'self', dependsOn: ['step-1'] },
        ],
      })
    },
    (err) => {
      assert.match(err.message, /Cycle detected in workflow DAG: step-1 -> step-1/)
      return true
    }
  )
})

test('schema: rejects 2-node cycle (A -> B -> A)', () => {
  assert.throws(
    () => {
      createWorkflow({
        id: 'wf-cycle-2',
        name: 'two-node cycle',
        nodes: [
          { id: 'A', type: 'delegate', task: 'a', dependsOn: ['B'] },
          { id: 'B', type: 'delegate', task: 'b', dependsOn: ['A'] },
        ],
      })
    },
    (err) => {
      assert.match(err.message, /Cycle detected in workflow DAG/)
      assert.ok(err.message.includes('A') && err.message.includes('B'))
      return true
    }
  )
})

test('schema: rejects 3-node cycle (A -> B -> C -> A)', () => {
  assert.throws(
    () => {
      createWorkflow({
        id: 'wf-cycle-3',
        name: 'three-node cycle',
        nodes: [
          { id: 'A', type: 'delegate', task: 'a', dependsOn: ['C'] },
          { id: 'B', type: 'delegate', task: 'b', dependsOn: ['A'] },
          { id: 'C', type: 'delegate', task: 'c', dependsOn: ['B'] },
        ],
      })
    },
    (err) => {
      assert.match(err.message, /Cycle detected in workflow DAG/)
      return true
    }
  )
})

test('schema: allows diamond DAG without false cycle detection', () => {
  // Diamond: A -> B, A -> C, B -> D, C -> D
  const wf = createWorkflow({
    id: 'wf-diamond',
    name: 'diamond',
    nodes: [
      { id: 'A', type: 'delegate', task: 'start' },
      { id: 'B', type: 'delegate', task: 'branch B', dependsOn: ['A'] },
      { id: 'C', type: 'delegate', task: 'branch C', dependsOn: ['A'] },
      { id: 'D', type: 'delegate', task: 'join', dependsOn: ['B', 'C'] },
    ],
  })

  assert.equal(wf.nodes.length, 4)
  assert.equal(findCycleInGraph(wf.nodes), null)
})
