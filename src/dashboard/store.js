/**
 * Central client state container. Plain object store with pub/sub — no DOM
 * access, importable under `node --test`. Actions are pure functions that
 * return a patch object; they never mutate the state passed in.
 */

import { MAX_EVENTS } from './contracts.js'

/** Fresh AppState with every field at its empty/neutral default. */
export function initialState() {
  return {
    agents: [],
    jobs: [],
    subagents: [],
    events: [],
    config: null,
    connection: 'connecting',
    lastUpdatedAt: null,
    lastSeenTimelineTs: null,
    theme: 'system',
    busy: {},
  }
}

/** createStore(initial) -> {getState, setState, subscribe}. */
export function createStore(initial) {
  let state = initial
  const listeners = new Set()

  function getState() {
    return state
  }

  function setState(patch) {
    const prev = state
    const patchObj = typeof patch === 'function' ? patch(state) : patch
    state = { ...state, ...patchObj }
    for (const listener of listeners) listener(state, prev)
  }

  function subscribe(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  return { getState, setState, subscribe }
}

// ---------------------------------------------------------------------------
// Actions: pure (state, ...args) -> patch
// ---------------------------------------------------------------------------

/** Full snapshot from GET /api/state, capping events at MAX_EVENTS. */
export function applyServerState(state, apiState, now = Date.now()) {
  const events = Array.isArray(apiState.events) ? apiState.events.slice(-MAX_EVENTS) : state.events
  return {
    agents: Array.isArray(apiState.agents) ? apiState.agents : state.agents,
    jobs: Array.isArray(apiState.jobs) ? apiState.jobs : state.jobs,
    subagents: Array.isArray(apiState.subagents) ? apiState.subagents : state.subagents,
    events,
    lastUpdatedAt: now,
  }
}

export function applyConfig(state, config) {
  return { config }
}

/** Append one SSE event, capped at MAX_EVENTS; also mirrors claude-hook events into subagents. */
export function appendEvent(state, event) {
  const events = [...state.events, event].slice(-MAX_EVENTS)
  const subagents = event && event.source === 'claude-hook' ? [...state.subagents, event] : state.subagents
  return { events, subagents }
}

export function setConnection(state, connection) {
  return { connection }
}

export function setBusy(state, key, busy) {
  return { busy: { ...state.busy, [key]: busy } }
}

/** Record the newest event's ts as seen, for unseenTimelineCount(). */
export function markTimelineSeen(state) {
  const newest = state.events.length ? state.events[state.events.length - 1].ts : state.lastSeenTimelineTs
  return { lastSeenTimelineTs: newest }
}

// job.* and preflight kinds mutate server-side job/agent state, so they need
// a refetch; subagent.* only ever appends locally and never changes /api/state.
const NO_REFETCH_KINDS = new Set(['subagent.start', 'subagent.stop'])

/** True for job.*, preflight and any unknown kind; false for subagent.*. */
export function shouldRefetchState(event) {
  const kind = event && event.kind
  if (!kind) return true
  return !NO_REFETCH_KINDS.has(kind)
}
