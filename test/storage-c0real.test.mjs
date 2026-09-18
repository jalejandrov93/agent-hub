import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { paths } from '../src/config.mjs'
import { initDb, getJob, upsertJob, getLease } from '../src/storage/index.mjs'
import { getDb, closeDb, resetDbInstances } from '../src/storage/db.mjs'
import { createJob, updateResult, readResult } from '../src/jobstore.mjs'
import { acquireWriteLock, heartbeatWriteLock, releaseWriteLock } from '../src/worktree.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-c0real-'))
}

test('paths() includes dbFile under home', () => {
  const home = tmpHome()
  const p = paths({ AGENT_HUB_HOME: home })
  assert.equal(p.dbFile, path.join(home, 'agent-hub.db'))
})

test('initDb initializes SQLite in WAL mode and creates C0 tables', () => {
  const home = tmpHome()
  const ctx = initDb(home)
  assert.equal(ctx.backend, 'sqlite')
  assert.ok(ctx.db)
  assert.ok(fs.existsSync(paths({ AGENT_HUB_HOME: home }).dbFile))

  const mode = ctx.db.pragma('journal_mode', { simple: true })
  assert.equal(mode, 'wal')

  // Verify tables exist
  const tables = ctx.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
  assert.ok(tables.includes('workflows'))
  assert.ok(tables.includes('workflow_nodes'))
  assert.ok(tables.includes('jobs'))
  assert.ok(tables.includes('leases'))

  ctx.db.close()
})

test('getDb(env) returns singleton cached by stateHome', () => {
  const home1 = tmpHome()
  const home2 = tmpHome()
  const env1 = { AGENT_HUB_HOME: home1 }
  const env2 = { AGENT_HUB_HOME: home2 }

  const db1a = getDb(env1)
  const db1b = getDb(env1)
  assert.equal(db1a, db1b)

  const db2 = getDb(env2)
  assert.notEqual(db1a, db2)

  closeDb(env1)
  closeDb(env2)
})

test('DoD a) crash/recovery: create job + write SQLite, simulate kill, reopen DB and reconstruct state', () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  // 1. Create job with full C0 provenance fields
  const created = createJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-medium',
    task: 'audit C0 persistence',
    cwd: '/tmp',
    title: 'C0 crash recovery test',
    workflow_id: 'wf-100',
    step_id: 'step-recon',
    parent_execution_id: 'exec-root',
    root_execution_id: 'exec-root',
    attempt: 1,
    remote_state: 'dispatched',
    quality_score: 0.92,
    verified: true,
    judge_verdict: 'approved',
    env,
  })

  assert.ok(created.jobId)

  // Verify it wrote result.json
  const fileResult = readResult(created.jobId, env)
  assert.equal(fileResult.workflow_id, 'wf-100')
  assert.equal(fileResult.quality_score, 0.92)
  assert.equal(fileResult.verified, true)

  // Verify it mirrored to SQLite in ctx1
  const ctx1 = getDb(env)
  const row1 = getJob(ctx1, created.jobId)
  assert.ok(row1)
  assert.equal(row1.job_id, created.jobId)
  assert.equal(row1.workflow_id, 'wf-100')
  assert.equal(row1.step_id, 'step-recon')
  assert.equal(row1.attempt, 1)
  assert.equal(row1.remote_state, 'dispatched')
  assert.equal(row1.quality_score, 0.92)
  assert.equal(row1.verified, 1)
  assert.equal(row1.judge_verdict, 'approved')

  // 2. Simulate kill: close DB, clear cached singletons, discard ctx1
  closeDb(env)
  resetDbInstances()

  // 3. Reopen DB in a fresh context (as if a new process booted)
  const freshCtx = initDb(home)
  const recovered = getJob(freshCtx, created.jobId)
  assert.ok(recovered)
  assert.equal(recovered.job_id, created.jobId)
  assert.equal(recovered.workflow_id, 'wf-100')
  assert.equal(recovered.step_id, 'step-recon')
  assert.equal(recovered.parent_execution_id, 'exec-root')
  assert.equal(recovered.root_execution_id, 'exec-root')
  assert.equal(recovered.attempt, 1)
  assert.equal(recovered.remote_state, 'dispatched')
  assert.equal(recovered.quality_score, 0.92)
  assert.equal(recovered.verified, 1)
  assert.equal(recovered.judge_verdict, 'approved')

  // Parse result_json blob
  const parsedJson = JSON.parse(recovered.result_json)
  assert.equal(parsedJson.jobId, created.jobId)
  assert.equal(parsedJson.workflow_id, 'wf-100')
  assert.equal(parsedJson.title, 'C0 crash recovery test')

  // 4. Verify recovery via a separate Node child process (true cross-process crash test)
  const script = `
    import { initDb, getJob } from './src/storage/index.mjs'
    const ctx = initDb(process.env.AGENT_HUB_HOME)
    const job = getJob(ctx, ${JSON.stringify(created.jobId)})
    if (!job || job.workflow_id !== 'wf-100') process.exit(2)
    process.stdout.write(JSON.stringify(job))
  `
  const childOut = execFileSync('node', ['--input-type=module', '-e', script], {
    env: { ...process.env, AGENT_HUB_HOME: home },
    encoding: 'utf8',
  })
  const childJob = JSON.parse(childOut)
  assert.equal(childJob.job_id, created.jobId)
  assert.equal(childJob.workflow_id, 'wf-100')

  freshCtx.db.close()
})

test('DoD b) 2 concurrent writers same job via WAL -> no lost update, last write wins completely, JSON parseable', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }

  const job = createJob({
    agent: 'agy',
    model: 'gemini-3.8-flash-low',
    task: 'concurrent write test',
    cwd: '/tmp',
    title: 'concurrency',
    env,
  })

  // Two writers with interleaved async steps updating the same job
  const writer1 = async () => {
    await new Promise((resolve) => setImmediate(resolve))
    return updateResult(
      job.jobId,
      {
        attempt: 1,
        quality_score: 0.85,
        judge_verdict: 'pass',
        note: 'writer1-payload',
      },
      env
    )
  }

  const writer2 = async () => {
    await new Promise((resolve) => setTimeout(resolve, 5))
    return updateResult(
      job.jobId,
      {
        attempt: 2,
        quality_score: 0.98,
        judge_verdict: 'exceptional',
        note: 'writer2-payload',
      },
      env
    )
  }

  // Interleaved execution
  const [res1, res2] = await Promise.all([writer1(), writer2()])

  // Verify file on disk
  const fileResult = readResult(job.jobId, env)
  assert.ok(fileResult)
  // One of the writers won completely
  assert.ok(fileResult.note === 'writer1-payload' || fileResult.note === 'writer2-payload')

  // Verify SQLite mirror matches the file
  const ctx = getDb(env)
  const dbRow = getJob(ctx, job.jobId)
  assert.ok(dbRow)

  // JSON in SQLite is valid and parseable
  const parsed = JSON.parse(dbRow.result_json)
  assert.equal(parsed.jobId, job.jobId)
  assert.equal(dbRow.note, undefined) // column not in schema, lives in result_json
  assert.equal(parsed.note, fileResult.note)
  assert.equal(dbRow.attempt, fileResult.attempt)
  assert.equal(dbRow.quality_score, fileResult.quality_score)
  assert.equal(dbRow.judge_verdict, fileResult.judge_verdict)

  closeDb(env)
})

test('Worktree leases mirror to SQLite leases table', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const fakeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-wt-'))

  // 1. Acquire
  const acq = acquireWriteLock({ cwd: fakeCwd, jobId: 'job-lease-1', env, ttlMs: 60000 })
  assert.equal(acq.acquired, true)
  assert.ok(acq.token)

  const ctx = getDb(env)
  const leaseRow = getLease(ctx, 'job-lease-1')
  assert.ok(leaseRow)
  assert.equal(leaseRow.job_id, 'job-lease-1')
  assert.equal(leaseRow.owner, acq.token)
  assert.ok(leaseRow.expires_at)

  const expires1 = leaseRow.expires_at

  // 2. Heartbeat extends expires_at
  await new Promise((r) => setTimeout(r, 10))
  const beat = heartbeatWriteLock({ cwd: fakeCwd, token: acq.token, env, ttlMs: 120000 })
  assert.equal(beat, true)

  const leaseRow2 = getLease(ctx, 'job-lease-1')
  assert.ok(new Date(leaseRow2.expires_at).getTime() >= new Date(expires1).getTime())

  // 3. Release removes lease from table
  const rel = releaseWriteLock({ cwd: fakeCwd, token: acq.token, jobId: 'job-lease-1', env })
  assert.equal(rel, true)

  const leaseRow3 = getLease(ctx, 'job-lease-1')
  assert.equal(leaseRow3, null)

  closeDb(env)
})
