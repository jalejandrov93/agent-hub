import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  NODE_STATUS,
  VALID_NODE_TRANSITIONS,
  TERMINAL_STATUSES,
  isTerminalStatus,
  isValidTransition,
  assertValidTransition,
} from '../src/workflow/state.mjs'

test('state: all expected statuses exist', () => {
  assert.equal(NODE_STATUS.PENDING, 'pending')
  assert.equal(NODE_STATUS.READY, 'ready')
  assert.equal(NODE_STATUS.RUNNING, 'running')
  assert.equal(NODE_STATUS.SUCCEEDED, 'succeeded')
  assert.equal(NODE_STATUS.FAILED, 'failed')
  assert.equal(NODE_STATUS.SKIPPED, 'skipped')
  assert.equal(NODE_STATUS.CANCELED, 'canceled')
})

test('state: valid transitions are allowed', () => {
  // pending -> ready, skipped, canceled
  assert.equal(isValidTransition('pending', 'ready'), true)
  assert.equal(isValidTransition('pending', 'skipped'), true)
  assert.equal(isValidTransition('pending', 'canceled'), true)

  // ready -> running, skipped, canceled
  assert.equal(isValidTransition('ready', 'running'), true)
  assert.equal(isValidTransition('ready', 'skipped'), true)
  assert.equal(isValidTransition('ready', 'canceled'), true)

  // running -> succeeded, failed, ready (retry), canceled
  assert.equal(isValidTransition('running', 'succeeded'), true)
  assert.equal(isValidTransition('running', 'failed'), true)
  assert.equal(isValidTransition('running', 'ready'), true)
  assert.equal(isValidTransition('running', 'canceled'), true)
})

test('state: invalid transitions are rejected', () => {
  // Terminal states cannot transition to anything
  for (const term of TERMINAL_STATUSES) {
    assert.equal(isValidTransition(term, 'ready'), false)
    assert.equal(isValidTransition(term, 'running'), false)
    assert.equal(isValidTransition(term, 'pending'), false)
  }

  // pending cannot jump straight to running or succeeded
  assert.equal(isValidTransition('pending', 'running'), false)
  assert.equal(isValidTransition('pending', 'succeeded'), false)
  assert.equal(isValidTransition('pending', 'failed'), false)

  // ready cannot jump straight to succeeded
  assert.equal(isValidTransition('ready', 'succeeded'), false)
  assert.equal(isValidTransition('ready', 'failed'), false)
})

test('state: assertValidTransition throws descriptive error on invalid transition', () => {
  assert.doesNotThrow(() => assertValidTransition('pending', 'ready', 'step-1'))
  assert.throws(
    () => assertValidTransition('succeeded', 'running', 'step-1'),
    (err) => {
      assert.match(err.message, /Invalid node state transition for step "step-1"/)
      assert.match(err.message, /cannot transition from "succeeded" to "running"/)
      return true
    }
  )
})

test('state: terminal status checks match expectations', () => {
  assert.equal(isTerminalStatus('succeeded'), true)
  assert.equal(isTerminalStatus('failed'), true)
  assert.equal(isTerminalStatus('skipped'), true)
  assert.equal(isTerminalStatus('canceled'), true)

  assert.equal(isTerminalStatus('pending'), false)
  assert.equal(isTerminalStatus('ready'), false)
  assert.equal(isTerminalStatus('running'), false)
})
