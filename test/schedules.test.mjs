import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  computeNextRunAt,
  dueSchedules,
} from '../src/schedules.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-schedules-'))
}

// 2026-09-16 08:00 LOCAL, a Wednesday. Every expected value below is built
// with the local Date constructor, exactly like computeNextRunAt does, so the
// tests hold in any timezone.
const BASE_MS = new Date(2026, 8, 16, 8, 0, 0, 0).getTime()
const WEDNESDAY = 3
const MONDAY = 1
const FRIDAY = 5

const INTERVAL = { kind: 'interval', everyMinutes: 30 }

function baseInput(extra = {}) {
  return {
    label: 'nightly',
    schedule: INTERVAL,
    prompt: 'run the tests',
    source: 'sources/github/acme/widgets',
    ...extra,
  }
}

test('createSchedule stores a record with a computed nextRunAt and defaults', () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const created = createSchedule(baseInput(), env, { nowMs: BASE_MS })

  assert.match(created.id, /^sched-/)
  assert.equal(created.enabled, true)
  assert.equal(created.source, 'sources/github/acme/widgets')
  assert.equal(created.prompt, 'run the tests')
  assert.equal(created.automationMode, 'AUTO_CREATE_PR')
  assert.equal(created.requirePlanApproval, false)
  assert.equal(created.accountId, null)
  assert.equal(created.nextRunAt, new Date(BASE_MS + 30 * 60_000).toISOString())
  assert.equal(created.lastRunAt, null)
  assert.equal(created.lastJobId, null)
  assert.equal(created.lastStatus, null)
  assert.equal(created.createdAt, new Date(BASE_MS).toISOString())

  const listed = listSchedules(env)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, created.id)
})

test('updateSchedule merges fields and recomputes nextRunAt only when schedule changes', () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const created = createSchedule(baseInput(), env, { nowMs: BASE_MS })

  const labelOnly = updateSchedule(created.id, { label: 'renamed' }, env, { nowMs: BASE_MS + 60_000 })
  assert.equal(labelOnly.label, 'renamed')
  assert.equal(labelOnly.nextRunAt, created.nextRunAt, 'a label change keeps the pending next run')

  const rescheduled = updateSchedule(created.id, { schedule: { kind: 'interval', everyMinutes: 60 } }, env, { nowMs: BASE_MS + 60_000 })
  assert.equal(rescheduled.nextRunAt, new Date(BASE_MS + 60_000 + 60 * 60_000).toISOString())

  assert.throws(() => updateSchedule('nope', { label: 'x' }, env), /schedule not found: nope/)
})

test('deleteSchedule removes the record and throws for an unknown id', () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const created = createSchedule(baseInput(), env, { nowMs: BASE_MS })

  assert.deepEqual(deleteSchedule(created.id, env), { id: created.id, deleted: true })
  assert.deepEqual(listSchedules(env), [])
  assert.throws(() => deleteSchedule(created.id, env), /schedule not found:/)
})

test('createSchedule rejects an interval below the 5-minute floor', () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  assert.throws(
    () => createSchedule(baseInput({ schedule: { kind: 'interval', everyMinutes: 4 } }), env, { nowMs: BASE_MS }),
    /invalid schedule: .*everyMinutes/
  )
  assert.throws(
    () => createSchedule(baseInput({ schedule: { kind: 'interval', everyMinutes: 10.5 } }), env, { nowMs: BASE_MS }),
    /invalid schedule: .*everyMinutes/
  )
})

test('createSchedule rejects a missing source — there is no cwd to infer one from at fire time', () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  assert.throws(() => createSchedule(baseInput({ source: '' }), env, { nowMs: BASE_MS }), /invalid schedule: source is required/)

  const { source, ...noSource } = baseInput()
  void source
  assert.throws(() => createSchedule(noSource, env, { nowMs: BASE_MS }), /invalid schedule: source is required/)
})

test('createSchedule rejects a missing prompt', () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  assert.throws(() => createSchedule(baseInput({ prompt: '   ' }), env, { nowMs: BASE_MS }), /invalid schedule: prompt is required/)
})

test('createSchedule rejects a malformed daily time', () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  for (const at of ['25:00', '9:00', 'noon', '10:60', '']) {
    assert.throws(
      () => createSchedule(baseInput({ schedule: { kind: 'daily', at, weekdays: [] } }), env, { nowMs: BASE_MS }),
      /invalid schedule: .*at/,
      `expected ${JSON.stringify(at)} to be rejected`
    )
  }
})

test('createSchedule rejects a weekday outside 0..6 and an unknown kind', () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  assert.throws(
    () => createSchedule(baseInput({ schedule: { kind: 'daily', at: '10:00', weekdays: [7] } }), env, { nowMs: BASE_MS }),
    /invalid schedule: .*weekdays/
  )
  assert.throws(() => createSchedule(baseInput({ schedule: { kind: 'cron', expr: '* * * * *' } }), env, { nowMs: BASE_MS }), /invalid schedule: .*kind/)
})

test('computeNextRunAt: interval adds everyMinutes to fromMs', () => {
  assert.equal(computeNextRunAt({ kind: 'interval', everyMinutes: 5 }, BASE_MS), new Date(BASE_MS + 5 * 60_000).toISOString())
})

test('computeNextRunAt: daily at a later time today returns today', () => {
  const next = computeNextRunAt({ kind: 'daily', at: '10:00', weekdays: [] }, BASE_MS)
  assert.equal(next, new Date(2026, 8, 16, 10, 0, 0, 0).toISOString())
})

test('computeNextRunAt: daily at a time already past rolls to tomorrow', () => {
  const next = computeNextRunAt({ kind: 'daily', at: '06:00', weekdays: [] }, BASE_MS)
  assert.equal(next, new Date(2026, 8, 17, 6, 0, 0, 0).toISOString())
})

test('computeNextRunAt: a weekday filter skips disallowed days', () => {
  // Wednesday 08:00; 06:00 already passed, and only Monday is allowed -> +5 days.
  const next = computeNextRunAt({ kind: 'daily', at: '06:00', weekdays: [MONDAY] }, BASE_MS)
  const expected = new Date(2026, 8, 16, 6, 0, 0, 0)
  expected.setDate(expected.getDate() + 5)
  assert.equal(next, expected.toISOString())
  assert.equal(new Date(next).getDay(), MONDAY)
})

test('computeNextRunAt: a weekday set spanning several days picks the next allowed one', () => {
  // Wednesday 08:00, at 06:00 already past: Thursday and Saturday are not in
  // the set, so the next allowed day is Friday.
  const next = computeNextRunAt({ kind: 'daily', at: '06:00', weekdays: [MONDAY, WEDNESDAY, FRIDAY] }, BASE_MS)
  assert.equal(next, new Date(2026, 8, 18, 6, 0, 0, 0).toISOString())
  assert.equal(new Date(next).getDay(), FRIDAY)
})

test('computeNextRunAt: an absent weekdays list means every day', () => {
  assert.equal(computeNextRunAt({ kind: 'daily', at: '10:00' }, BASE_MS), new Date(2026, 8, 16, 10, 0, 0, 0).toISOString())
})

test('computeNextRunAt is pure: the same inputs always yield the same output', () => {
  const schedule = { kind: 'daily', at: '06:00', weekdays: [MONDAY] }
  assert.equal(computeNextRunAt(schedule, BASE_MS), computeNextRunAt(schedule, BASE_MS))
})

test('dueSchedules returns only enabled schedules whose nextRunAt has arrived', () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const due = createSchedule(baseInput({ label: 'due' }), env, { nowMs: BASE_MS })
  const later = createSchedule(baseInput({ label: 'later', schedule: { kind: 'interval', everyMinutes: 60 } }), env, { nowMs: BASE_MS })
  const disabled = createSchedule(baseInput({ label: 'off' }), env, { nowMs: BASE_MS })
  updateSchedule(disabled.id, { enabled: false }, env, { nowMs: BASE_MS })

  const ids = dueSchedules(BASE_MS + 30 * 60_000, env).map((schedule) => schedule.id)
  assert.deepEqual(ids, [due.id])
  assert.ok(!ids.includes(later.id))
  assert.ok(!ids.includes(disabled.id))
})
