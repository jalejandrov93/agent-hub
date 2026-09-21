import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { NOOP_BRIDGE, BRIDGES, resolveBridge, bridgeSupportsWake } from '../src/harness/bridge.mjs'
import { deliverCompletion } from '../src/harness/lifecycle.mjs'
import { runWatchCli } from '../src/notify/cli.mjs'
import { recordOrigin } from '../src/harness/origin.mjs'
import { appendEvent } from '../src/eventlog.mjs'
import { closeDb } from '../src/storage/index.mjs'

test('bridge: NOOP_BRIDGE cannot wake and returns no-bridge reason', async () => {
  assert.equal(NOOP_BRIDGE.id, 'noop')
  assert.equal(NOOP_BRIDGE.canWake(), false)
  const res = await NOOP_BRIDGE.wake()
  assert.deepEqual(res, { delivered: false, reason: 'no-bridge' })
})

test('bridge: BRIDGES contains generic, claude-code, and opencode with supportsWake false', () => {
  for (const id of ['generic', 'claude-code', 'opencode']) {
    assert.ok(BRIDGES[id], `bridge entry ${id} should exist`)
    assert.equal(BRIDGES[id].id, id)
    assert.equal(typeof BRIDGES[id].supportsWake, 'function')
    assert.equal(BRIDGES[id].supportsWake(), false)
    assert.equal(BRIDGES[id].supportsWake('1.0.0'), false)
  }
})

test('bridge: resolveBridge and bridgeSupportsWake return noop and false for all current harnesses', () => {
  for (const id of ['generic', 'claude-code', 'opencode', 'unknown', null]) {
    assert.equal(bridgeSupportsWake(id), false)
    const bridge = resolveBridge(id)
    assert.equal(bridge.canWake(), false)
    assert.equal(bridge.id, 'noop')
  }
})

test('lifecycle: deliverCompletion with no origin is a no-op (false, no throw)', async () => {
  const appended = []
  const res = await deliverCompletion({
    jobId: 'job-missing',
    getOriginFn: () => null,
    appendEventFn: (evt) => appended.push(evt),
  })
  assert.equal(res.delivered, false)
  assert.equal(res.reason, 'no-origin')
  assert.equal(appended.length, 0)
})

test('lifecycle: deliverCompletion when bridge cannot wake returns false without throwing', async () => {
  const appended = []
  const fakeBridge = {
    id: 'test-bridge',
    canWake: () => false,
    wake: async () => { throw new Error('should not be called') },
  }
  const res = await deliverCompletion({
    jobId: 'job-1',
    getOriginFn: () => ({ job_id: 'job-1', harness: 'generic', harness_session_id: 'sess-1' }),
    bridgeFn: () => fakeBridge,
    appendEventFn: (evt) => appended.push(evt),
  })
  assert.equal(res.delivered, false)
  assert.equal(res.reason, 'cannot-wake')
  assert.equal(appended.length, 0)
})

test('lifecycle: deliverCompletion with fake bridge that canWake calls wake and appends harness.wake event', async () => {
  const appended = []
  let wakeCall = null
  const fakeBridge = {
    id: 'fake-opencode',
    canWake: () => true,
    async wake(origin, payload) {
      wakeCall = { origin, payload }
      return { delivered: true, reason: 'delivered' }
    },
  }
  const origin = { job_id: 'job-2', harness: 'opencode', harness_session_id: 'sess-abc' }
  const res = await deliverCompletion({
    jobId: 'job-2',
    event: { kind: 'job.finished', summary: 'Job completed successfully' },
    getOriginFn: () => origin,
    bridgeFn: () => fakeBridge,
    appendEventFn: (evt) => appended.push(evt),
  })

  assert.equal(res.delivered, true)
  assert.equal(res.reason, 'delivered')
  assert.ok(wakeCall)
  assert.deepEqual(wakeCall.origin, origin)
  assert.deepEqual(wakeCall.payload, {
    jobId: 'job-2',
    harness: 'opencode',
    sessionId: 'sess-abc',
    summary: 'Job completed successfully',
  })
  assert.equal(appended.length, 1)
  assert.equal(appended[0].kind, 'harness.wake')
  assert.equal(appended[0].jobId, 'job-2')
  assert.equal(appended[0].delivered, true)
  assert.equal(appended[0].reason, 'delivered')
})

test('lifecycle: a throwing bridge returns false and never throws', async () => {
  const appended = []
  const throwingBridge = {
    id: 'throwing',
    canWake: () => true,
    async wake() {
      throw new Error('connection refused')
    },
  }
  const origin = { job_id: 'job-3', harness: 'opencode', harness_session_id: 'sess-err' }
  const res = await deliverCompletion({
    jobId: 'job-3',
    getOriginFn: () => origin,
    bridgeFn: () => throwingBridge,
    appendEventFn: (evt) => appended.push(evt),
  })

  assert.equal(res.delivered, false)
  assert.equal(res.reason, 'connection refused')
  assert.equal(appended.length, 1)
  assert.equal(appended[0].kind, 'harness.wake')
  assert.equal(appended[0].delivered, false)
  assert.equal(appended[0].reason, 'connection refused')
})

test('lifecycle: payload summary is truncated to ~300 chars', async () => {
  let capturedPayload = null
  const fakeBridge = {
    id: 'fake',
    canWake: () => true,
    async wake(_origin, payload) {
      capturedPayload = payload
      return { delivered: true }
    },
  }
  const longSummary = 'A'.repeat(500)
  await deliverCompletion({
    jobId: 'job-4',
    summary: longSummary,
    getOriginFn: () => ({ job_id: 'job-4', harness: 'opencode', harness_session_id: 'sess-long' }),
    bridgeFn: () => fakeBridge,
    appendEventFn: () => {},
  })

  assert.ok(capturedPayload)
  assert.equal(capturedPayload.summary.length, 300)
  assert.equal(capturedPayload.summary, 'A'.repeat(300))
})

test('notify: runWatchCli invokes deliverCompletion best-effort on job.finished', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-bridge-notify-'))
  const env = { AGENT_HUB_HOME: tmpDir }
  try {
    recordOrigin({ jobId: 'job-notify-1', harnessSessionId: 'sess-notify', harness: 'opencode', env })
    appendEvent({ kind: 'job.finished', jobId: 'job-notify-1', summary: 'done' }, { env })
    const ok = await runWatchCli(['--once', '--sink=console'], { env })
    assert.equal(ok, true)
  } finally {
    closeDb(env)
  }
})

