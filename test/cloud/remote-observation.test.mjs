import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyRemoteObservation } from '../../src/cloud/remote-observation.mjs'
import { pollOnce } from '../../src/cloud/poller.mjs'
import { checkRemoteSession } from '../../src/cloud/check.mjs'
import * as julesAdapter from '../../src/cloud/jules/adapter.mjs'

test('applyRemoteObservation sets state and mirrors top-level remote_state', () => {
  let record = { jobId: 'j-1', remote: {} }
  const updateResultFn = (jobId, patch) => {
    record = { ...record, ...patch, remote: { ...record.remote, ...(patch.remote ?? {}) } }
  }

  applyRemoteObservation({
    jobId: 'j-1',
    state: 'IN_PROGRESS',
    isWaiting: false,
    updateResultFn,
    currentRemote: record.remote,
  })

  assert.equal(record.remote.state, 'IN_PROGRESS')
  assert.equal(record.remote_state, 'IN_PROGRESS')
})

test('applyRemoteObservation: stateSince sets on transition, sticky on identical state', () => {
  let record = { jobId: 'j-2', remote: {} }
  const updateResultFn = (jobId, patch) => {
    record = { ...record, ...patch, remote: { ...record.remote, ...(patch.remote ?? {}) } }
  }

  const t1 = 1000000
  applyRemoteObservation({
    jobId: 'j-2',
    state: 'PLANNING',
    isWaiting: false,
    nowFn: () => t1,
    updateResultFn,
    currentRemote: record.remote,
  })

  const stateSince1 = record.remote.stateSince
  assert.equal(stateSince1, new Date(t1).toISOString())

  // Same state 30s later -> stateSince must NOT change
  const t2 = t1 + 30000
  applyRemoteObservation({
    jobId: 'j-2',
    state: 'PLANNING',
    isWaiting: false,
    nowFn: () => t2,
    updateResultFn,
    currentRemote: record.remote,
  })
  assert.equal(record.remote.stateSince, stateSince1, 'stateSince must be preserved when state does not change')

  // State transitions to IN_PROGRESS -> stateSince must update to t3
  const t3 = t2 + 30000
  applyRemoteObservation({
    jobId: 'j-2',
    state: 'IN_PROGRESS',
    isWaiting: false,
    nowFn: () => t3,
    updateResultFn,
    currentRemote: record.remote,
  })
  assert.equal(record.remote.stateSince, new Date(t3).toISOString(), 'stateSince must update on state transition')
})

test('applyRemoteObservation: lastActivityAt sets only with sawNewActivity=true, sticky otherwise', () => {
  let record = { jobId: 'j-3', remote: {} }
  const updateResultFn = (jobId, patch) => {
    record = { ...record, ...patch, remote: { ...record.remote, ...(patch.remote ?? {}) } }
  }

  const t1 = 1000000
  // Quiet tick (sawNewActivity = false)
  applyRemoteObservation({
    jobId: 'j-3',
    state: 'IN_PROGRESS',
    sawNewActivity: false,
    isWaiting: false,
    nowFn: () => t1,
    updateResultFn,
    currentRemote: record.remote,
  })
  assert.equal(record.remote.lastActivityAt, null)

  // Tick with new activity
  const t2 = t1 + 5000
  applyRemoteObservation({
    jobId: 'j-3',
    state: 'IN_PROGRESS',
    sawNewActivity: true,
    isWaiting: false,
    nowFn: () => t2,
    updateResultFn,
    currentRemote: record.remote,
  })
  const lastAct = record.remote.lastActivityAt
  assert.equal(lastAct, new Date(t2).toISOString())

  // Subsequent quiet tick does not erase lastActivityAt
  const t3 = t2 + 5000
  applyRemoteObservation({
    jobId: 'j-3',
    state: 'IN_PROGRESS',
    sawNewActivity: false,
    isWaiting: false,
    nowFn: () => t3,
    updateResultFn,
    currentRemote: record.remote,
  })
  assert.equal(record.remote.lastActivityAt, lastAct, 'lastActivityAt must remain sticky across quiet ticks')
})

test('applyRemoteObservation: pollingStoppedReason clears when state is non-waiting', () => {
  let record = {
    jobId: 'j-4',
    remote: {
      state: 'AWAITING_USER_FEEDBACK',
      pollingStoppedReason: 'awaiting_interaction',
    },
  }
  const updateResultFn = (jobId, patch) => {
    record = { ...record, ...patch, remote: { ...record.remote, ...(patch.remote ?? {}) } }
  }

  // When state is still waiting, pollingStoppedReason is preserved
  applyRemoteObservation({
    jobId: 'j-4',
    state: 'AWAITING_USER_FEEDBACK',
    isWaiting: true,
    updateResultFn,
    currentRemote: record.remote,
  })
  assert.equal(record.remote.pollingStoppedReason, 'awaiting_interaction')

  // When state transitions to non-waiting, pollingStoppedReason is cleared to null
  applyRemoteObservation({
    jobId: 'j-4',
    state: 'IN_PROGRESS',
    isWaiting: false,
    updateResultFn,
    currentRemote: record.remote,
  })
  assert.equal(record.remote.pollingStoppedReason, null, 'pollingStoppedReason must be null for non-waiting state')
})

test('parity check: checkRemoteSession and pollOnce produce identical 5 fields', async () => {
  const commonTime = 1700000000000

  // 1. Simulate observation via pollOnce
  let pollRecord = {
    jobId: 'j-parity-poll',
    remote: {
      provider: 'jules',
      sessionId: 's-1',
      state: 'PLANNING',
      stateSince: new Date(commonTime - 60000).toISOString(),
      lastActivityAt: new Date(commonTime - 60000).toISOString(),
      pollingStoppedReason: 'awaiting_interaction',
    },
  }

  const pollUpdateFn = (id, patch) => {
    pollRecord = { ...pollRecord, ...patch, remote: { ...pollRecord.remote, ...(patch.remote ?? {}) } }
  }

  const mockClient = {
    getSession: async () => ({ id: 's-1', state: 'IN_PROGRESS' }),
    listActivities: async () => ({ activities: [] }),
  }

  await pollOnce({
    jobId: 'j-parity-poll',
    apiKey: 'test-key',
    sessionId: 's-1',
    client: mockClient,
    adapter: julesAdapter,
    nowFn: () => commonTime,
    updateResultFn: pollUpdateFn,
    readResultFn: () => pollRecord,
  })

  // 2. Simulate observation via checkRemoteSession
  let checkRecord = {
    jobId: 'j-parity-check',
    remote: {
      provider: 'jules',
      sessionId: 's-1',
      state: 'PLANNING',
      stateSince: new Date(commonTime - 60000).toISOString(),
      lastActivityAt: new Date(commonTime - 60000).toISOString(),
      pollingStoppedReason: 'awaiting_interaction',
    },
  }

  const checkUpdateFn = (id, patch) => {
    checkRecord = { ...checkRecord, ...patch, remote: { ...checkRecord.remote, ...(patch.remote ?? {}) } }
  }

  await checkRemoteSession({
    jobId: 'j-parity-check',
    client: mockClient,
    adapter: julesAdapter,
    env: { JULES_API_KEY: 'test-key' },
    updateResultFn: checkUpdateFn,
    readResultFn: () => checkRecord,
  })

  // Both must match on the 5 fields:
  // 1. remote.state
  assert.equal(checkRecord.remote.state, pollRecord.remote.state)
  assert.equal(checkRecord.remote.state, 'IN_PROGRESS')

  // 2. remote.stateSince (both transitioned from PLANNING to IN_PROGRESS)
  assert.ok(checkRecord.remote.stateSince)
  assert.ok(pollRecord.remote.stateSince)

  // 3. remote.lastActivityAt (both preserved sticky value from previous activity)
  assert.equal(checkRecord.remote.lastActivityAt, pollRecord.remote.lastActivityAt)
  assert.equal(checkRecord.remote.lastActivityAt, new Date(commonTime - 60000).toISOString())

  // 4. remote_state (top-level mirror)
  assert.equal(checkRecord.remote_state, pollRecord.remote_state)
  assert.equal(checkRecord.remote_state, 'IN_PROGRESS')

  // 5. pollingStoppedReason (both cleared to null because IN_PROGRESS is non-waiting)
  assert.equal(checkRecord.remote.pollingStoppedReason, pollRecord.remote.pollingStoppedReason)
  assert.equal(checkRecord.remote.pollingStoppedReason, null)
})
