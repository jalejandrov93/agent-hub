import crypto from 'node:crypto'
import { paths } from './config.mjs'
import { readJsonSafe, updateJsonLocked } from './fsutil.mjs'

/**
 * Recurring Jules tasks. The Jules REST API has no scheduling — "Scheduled
 * tasks" lives only in the Jules web UI — so agent-hub owns recurrence itself
 * and persists it here. The scheduler that fires these lives in the dashboard
 * process (src/scheduler.mjs), because that is the only long-lived process:
 * the MCP server is a per-session stdio process that dies with Claude.
 *
 * Every write goes through updateJsonLocked for the same reason accounts.mjs
 * does: the dashboard and the MCP server are separate processes that may both
 * touch schedules.json.
 *
 * Schema: { version: 1, schedules: [ { id, label, enabled, schedule, prompt,
 * source, startingBranch, automationMode, requirePlanApproval, accountId,
 * lastRunAt, lastJobId, lastStatus, nextRunAt, createdAt, updatedAt } ] }
 *
 * `schedule` is either { kind:'interval', everyMinutes } or
 * { kind:'daily', at:'HH:MM', weekdays:[0..6] } — `at` is LOCAL 24h time and an
 * empty/absent weekdays list means every day (0 is Sunday).
 */

const DEFAULT_SCHEDULES_FILE = { version: 1, schedules: [] }

/**
 * Each run spends a Jules task from a 100/day quota, so a sub-5-minute
 * interval is rejected: it would burn the whole daily quota in a couple of
 * hours and is almost never what a caller actually wants.
 */
export const MIN_INTERVAL_MINUTES = 5

const DAILY_AT_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/

function newScheduleId() {
  return `sched-${crypto.randomBytes(4).toString('hex')}`
}

function invalid(reason) {
  return new Error(`invalid schedule: ${reason}`)
}

/**
 * Normalize + validate a schedule shape, returning the canonical object to
 * persist. Throws `invalid schedule: <reason>` (the proposals.mjs wording) for
 * anything a caller could have gotten wrong.
 */
function validateSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    throw invalid('schedule must be an object')
  }

  if (schedule.kind === 'interval') {
    const { everyMinutes } = schedule
    if (!Number.isInteger(everyMinutes) || everyMinutes < MIN_INTERVAL_MINUTES) {
      throw invalid(`interval everyMinutes must be an integer >= ${MIN_INTERVAL_MINUTES}`)
    }
    return { kind: 'interval', everyMinutes }
  }

  if (schedule.kind === 'daily') {
    if (typeof schedule.at !== 'string' || !DAILY_AT_RE.test(schedule.at)) {
      throw invalid(`daily at must be "HH:MM" in 24h local time, got ${JSON.stringify(schedule.at)}`)
    }
    const weekdays = schedule.weekdays ?? []
    if (!Array.isArray(weekdays)) throw invalid('daily weekdays must be an array of integers 0..6')
    for (const day of weekdays) {
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        throw invalid('daily weekdays must be integers 0..6 (0 = Sunday)')
      }
    }
    return { kind: 'daily', at: schedule.at, weekdays: [...new Set(weekdays)].sort((a, b) => a - b) }
  }

  throw invalid(`unknown kind: ${JSON.stringify(schedule.kind)}`)
}

/**
 * `source` is REQUIRED (unlike an interactive delegate, which can infer one
 * from cwd): at fire time the scheduler runs in the dashboard process with no
 * meaningful cwd for the target repo, so there would be nothing to infer from.
 */
function requireSource(source) {
  if (typeof source !== 'string' || source.trim().length === 0) throw invalid('source is required')
  return source
}

function requirePrompt(prompt) {
  if (typeof prompt !== 'string' || prompt.trim().length === 0) throw invalid('prompt is required')
  return prompt
}

function readSchedules(env) {
  return readJsonSafe(paths(env).schedulesFile, DEFAULT_SCHEDULES_FILE)
}

/**
 * Pure: the next run time for `schedule` at or after `fromMs`, as an ISO
 * string. No Date.now() and no cron dependency — every branch is unit-tested
 * against a fixed `fromMs`. Daily times are interpreted in the LOCAL timezone,
 * because that is what a human typing "09:00" means.
 */
export function computeNextRunAt(schedule, fromMs) {
  if (schedule.kind === 'interval') {
    return new Date(fromMs + schedule.everyMinutes * 60_000).toISOString()
  }

  const [hours, minutes] = schedule.at.split(':').map(Number)
  const weekdays = schedule.weekdays ?? []
  const base = new Date(fromMs)

  // At most 7 days are needed for any non-empty weekday set; one extra day
  // covers an empty set whose time already passed today. The local Date
  // constructor rolls month/year boundaries and DST for us.
  for (let offset = 0; offset <= 8; offset++) {
    const candidate = new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset, hours, minutes, 0, 0)
    if (candidate.getTime() <= fromMs) continue
    if (weekdays.length > 0 && !weekdays.includes(candidate.getDay())) continue
    return candidate.toISOString()
  }

  // Unreachable for a validated schedule (see the loop bound above).
  throw invalid('could not compute a next run time')
}

/** Stored schedules, in creation (append) order. */
export function listSchedules(env = process.env) {
  return readSchedules(env).schedules.slice()
}

/** Create a schedule and compute its first nextRunAt. Throws `invalid schedule: <reason>`. */
export function createSchedule(input = {}, env = process.env, { nowMs = Date.now() } = {}) {
  const schedule = validateSchedule(input.schedule)
  const source = requireSource(input.source)
  const prompt = requirePrompt(input.prompt)
  const now = new Date(nowMs).toISOString()

  const record = {
    id: newScheduleId(),
    label: input.label ?? null,
    enabled: input.enabled !== false,
    schedule,
    prompt,
    source,
    startingBranch: input.startingBranch ?? null,
    automationMode: input.automationMode ?? 'AUTO_CREATE_PR',
    requirePlanApproval: input.requirePlanApproval === true,
    accountId: input.accountId ?? null,
    lastRunAt: null,
    lastJobId: null,
    lastStatus: null,
    nextRunAt: computeNextRunAt(schedule, nowMs),
    createdAt: now,
    updatedAt: now,
  }

  updateJsonLocked(
    paths(env).schedulesFile,
    (data) => {
      data.schedules.push(record)
      return data
    },
    { defaultValue: DEFAULT_SCHEDULES_FILE }
  )

  return record
}

/**
 * Merge `patch` into one schedule. `id` and `createdAt` are immutable. When
 * `schedule` changes, nextRunAt is recomputed from `nowMs`; the scheduler also
 * passes nextRunAt explicitly after a fire (with no `schedule` in the patch),
 * which is why nextRunAt is a plain patchable field too.
 */
export function updateSchedule(id, patch = {}, env = process.env, { nowMs = Date.now() } = {}) {
  const now = new Date(nowMs).toISOString()
  let updated

  updateJsonLocked(
    paths(env).schedulesFile,
    (data) => {
      const record = data.schedules.find((candidate) => candidate.id === id)
      if (!record) throw new Error(`schedule not found: ${id}`)

      if (Object.prototype.hasOwnProperty.call(patch, 'schedule')) {
        record.schedule = validateSchedule(patch.schedule)
        record.nextRunAt = computeNextRunAt(record.schedule, nowMs)
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'source')) record.source = requireSource(patch.source)
      if (Object.prototype.hasOwnProperty.call(patch, 'prompt')) record.prompt = requirePrompt(patch.prompt)

      for (const field of [
        'label',
        'enabled',
        'startingBranch',
        'automationMode',
        'requirePlanApproval',
        'accountId',
        'lastRunAt',
        'lastJobId',
        'lastStatus',
        'nextRunAt',
      ]) {
        if (patch[field] !== undefined) record[field] = patch[field]
      }

      record.updatedAt = now
      updated = record
      return data
    },
    { defaultValue: DEFAULT_SCHEDULES_FILE }
  )

  return updated
}

/** Remove a schedule. Throws `schedule not found: <id>`. */
export function deleteSchedule(id, env = process.env) {
  let found = false

  updateJsonLocked(
    paths(env).schedulesFile,
    (data) => {
      const next = data.schedules.filter((candidate) => candidate.id !== id)
      found = next.length !== data.schedules.length
      if (!found) return data
      data.schedules = next
      return data
    },
    { defaultValue: DEFAULT_SCHEDULES_FILE }
  )

  if (!found) throw new Error(`schedule not found: ${id}`)
  return { id, deleted: true }
}

function isDue(schedule, nowMs) {
  if (schedule.enabled === false) return false
  if (!schedule.nextRunAt) return false
  const nextMs = Date.parse(schedule.nextRunAt)
  return Number.isFinite(nextMs) && nextMs <= nowMs
}

/**
 * Enabled schedules whose nextRunAt has arrived. `listSchedulesFn` is
 * injectable so the scheduler can drive it from the same (possibly faked)
 * source it reads for everything else.
 */
export function dueSchedules(nowMs, env = process.env, { listSchedulesFn = listSchedules } = {}) {
  return listSchedulesFn(env).filter((schedule) => isDue(schedule, nowMs))
}
