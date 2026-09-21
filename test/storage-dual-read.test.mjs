import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { initDb, upsertJob, getJob, listJobIds, resetDbInstances, getDb } from '../src/storage/index.mjs'
import { createJob, readResult, compareJobReadPaths, _warnedDivergentJobIds } from '../src/jobstore.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-dual-read-'))
}

afterEach(() => {
  resetDbInstances()
})

test('listJobIds returns string[] in both SQLite and JSON fallback backends', () => {
  const homeSqlite = tmpHome()
  const sqliteCtx = initDb(homeSqlite)
  assert.equal(sqliteCtx.backend, 'sqlite')
  upsertJob(sqliteCtx, { job_id: 'job-sqlite-1', result_json: JSON.stringify({ jobId: 'job-sqlite-1' }) })
  upsertJob(sqliteCtx, { job_id: 'job-sqlite-2', result_json: JSON.stringify({ jobId: 'job-sqlite-2' }) })
  const sqliteIds = listJobIds(sqliteCtx)
  assert.deepEqual(sqliteIds.sort(), ['job-sqlite-1', 'job-sqlite-2'])

  const homeJson = tmpHome()
  const jsonCtx = { backend: 'json', stateHome: homeJson }
  upsertJob(jsonCtx, { job_id: 'job-json-1', result_json: JSON.stringify({ jobId: 'job-json-1' }) })
  upsertJob(jsonCtx, { job_id: 'job-json-2', result_json: JSON.stringify({ jobId: 'job-json-2' }) })
  const jsonIds = listJobIds(jsonCtx)
  assert.deepEqual(jsonIds.sort(), ['job-json-1', 'job-json-2'])
})

test('default mode unchanged: readResult returns JSON record even if DB diverges', () => {
  const home = tmpHome()
  const env = { ...process.env, AGENT_HUB_HOME: home, AGENT_HUB_STORE: 'json' }
  const created = createJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'default mode check',
    cwd: '/tmp',
    title: 'test',
    env,
  })

  // Diverge DB directly
  const ctx = getDb(env)
  const row = getJob(ctx, created.jobId)
  assert.ok(row)
  const parsed = JSON.parse(row.result_json)
  parsed.status = 'diverged_in_db'
  upsertJob(ctx, { ...row, result_json: JSON.stringify(parsed) })

  // readResult with default / 'json' mode must return file record ('queued')
  const resDefault = readResult(created.jobId, { ...process.env, AGENT_HUB_HOME: home })
  assert.equal(resDefault.status, 'queued')

  const resExplicitJson = readResult(created.jobId, env)
  assert.equal(resExplicitJson.status, 'queued')
})

test('shadow mode reports zero divergences for a normally created job', () => {
  const home = tmpHome()
  const env = { ...process.env, AGENT_HUB_HOME: home, AGENT_HUB_STORE: 'shadow' }
  const created = createJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'shadow zero divergence check',
    cwd: '/tmp',
    title: 'test',
    env,
  })

  const comparison = compareJobReadPaths(created.jobId, env)
  assert.equal(comparison.divergences.length, 0)
  assert.ok(comparison.json)
  assert.ok(comparison.sqlite)
  assert.equal(comparison.json.jobId, created.jobId)
  assert.equal(comparison.sqlite.jobId, created.jobId)

  const res = readResult(created.jobId, env)
  assert.equal(res.jobId, created.jobId)
  assert.equal(res.status, 'queued')
})

test('deliberately diverged DB row is reported with differing fields and shadow warns once', () => {
  const home = tmpHome()
  const env = { ...process.env, AGENT_HUB_HOME: home, AGENT_HUB_STORE: 'shadow' }
  const created = createJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'shadow divergence check',
    cwd: '/tmp',
    title: 'test',
    env,
  })

  const ctx = getDb(env)
  const row = getJob(ctx, created.jobId)
  assert.ok(row)
  const parsed = JSON.parse(row.result_json)
  parsed.status = 'diverged_status'
  parsed.revision = 'rev-db-42'
  upsertJob(ctx, { ...row, result_json: JSON.stringify(parsed) })

  const comparison = compareJobReadPaths(created.jobId, env)
  assert.equal(comparison.divergences.length, 2)
  const statusDiv = comparison.divergences.find((d) => d.field === 'status')
  assert.deepEqual(statusDiv, { field: 'status', json: 'queued', sqlite: 'diverged_status' })
  const revDiv = comparison.divergences.find((d) => d.field === 'revision')
  assert.deepEqual(revDiv, { field: 'revision', json: null, sqlite: 'rev-db-42' })

  // Verify console.warn in shadow mode happens ONCE per divergent jobId
  const originalWarn = console.warn
  let warnCount = 0
  let warnedArgs = []
  console.warn = (...args) => {
    warnCount++
    warnedArgs.push(args)
  }
  try {
    const res1 = readResult(created.jobId, env)
    assert.equal(res1.status, 'queued') // shadow keeps JSON as response
    assert.equal(warnCount, 1)

    const res2 = readResult(created.jobId, env)
    assert.equal(res2.status, 'queued')
    assert.equal(warnCount, 1) // still 1: warned ONCE per divergent jobId
  } finally {
    console.warn = originalWarn
  }
})

test('sqlite mode returns DB value when present and falls back to JSON when absent', () => {
  const home = tmpHome()
  const env = { ...process.env, AGENT_HUB_HOME: home, AGENT_HUB_STORE: 'sqlite' }
  const created = createJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'sqlite mode check',
    cwd: '/tmp',
    title: 'test',
    env,
  })

  // Diverge DB
  const ctx = getDb(env)
  const row = getJob(ctx, created.jobId)
  assert.ok(row)
  const parsed = JSON.parse(row.result_json)
  parsed.status = 'sqlite_preferred'
  upsertJob(ctx, { ...row, result_json: JSON.stringify(parsed) })

  // 'sqlite' mode returns the DB value
  const resFromDb = readResult(created.jobId, env)
  assert.equal(resFromDb.status, 'sqlite_preferred')

  // Now delete DB row: should fall back to JSON file
  ctx.db.prepare('DELETE FROM jobs WHERE job_id = ?').run(created.jobId)
  const resFallback = readResult(created.jobId, env)
  assert.equal(resFallback.status, 'queued')
})

test('a job absent from both throws job not found and compareJobReadPaths does not throw', () => {
  const home = tmpHome()
  const env = { ...process.env, AGENT_HUB_HOME: home, AGENT_HUB_STORE: 'sqlite' }
  const absentId = '2026-09-20T00-00-00-000Z-nonexistent'

  assert.throws(
    () => readResult(absentId, env),
    /job not found: 2026-09-20T00-00-00-000Z-nonexistent/
  )

  const comparison = compareJobReadPaths(absentId, env)
  assert.deepEqual(comparison, { json: null, sqlite: null, divergences: [] })
})
