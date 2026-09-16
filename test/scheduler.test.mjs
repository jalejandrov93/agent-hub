import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { tick, runScheduleNow } from '../src/scheduler.mjs'
import { createSchedule, listSchedules, updateSchedule } from '../src/schedules.mjs'

// Wednesday 2026-09-16 08:00 local. Only interval schedules are used here, so
// the exact wall-clock time does not matter — only the arithmetic does.
const BASE_MS = new Date(2026, 8, 16, 8, 0, 0, 0).getTime()
const HALF_HOUR = 30 * 60_000

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-scheduler-'))
}

function makeSchedule(env, { label = 'nightly', schedule = { kind: 'interval', everyMinutes: 30 } } = {}) {
  return createSchedule(
    { label, schedule, prompt: 'do the thing', source: 'sources/github/acme/widgets' },
    env,
    { nowMs: BASE_MS }
  )
}

/** A readResultFn over a fixed jobId -> status map; unknown ids throw like jobstore.readResult. */
function fakeReadResult(statuses) {
  return (jobId) => {
    if (!(jobId in statuses)) throw new Error(`job not found: ${jobId}`)
    return { jobId, status: statuses[jobId] }
  }
}

function jobStarter(calls, { jobId = 'job-1', status = 'queued' } = {}) {
  return async (args) => {
    calls.push(args)
    return { job: { jobId, status }, done: Promise.resolve() }
  }
}

const deps = (extra) => ({
  listSchedulesFn: listSchedules,
  updateScheduleFn: updateSchedule,
  logFn: () => {},
  ...extra,
})

test('tick fires a due schedule once, stamps it, and advances nextRunAt', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const created = makeSchedule(env)
  const calls = []
  const nowFn = () => BASE_MS + HALF_HOUR

  await tick({ env, startJobFn: jobStarter(calls), nowFn, readResultFn: fakeReadResult({}), ...deps() })

  assert.equal(calls.length, 1)
  assert.equal(calls[0].agent, 'jules')
  assert.equal(calls[0].task, 'do the thing')
  assert.equal(calls[0].source, 'sources/github/acme/widgets')
  assert.equal(calls[0].title, 'nightly')

  const [stored] = listSchedules(env)
  assert.equal(stored.id, created.id)
  assert.equal(stored.lastJobId, 'job-1')
  assert.equal(stored.lastStatus, 'queued')
  assert.equal(stored.lastRunAt, new Date(BASE_MS + HALF_HOUR).toISOString())
  assert.equal(stored.nextRunAt, new Date(BASE_MS + 2 * HALF_HOUR).toISOString())

  // A second tick at the same instant must not fire again: nextRunAt moved past now.
  await tick({ env, startJobFn: jobStarter(calls), nowFn, readResultFn: fakeReadResult({}), ...deps() })
  assert.equal(calls.length, 1)
})

test('tick does not fire a schedule whose nextRunAt has not arrived', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  makeSchedule(env, { schedule: { kind: 'interval', everyMinutes: 60 } })
  const calls = []

  await tick({ env, startJobFn: jobStarter(calls), nowFn: () => BASE_MS + HALF_HOUR, readResultFn: fakeReadResult({}), ...deps() })

  assert.equal(calls.length, 0)
  assert.equal(listSchedules(env)[0].lastRunAt, null)
})

test('tick skips a due schedule while its previous job is still running, then resumes', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const created = makeSchedule(env)
  updateSchedule(created.id, { lastJobId: 'job-1', lastStatus: 'queued' }, env, { nowMs: BASE_MS })

  const calls = []
  const statuses = { 'job-1': 'running' }
  const readResultFn = fakeReadResult(statuses)

  await tick({
    env,
    startJobFn: jobStarter(calls, { jobId: 'job-2' }),
    nowFn: () => BASE_MS + HALF_HOUR,
    readResultFn,
    ...deps(),
  })

  assert.equal(calls.length, 0, 'an in-flight job must block a duplicate session against the same repo')
  let [stored] = listSchedules(env)
  assert.equal(stored.lastStatus, 'skipped')
  assert.equal(stored.lastJobId, 'job-1', 'a skipped occurrence does not replace the in-flight job id')
  assert.equal(stored.nextRunAt, new Date(BASE_MS + 2 * HALF_HOUR).toISOString())

  statuses['job-1'] = 'succeeded'
  await tick({
    env,
    startJobFn: jobStarter(calls, { jobId: 'job-2' }),
    nowFn: () => BASE_MS + 2 * HALF_HOUR,
    readResultFn,
    ...deps(),
  })

  assert.equal(calls.length, 1)
  ;[stored] = listSchedules(env)
  assert.equal(stored.lastJobId, 'job-2')
  assert.equal(stored.lastStatus, 'queued')
})

test('a throwing startJobFn advances nextRunAt and does not break the tick for other schedules', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const bad = makeSchedule(env, { label: 'bad' })
  const good = makeSchedule(env, { label: 'good' })
  const calls = []
  const logs = []

  const startJobFn = async (args) => {
    if (args.title === 'bad') throw new Error('boom')
    calls.push(args)
    return { job: { jobId: 'job-good', status: 'queued' }, done: Promise.resolve() }
  }

  await assert.doesNotReject(() =>
    tick({
      env,
      startJobFn,
      nowFn: () => BASE_MS + HALF_HOUR,
      readResultFn: fakeReadResult({}),
      listSchedulesFn: listSchedules,
      updateScheduleFn: updateSchedule,
      logFn: (message) => logs.push(String(message)),
    })
  )

  const stored = listSchedules(env)
  const storedBad = stored.find((schedule) => schedule.id === bad.id)
  const storedGood = stored.find((schedule) => schedule.id === good.id)

  assert.equal(storedBad.lastStatus, 'error')
  assert.equal(storedBad.nextRunAt, new Date(BASE_MS + 2 * HALF_HOUR).toISOString())
  assert.equal(storedGood.lastJobId, 'job-good', 'one bad schedule must not wedge the rest of the tick')
  assert.ok(logs.some((line) => line.includes(bad.id) && line.includes('could not start')), 'the failure is logged, never thrown')
})

test('runScheduleNow fires a schedule outside its nextRunAt window', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  const created = makeSchedule(env, { schedule: { kind: 'interval', everyMinutes: 60 } })
  const calls = []

  const updated = await runScheduleNow(created.id, {
    env,
    startJobFn: jobStarter(calls, { jobId: 'job-now' }),
    nowFn: () => BASE_MS,
    readResultFn: fakeReadResult({}),
    ...deps(),
  })

  assert.equal(calls.length, 1, 'the schedule was not due, but a manual run fires anyway')
  assert.equal(updated.lastJobId, 'job-now')
  assert.equal(listSchedules(env)[0].lastRunAt, new Date(BASE_MS).toISOString())
})

test('runScheduleNow rejects an unknown schedule id', async () => {
  const env = { AGENT_HUB_HOME: tmpHome() }
  await assert.rejects(() => runScheduleNow('nope', { env, ...deps() }), /schedule not found: nope/)
})
