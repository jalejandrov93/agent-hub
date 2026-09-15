import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { esc, formatAge, formatDuration } from '../src/dashboard/ui/format.js'
import {
  errorBadge,
  navBadges,
  failedJobsSince,
  unhealthyAgents,
  isUnhealthy,
} from '../src/dashboard/ui/badges.js'
import { parseHash, buildHash } from '../src/dashboard/router.js'
import { createStore, initialState, appendEvent, shouldRefetchState, markTimelineSeen } from '../src/dashboard/store.js'
import { ERROR_KIND_SEVERITY } from '../src/dashboard/contracts.js'

describe('ui/format', () => {
  test('esc escapes html-significant characters', () => {
    assert.equal(esc(`<b>"quote" & 'apos'</b>`), '&lt;b&gt;&quot;quote&quot; &amp; &#39;apos&#39;&lt;/b&gt;')
  })

  test('esc handles null/undefined as empty string', () => {
    assert.equal(esc(null), '')
    assert.equal(esc(undefined), '')
  })

  test('formatAge uses an injected now for determinism', () => {
    const now = new Date('2026-01-01T00:05:00.000Z').getTime()
    assert.equal(formatAge('2026-01-01T00:04:48.000Z', now), '12s ago')
    assert.equal(formatAge('2026-01-01T00:00:00.000Z', now), '5m ago')
    assert.equal(formatAge(new Date(now - 3 * 3600 * 1000).toISOString(), now), '3h ago')
    assert.equal(formatAge(new Date(now - 2 * 86400 * 1000).toISOString(), now), '2d ago')
  })

  test('formatAge returns em dash for null/invalid', () => {
    assert.equal(formatAge(null), '—')
    assert.equal(formatAge('not-a-date'), '—')
  })

  test('formatDuration formats seconds, minutes and hours', () => {
    assert.equal(formatDuration(42), '42s')
    assert.equal(formatDuration(185), '3m 05s')
    assert.equal(formatDuration(3720), '1h 02m')
  })
})

function baseState(overrides = {}) {
  return { ...initialState(), ...overrides }
}

describe('ui/badges', () => {
  test('navBadges is all-null when there are zero agents/jobs/events', () => {
    const state = baseState()
    const badges = navBadges(state, Date.now())
    assert.equal(badges.agents, null)
    assert.equal(badges.jobs, null)
    assert.equal(badges.history, null)
    assert.equal(badges.timeline, null)
    assert.equal(badges.config, null)
  })

  test('all healthy agents produce no unhealthy count', () => {
    const state = baseState({
      agents: [
        { agent: 'agy', model: 'm1', status: 'ready', reason: null, ladderLevel: 'L0', checkedAt: new Date().toISOString() },
      ],
      config: { overrides: {}, breakerState: [], process: { resolvedBins: { agy: '/usr/bin/agy' } } },
    })
    assert.equal(unhealthyAgents(state).length, 0)
    assert.equal(navBadges(state).agents, null)
  })

  test('a held override marks an otherwise-ready agent unhealthy', () => {
    const row = { agent: 'agy', model: 'm1', status: 'ready', reason: null, ladderLevel: 'L0', checkedAt: new Date().toISOString() }
    const state = baseState({
      agents: [row],
      config: { overrides: { 'agy:m1': { hold: true, setAt: new Date().toISOString() } }, breakerState: [], process: { resolvedBins: {} } },
    })
    assert.equal(isUnhealthy(state, row), true)
    assert.equal(unhealthyAgents(state).length, 1)
  })

  test('an open breaker marks an otherwise-ready agent unhealthy', () => {
    const row = { agent: 'opencode', model: 'm2', status: 'ready', reason: null, ladderLevel: 'L0', checkedAt: new Date().toISOString() }
    const state = baseState({
      agents: [row],
      config: {
        overrides: {},
        breakerState: [{ agent: 'opencode', model: 'm2', open: true, failureCount: 3, lastFailureAt: new Date().toISOString() }],
        process: { resolvedBins: {} },
      },
    })
    assert.equal(isUnhealthy(state, row), true)
  })

  test('unresolved agent bins drive navBadges.config', () => {
    const state = baseState({
      config: { overrides: {}, breakerState: [], process: { resolvedBins: { agy: null, copilot: '/usr/bin/copilot' } } },
    })
    const badges = navBadges(state)
    assert.deepEqual(badges.config, { count: 1, tone: 'degraded' })
  })

  test('failedJobsSince counts a failed job inside the window and excludes one outside it', () => {
    const now = Date.now()
    const inside = { status: 'failed', updatedAt: new Date(now - 60 * 1000).toISOString() }
    const outside = { status: 'failed', updatedAt: new Date(now - 48 * 3600 * 1000).toISOString() }
    const state = baseState({ jobs: [inside, outside] })
    const dayMs = 24 * 60 * 60 * 1000
    const failed = failedJobsSince(state, dayMs, now)
    assert.equal(failed.length, 1)
    assert.equal(failed[0], inside)
  })

  test('navBadges.history reflects only failures inside the last 24h', () => {
    const now = Date.now()
    const inside = { status: 'failed', updatedAt: new Date(now - 60 * 1000).toISOString() }
    const state = baseState({ jobs: [inside] })
    assert.deepEqual(navBadges(state, now).history, { count: 1, tone: 'unavailable' })
  })

  test('navBadges is null when count is exactly 0', () => {
    const state = baseState({ jobs: [{ status: 'succeeded', updatedAt: new Date().toISOString() }] })
    assert.equal(navBadges(state).history, null)
  })

  test('errorBadge tone matches ERROR_KIND_SEVERITY for every known kind', () => {
    for (const kind of Object.keys(ERROR_KIND_SEVERITY)) {
      assert.equal(errorBadge(kind).tone, ERROR_KIND_SEVERITY[kind])
      assert.equal(errorBadge(kind).label, kind)
    }
  })

  test('errorBadge falls back to degraded for an unknown errorKind', () => {
    assert.equal(errorBadge('totally_unknown_kind').tone, 'degraded')
  })
})

describe('router', () => {
  test('parseHash defaults to overview for empty, hash-only and slash-only inputs', () => {
    assert.deepEqual(parseHash(''), { name: 'overview', query: {} })
    assert.deepEqual(parseHash('#'), { name: 'overview', query: {} })
    assert.deepEqual(parseHash('#/'), { name: 'overview', query: {} })
  })

  test('parseHash defaults to overview for an unknown route', () => {
    assert.deepEqual(parseHash('#/not-a-real-route'), { name: 'overview', query: {} })
  })

  test('parseHash defaults to overview for a malformed hash', () => {
    assert.deepEqual(parseHash('not-even-a-hash-fragment'), { name: 'overview', query: {} })
  })

  test('parseHash extracts a known route and its query string', () => {
    assert.deepEqual(parseHash('#/agents?filter=unhealthy&q=copilot'), {
      name: 'agents',
      query: { filter: 'unhealthy', q: 'copilot' },
    })
  })

  test('buildHash round-trips through parseHash and omits empty values', () => {
    const hash = buildHash('history', { status: 'failed', agent: '', q: 'timeout' })
    assert.equal(hash, '#/history?status=failed&q=timeout')
    assert.deepEqual(parseHash(hash), { name: 'history', query: { status: 'failed', q: 'timeout' } })
  })

  test('buildHash falls back to the default route for an unknown name', () => {
    assert.equal(buildHash('not-a-route'), '#/overview')
  })
})

describe('store', () => {
  test('subscribe receives both next state and previous state on setState', () => {
    const store = createStore(initialState())
    let seen = null
    const unsubscribe = store.subscribe((state, prev) => {
      seen = { state, prev }
    })
    store.setState({ connection: 'live' })
    assert.equal(seen.state.connection, 'live')
    assert.equal(seen.prev.connection, 'connecting')
    unsubscribe()
  })

  test('unsubscribe stops further notifications', () => {
    const store = createStore(initialState())
    let calls = 0
    const unsubscribe = store.subscribe(() => {
      calls += 1
    })
    store.setState({ connection: 'live' })
    unsubscribe()
    store.setState({ connection: 'offline' })
    assert.equal(calls, 1)
  })

  test('setState accepts a function patch computed from current state', () => {
    const store = createStore(initialState())
    store.setState((s) => ({ busy: { ...s.busy, foo: true } }))
    assert.deepEqual(store.getState().busy, { foo: true })
  })

  test('appendEvent caps the events list at 200', () => {
    let state = initialState()
    for (let i = 0; i < 205; i++) {
      state = { ...state, ...appendEvent(state, { ts: String(i), source: 'hub', kind: 'job.finished' }) }
    }
    assert.equal(state.events.length, 200)
    assert.equal(state.events[0].ts, '5')
    assert.equal(state.events[199].ts, '204')
  })

  test('appendEvent mirrors a claude-hook event into subagents', () => {
    const state = initialState()
    const event = { ts: 't1', source: 'claude-hook', kind: 'subagent.stop' }
    const patch = appendEvent(state, event)
    assert.equal(patch.subagents.length, 1)
    assert.equal(patch.subagents[0], event)
  })

  test('appendEvent does not add a hub event to subagents', () => {
    const state = initialState()
    const patch = appendEvent(state, { ts: 't1', source: 'hub', kind: 'job.finished' })
    assert.equal(patch.subagents.length, 0)
  })

  test('shouldRefetchState is true for job.* and preflight, false for subagent.*', () => {
    assert.equal(shouldRefetchState({ kind: 'job.finished' }), true)
    assert.equal(shouldRefetchState({ kind: 'job.failed' }), true)
    assert.equal(shouldRefetchState({ kind: 'preflight' }), true)
    assert.equal(shouldRefetchState({ kind: 'subagent.start' }), false)
    assert.equal(shouldRefetchState({ kind: 'subagent.stop' }), false)
  })

  test('shouldRefetchState falls back to true for an unknown kind', () => {
    assert.equal(shouldRefetchState({ kind: 'something.new' }), true)
  })

  test('markTimelineSeen records the newest event ts', () => {
    const state = { ...initialState(), events: [{ ts: 'a' }, { ts: 'b' }] }
    const patch = markTimelineSeen(state)
    assert.equal(patch.lastSeenTimelineTs, 'b')
  })
})

describe('module import safety (no DOM access at module top level)', () => {
  test('app.js imports under Node without throwing', async () => {
    await assert.doesNotReject(() => import('../src/dashboard/app.js'))
  })

  test('api.js imports under Node without throwing', async () => {
    await assert.doesNotReject(() => import('../src/dashboard/api.js'))
  })

  test('ui/dialog.js imports under Node without throwing', async () => {
    await assert.doesNotReject(() => import('../src/dashboard/ui/dialog.js'))
  })

  test('ui/menu.js imports under Node without throwing', async () => {
    await assert.doesNotReject(() => import('../src/dashboard/ui/menu.js'))
  })

  test('ui/dom.js imports under Node without throwing', async () => {
    await assert.doesNotReject(() => import('../src/dashboard/ui/dom.js'))
  })
})
