import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialState, applyServerState, appendEvent } from '../src/dashboard/store.js'

// A /api/state snapshot is built before the response travels back. Events that
// arrive over SSE while that request is in flight are newer than the snapshot
// and must survive when the snapshot is applied.

const ev = (ts, extra = {}) => ({ ts, source: 'hub', kind: 'job.queued', ...extra })

test('applyServerState keeps SSE events newer than the snapshot', () => {
  let state = { ...initialState(), events: [ev('2026-09-15T00:00:01Z'), ev('2026-09-15T00:00:02Z')] }
  state = { ...state, ...appendEvent(state, ev('2026-09-15T00:00:05Z', { kind: 'subagent.stop', source: 'claude-hook' })) }
  const snapshot = { agents: [], jobs: [], subagents: [], events: [ev('2026-09-15T00:00:01Z'), ev('2026-09-15T00:00:02Z'), ev('2026-09-15T00:00:03Z')] }
  const next = { ...state, ...applyServerState(state, snapshot, 1) }
  assert.deepEqual(next.events.map((e) => e.ts), ['2026-09-15T00:00:01Z', '2026-09-15T00:00:02Z', '2026-09-15T00:00:03Z', '2026-09-15T00:00:05Z'])
  assert.deepEqual(next.subagents.map((e) => e.ts), ['2026-09-15T00:00:05Z'])
})

test('applyServerState does not duplicate events already in the snapshot', () => {
  const shared = ev('2026-09-15T00:00:03Z')
  const state = { ...initialState(), events: [shared] }
  const next = applyServerState(state, { agents: [], jobs: [], subagents: [], events: [shared] }, 1)
  assert.equal(next.events.length, 1)
})
