/**
 * Pure badge/derived-state helpers over AppState. No DOM access — importable
 * under `node --test`. `now` is injectable everywhere time matters so tests
 * stay deterministic.
 */

import { ERROR_KIND_SEVERITY } from '../contracts.js'

/** 'agent:model' key used by config.overrides and breaker lookups. */
export function agentKey(agent, model) {
  return `${agent}:${model}`
}

export function overrideFor(state, agent, model) {
  const overrides = (state.config && state.config.overrides) || {}
  return overrides[agentKey(agent, model)] || null
}

export function breakerFor(state, agent, model) {
  const list = (state.config && state.config.breakerState) || []
  return list.find((b) => b.agent === agent && b.model === model) || null
}

/** degraded | unavailable | held | breaker open. */
export function isUnhealthy(state, row) {
  if (row.status === 'degraded' || row.status === 'unavailable') return true
  const override = overrideFor(state, row.agent, row.model)
  if (override && override.hold) return true
  const breaker = breakerFor(state, row.agent, row.model)
  if (breaker && breaker.open) return true
  return false
}

export function unhealthyAgents(state) {
  return state.agents.filter((row) => isUnhealthy(state, row))
}

/** Override keys ('agent:model') with hold === true. */
export function heldPairs(state) {
  const overrides = (state.config && state.config.overrides) || {}
  return Object.keys(overrides).filter((key) => overrides[key].hold === true)
}

export function openBreakers(state) {
  const list = (state.config && state.config.breakerState) || []
  return list.filter((b) => b.open)
}

/** Agents this dashboard process cannot find on its own PATH. */
export function unresolvedAgents(state) {
  const bins = (state.config && state.config.process && state.config.process.resolvedBins) || {}
  return Object.keys(bins).filter((agent) => bins[agent] === null)
}

export function runningJobs(state) {
  return state.jobs.filter((j) => j.status === 'queued' || j.status === 'running')
}

/** Failed jobs whose updatedAt falls within the last `sinceMs` from `now`. */
export function failedJobsSince(state, sinceMs, now = Date.now()) {
  return state.jobs.filter((j) => {
    if (j.status !== 'failed' || !j.updatedAt) return false
    const updatedAtMs = new Date(j.updatedAt).getTime()
    if (Number.isNaN(updatedAtMs)) return false
    const age = now - updatedAtMs
    return age >= 0 && age <= sinceMs
  })
}

/** Events not yet seen in #/timeline (state.lastSeenTimelineTs is the newest seen ts). */
export function unseenTimelineCount(state) {
  if (!state.lastSeenTimelineTs) return state.events.length
  return state.events.filter((e) => e.ts > state.lastSeenTimelineTs).length
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

/** Sidebar badge counts, keyed by ROUTES[name].badge. null when count is 0. */
export function navBadges(state, now = Date.now()) {
  const counts = {
    agents: { count: unhealthyAgents(state).length, tone: 'degraded' },
    jobs: { count: runningJobs(state).length, tone: 'running' },
    history: { count: failedJobsSince(state, TWENTY_FOUR_HOURS_MS, now).length, tone: 'unavailable' },
    timeline: { count: unseenTimelineCount(state), tone: 'muted' },
    config: { count: unresolvedAgents(state).length, tone: 'degraded' },
  }
  const result = {}
  for (const key of Object.keys(counts)) {
    result[key] = counts[key].count > 0 ? counts[key] : null
  }
  return result
}

const STATUS_BADGES = {
  ready: { label: 'Ready', tone: 'ready', icon: 'check' },
  degraded: { label: 'Degraded', tone: 'degraded', icon: 'warn' },
  unavailable: { label: 'Unavailable', tone: 'unavailable', icon: 'error' },
  skipped: { label: 'Skipped', tone: 'muted', icon: 'clock' },
  queued: { label: 'Queued', tone: 'muted', icon: 'clock' },
  running: { label: 'Running', tone: 'running', icon: 'play' },
  succeeded: { label: 'Succeeded', tone: 'ready', icon: 'check' },
  failed: { label: 'Failed', tone: 'unavailable', icon: 'error' },
  canceled: { label: 'Canceled', tone: 'muted', icon: 'pause' },
}

/** Status badge for an AgentStatus or JobStatus value. */
export function statusBadge(status) {
  const known = STATUS_BADGES[status]
  if (known) return known
  const label = status ? String(status) : 'unknown'
  return { label: label.charAt(0).toUpperCase() + label.slice(1), tone: 'muted', icon: 'clock' }
}

/** errorKind badge; tone from ERROR_KIND_SEVERITY, unknown kinds -> 'degraded'. */
export function errorBadge(errorKind) {
  if (!errorKind) return { label: '—', tone: 'muted' }
  const tone = ERROR_KIND_SEVERITY[errorKind] || 'degraded'
  return { label: errorKind, tone }
}
