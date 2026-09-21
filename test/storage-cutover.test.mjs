import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { paths } from '../src/config.mjs'
import { getDb, getJob, upsertJob, resetDbInstances } from '../src/storage/index.mjs'
import { createJob, readResult, listJobs, _warnedDivergentJobIds } from '../src/jobstore.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-cutover-'))
}

afterEach(() => {
  resetDbInstances()
})

test('json mode unchanged: readResult and listJobs behave identically to today', () => {
  const home = tmpHome()
  const env = { ...process.env, AGENT_HUB_HOME: home, AGENT_HUB_STORE: 'json' }

  const created = createJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'json mode unchanged check',
    cwd: '/tmp',
    title: 'test json mode',
    env,
  })

  // Diverge DB directly
  const ctx = getDb(env)
  const row = getJob(ctx, created.jobId)
  assert.ok(row)
  const parsed = JSON.parse(row.result_json)
  parsed.status = 'diverged_in_db'
  upsertJob(ctx, { ...row, result_json: JSON.stringify(parsed) })

  // readResult in json mode returns JSON record ('queued'), ignoring DB divergence
  const resRead = readResult(created.jobId, env)
  assert.equal(resRead.status, 'queued')

  // listJobs in json mode returns JSON record ('queued')
  const jobs = listJobs(env)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].jobId, created.jobId)
  assert.equal(jobs[0].status, 'queued')

  // A job existing ONLY in DB is ignored by json mode listJobs and readResult
  const dbOnlyId = '2026-09-20T00-00-00-000Z-dbonly'
  upsertJob(ctx, {
    job_id: dbOnlyId,
    result_json: JSON.stringify({ jobId: dbOnlyId, status: 'queued', createdAt: '2026-09-20T00:00:00.000Z' }),
  })
  assert.throws(() => readResult(dbOnlyId, env), /job not found/)
  const jobsAfterDbOnly = listJobs(env)
  assert.equal(jobsAfterDbOnly.length, 1)
  assert.equal(jobsAfterDbOnly[0].jobId, created.jobId)
})

test('sqlite mode: normally created job is returned; legacy job in runs/<id>/result.json is returned and backfilled', () => {
  const home = tmpHome()
  const env = { ...process.env, AGENT_HUB_HOME: home, AGENT_HUB_STORE: 'sqlite' }

  // 1. Normally created job
  const created = createJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'normally created job',
    cwd: '/tmp',
    title: 'normal job',
    env,
  })

  const resCreated = readResult(created.jobId, env)
  assert.equal(resCreated.jobId, created.jobId)
  assert.equal(resCreated.status, 'queued')

  const listNormal = listJobs(env)
  assert.equal(listNormal.length, 1)
  assert.equal(listNormal[0].jobId, created.jobId)

  // 2. Legacy job that exists ONLY as runs/<id>/result.json (no DB row)
  const legacyId = '2026-09-20T01-00-00-000Z-legacy1'
  const legacyDir = path.join(paths(env).runsDir, legacyId)
  fs.mkdirSync(legacyDir, { recursive: true })
  const legacyRecord = {
    jobId: legacyId,
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    status: 'succeeded',
    createdAt: '2026-09-20T01:00:00.000Z',
    updatedAt: '2026-09-20T01:05:00.000Z',
  }
  fs.writeFileSync(path.join(legacyDir, 'result.json'), JSON.stringify(legacyRecord, null, 2), 'utf8')

  // Verify DB does not have it initially
  const ctx = getDb(env)
  assert.equal(getJob(ctx, legacyId), null)

  // readResult in sqlite mode falls back to JSON and best-effort backfills into SQLite
  const resLegacy = readResult(legacyId, env)
  assert.equal(resLegacy.jobId, legacyId)
  assert.equal(resLegacy.status, 'succeeded')

  // Verify it has been backfilled into SQLite
  const backfilledRow = getJob(ctx, legacyId)
  assert.ok(backfilledRow)
  assert.equal(backfilledRow.job_id, legacyId)
  const parsedBackfill = JSON.parse(backfilledRow.result_json)
  assert.equal(parsedBackfill.jobId, legacyId)
  assert.equal(parsedBackfill.status, 'succeeded')

  // 3. Another legacy job that has NOT been read by readResult yet: listJobs returns it and backfills
  const legacyId2 = '2026-09-20T02-00-00-000Z-legacy2'
  const legacyDir2 = path.join(paths(env).runsDir, legacyId2)
  fs.mkdirSync(legacyDir2, { recursive: true })
  const legacyRecord2 = {
    jobId: legacyId2,
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    status: 'failed',
    createdAt: '2026-09-20T02:00:00.000Z',
    updatedAt: '2026-09-20T02:05:00.000Z',
  }
  fs.writeFileSync(path.join(legacyDir2, 'result.json'), JSON.stringify(legacyRecord2, null, 2), 'utf8')

  assert.equal(getJob(ctx, legacyId2), null)

  const listWithLegacy = listJobs(env)
  const foundLegacy2 = listWithLegacy.find((j) => j.jobId === legacyId2)
  assert.ok(foundLegacy2)
  assert.equal(foundLegacy2.status, 'failed')

  // Verify legacy2 is now backfilled in DB
  const backfilledRow2 = getJob(ctx, legacyId2)
  assert.ok(backfilledRow2)
  assert.equal(backfilledRow2.job_id, legacyId2)
})

test('sqlite mode returns the DB value when DB and file disagree', () => {
  const home = tmpHome()
  const env = { ...process.env, AGENT_HUB_HOME: home, AGENT_HUB_STORE: 'sqlite' }

  const created = createJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'disagreement test',
    cwd: '/tmp',
    title: 'original file title',
    env,
  })

  // Diverge DB directly
  const ctx = getDb(env)
  const row = getJob(ctx, created.jobId)
  assert.ok(row)
  const parsed = JSON.parse(row.result_json)
  parsed.title = 'DB preferred title'
  parsed.status = 'running_in_sqlite'
  parsed.updatedAt = '2026-09-20T03:00:00.000Z'
  upsertJob(ctx, { ...row, result_json: JSON.stringify(parsed) })

  // readResult returns DB value
  const resRead = readResult(created.jobId, env)
  assert.equal(resRead.title, 'DB preferred title')
  assert.equal(resRead.status, 'running_in_sqlite')

  // listJobs returns DB value
  const jobs = listJobs(env)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].title, 'DB preferred title')
  assert.equal(jobs[0].status, 'running_in_sqlite')
})

test('listJobs in sqlite mode returns the union in createdAt-desc order with no duplicates', () => {
  const home = tmpHome()
  const env = { ...process.env, AGENT_HUB_HOME: home, AGENT_HUB_STORE: 'sqlite' }
  const ctx = getDb(env)

  // Job A: created normally (both in DB and on disk)
  const jobA = createJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'job A',
    cwd: '/tmp',
    env,
  })
  // Overwrite createdAt to a specific timestamp
  const jobAPath = path.join(paths(env).runsDir, jobA.jobId, 'result.json')
  const jobAData = JSON.parse(fs.readFileSync(jobAPath, 'utf8'))
  jobAData.createdAt = '2026-09-20T10:00:00.000Z'
  fs.writeFileSync(jobAPath, JSON.stringify(jobAData, null, 2), 'utf8')
  upsertJob(ctx, { job_id: jobA.jobId, result_json: JSON.stringify(jobAData) })

  // Job B: exists ONLY in DB
  const jobBId = '2026-09-20T12-00-00-000Z-jobB'
  const jobBData = {
    jobId: jobBId,
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    status: 'queued',
    createdAt: '2026-09-20T12:00:00.000Z',
  }
  upsertJob(ctx, {
    job_id: jobBId,
    result_json: JSON.stringify(jobBData),
  })

  // Job C: exists ONLY on disk as runs/<id>/result.json
  const jobCId = '2026-09-20T11-00-00-000Z-jobC'
  const jobCDir = path.join(paths(env).runsDir, jobCId)
  fs.mkdirSync(jobCDir, { recursive: true })
  const jobCData = {
    jobId: jobCId,
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    status: 'queued',
    createdAt: '2026-09-20T11:00:00.000Z',
  }
  fs.writeFileSync(path.join(jobCDir, 'result.json'), JSON.stringify(jobCData, null, 2), 'utf8')

  const jobs = listJobs(env)
  assert.equal(jobs.length, 3)

  // Verify exact descending order by createdAt: B (12:00), C (11:00), A (10:00)
  assert.equal(jobs[0].jobId, jobBId)
  assert.equal(jobs[1].jobId, jobCId)
  assert.equal(jobs[2].jobId, jobA.jobId)

  // Verify no duplicate IDs
  const idSet = new Set(jobs.map((j) => j.jobId))
  assert.equal(idSet.size, 3)
})

test('shadow returns the JSON value and reports the divergence without changing the result', () => {
  const home = tmpHome()
  const env = { ...process.env, AGENT_HUB_HOME: home, AGENT_HUB_STORE: 'shadow' }

  _warnedDivergentJobIds.clear()

  const created = createJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'shadow test',
    cwd: '/tmp',
    title: 'json title',
    env,
  })

  // Diverge DB
  const ctx = getDb(env)
  const row = getJob(ctx, created.jobId)
  assert.ok(row)
  const parsed = JSON.parse(row.result_json)
  parsed.status = 'sqlite_status_diverged'
  parsed.revision = 'rev-db-99'
  upsertJob(ctx, { ...row, result_json: JSON.stringify(parsed) })

  const originalWarn = console.warn
  let warnCount = 0
  const warnings = []
  console.warn = (...args) => {
    warnCount++
    warnings.push(args)
  }

  try {
    // 1. readResult in shadow mode: warns once and returns JSON record
    const resRead = readResult(created.jobId, env)
    assert.equal(resRead.status, 'queued')
    assert.equal(warnCount, 1)

    // readResult again: no second warning
    const resRead2 = readResult(created.jobId, env)
    assert.equal(resRead2.status, 'queued')
    assert.equal(warnCount, 1)

    // 2. listJobs in shadow mode: does not re-warn for already warned jobId
    const list1 = listJobs(env)
    assert.equal(list1.length, 1)
    assert.equal(list1[0].status, 'queued')
    assert.equal(warnCount, 1)

    // 3. Create a second diverged job; listJobs warns once for it
    const created2 = createJob({
      agent: 'agy',
      model: 'gemini-3.8-flash-low',
      task: 'shadow test 2',
      cwd: '/tmp',
      title: 'json title 2',
      env,
    })
    const row2 = getJob(ctx, created2.jobId)
    const parsed2 = JSON.parse(row2.result_json)
    parsed2.status = 'sqlite_status_diverged_2'
    upsertJob(ctx, { ...row2, result_json: JSON.stringify(parsed2) })

    const list2 = listJobs(env)
    assert.equal(list2.length, 2)
    assert.equal(list2.find((j) => j.jobId === created2.jobId).status, 'queued')
    assert.equal(warnCount, 2)

    // listJobs again: no extra warnings
    const list3 = listJobs(env)
    assert.equal(list3.length, 2)
    assert.equal(warnCount, 2)
  } finally {
    console.warn = originalWarn
  }
})

test('a job missing from both: readResult throws, listJobs skips', () => {
  const home = tmpHome()
  const env = { ...process.env, AGENT_HUB_HOME: home, AGENT_HUB_STORE: 'sqlite' }
  const nonexistentId = '2026-09-20T00-00-00-000Z-nonexistent'

  assert.throws(
    () => readResult(nonexistentId, env),
    /job not found: 2026-09-20T00-00-00-000Z-nonexistent/
  )

  // An invalid / corrupted runs directory is skipped by listJobs
  const corruptedDir = path.join(paths(env).runsDir, 'corrupted-run-dir')
  fs.mkdirSync(corruptedDir, { recursive: true })
  fs.writeFileSync(path.join(corruptedDir, 'result.json'), '{ invalid json', 'utf8')

  const jobs = listJobs(env)
  assert.equal(jobs.length, 0)
})
