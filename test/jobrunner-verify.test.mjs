import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'

// D2 (agy-hub-verification): hub-side verification for delegate/dispatch.
// After a job reaches 'succeeded', the hub runs the caller's `verify` argv
// checks in the foreground (src/verify.mjs's runJobVerification) and
// records `verification` on the job record. incomplete/failed/canceled
// jobs skip verification with a recorded reason; verification never changes
// job status. See odd/tasks/agy-hub-verification.md.

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-jobrunner-verify-'))
}

async function freshModules(home) {
  process.env.AGENT_HUB_HOME = home
  const tag = Date.now() + Math.random()
  const jobrunner = await import('../src/jobrunner.mjs?t=' + tag)
  const jobstore = await import('../src/jobstore.mjs?t=' + tag)
  return { ...jobrunner, jobstore }
}

function fakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

/** classifyErrorKind: null means success; a string makes finishJob take the error branch. */
function noopAdapter({ classifyErrorKind = null } = {}) {
  return {
    id: 'fake',
    cmd: 'fake-cmd',
    buildArgv: () => [],
    parseResult: () => ({ ok: true, text: '' }),
    classifyError: () => (classifyErrorKind ? { kind: classifyErrorKind, retriable: false, message: `fake ${classifyErrorKind}` } : null),
    listModels: () => [],
  }
}

function fakeSpawnAndTimeout() {
  const child = fakeChild()
  const spawn = () => child
  let resolveExit
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve
  })
  const runWithTimeout = () => ({ pgid: child.pid, exitPromise })
  return { spawn, runWithTimeout, finish: (code = 0) => resolveExit({ code, timedOut: false }) }
}

test('startJob rejects an invalid verify check synchronously, before any job record is created', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { startJob, jobstore } = await freshModules(home)
  const { spawn, runWithTimeout } = fakeSpawnAndTimeout()

  assert.throws(
    () =>
      startJob({
        agent: 'fake',
        model: 'm',
        task: 't',
        cwd: '/tmp',
        mode: 'read',
        adapterFor: () => noopAdapter(),
        spawn,
        runWithTimeout,
        verify: [{ name: 'bad', argv: [] }],
      }),
    /argv must be a non-empty array of non-empty strings/
  )
  assert.deepEqual(jobstore.listJobs(), [], 'no job record may exist after a fail-fast verify validation error')
})

test('a succeeded job with verify checks runs them in the job cwd and records verification on the record', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { startJob, jobstore } = await freshModules(home)
  const calls = []
  const runCommandFn = async (cmd, args, options) => {
    calls.push({ cmd, args, options })
    return { stdout: 'ok\n', stderr: '', code: 0, timedOut: false }
  }

  const { spawn, runWithTimeout, finish } = fakeSpawnAndTimeout()
  const { job, done } = startJob({
    agent: 'fake',
    model: 'm',
    task: 't',
    cwd: '/job/cwd',
    mode: 'read',
    adapterFor: () => noopAdapter(),
    spawn,
    runWithTimeout,
    runCommandFn,
    verify: [{ name: 'tests', argv: ['npm', 'test'] }],
  })

  finish(0)
  await done

  const finalRecord = jobstore.readResult(job.jobId)
  assert.equal(finalRecord.status, 'succeeded')
  assert.deepEqual(finalRecord.verification.ok, true)
  assert.equal(finalRecord.verification.checks.length, 1)
  assert.equal(finalRecord.verification.checks[0].name, 'tests')
  assert.equal(finalRecord.verification.checks[0].ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.cwd, '/job/cwd', 'verify checks default to the job cwd')
})

test('a failing verification check leaves job status succeeded, verification.ok=false, and no error/errorKind', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { startJob, jobstore } = await freshModules(home)
  const runCommandFn = async () => ({ stdout: '', stderr: 'FAIL: 1 test failed\n', code: 1, timedOut: false })

  const { spawn, runWithTimeout, finish } = fakeSpawnAndTimeout()
  const { job, done } = startJob({
    agent: 'fake',
    model: 'm',
    task: 't',
    cwd: '/job/cwd',
    mode: 'read',
    adapterFor: () => noopAdapter(),
    spawn,
    runWithTimeout,
    runCommandFn,
    verify: [{ name: 'tests', argv: ['npm', 'test'] }],
  })

  finish(0)
  await done

  const finalRecord = jobstore.readResult(job.jobId)
  assert.equal(finalRecord.status, 'succeeded', 'verification failure must never change job status')
  assert.equal(finalRecord.errorKind ?? null, null)
  assert.equal(finalRecord.error ?? null, null)
  assert.equal(finalRecord.verification.ok, false)
  assert.equal(finalRecord.verification.checks[0].ok, false)
  assert.equal(finalRecord.verification.checks[0].exitCode, 1)
})

test('a job with no verify param never gets a verification field at all', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { startJob, jobstore } = await freshModules(home)

  const { spawn, runWithTimeout, finish } = fakeSpawnAndTimeout()
  const { job, done } = startJob({
    agent: 'fake',
    model: 'm',
    task: 't',
    cwd: '/job/cwd',
    mode: 'read',
    adapterFor: () => noopAdapter(),
    spawn,
    runWithTimeout,
  })

  finish(0)
  await done
  const finalRecord = jobstore.readResult(job.jobId)
  assert.equal(finalRecord.status, 'succeeded')
  assert.equal(finalRecord.verification ?? null, null)
})

test('an incomplete (failed) agy-style job skips verification and records a reason instead of running checks', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { startJob, jobstore } = await freshModules(home)
  let ran = false
  const runCommandFn = async () => {
    ran = true
    return { stdout: '', stderr: '', code: 0, timedOut: false }
  }

  const { spawn, runWithTimeout, finish } = fakeSpawnAndTimeout()
  const { job, done } = startJob({
    agent: 'fake',
    model: 'm',
    task: 't',
    cwd: '/job/cwd',
    mode: 'read',
    adapterFor: () => noopAdapter({ classifyErrorKind: 'incomplete' }),
    spawn,
    runWithTimeout,
    runCommandFn,
    verify: [{ name: 'tests', argv: ['npm', 'test'] }],
  })

  finish(0)
  await done

  const finalRecord = jobstore.readResult(job.jobId)
  assert.equal(finalRecord.status, 'failed')
  assert.equal(finalRecord.errorKind, 'incomplete')
  assert.equal(ran, false, 'verification must never run for an incomplete job')
  assert.equal(finalRecord.verification.ok, null)
  assert.equal(finalRecord.verification.skipped, true)
  assert.match(finalRecord.verification.reason, /incomplete/)
  assert.deepEqual(finalRecord.verification.checks, [])
})

test('a plain failed job (e.g. crash) also skips verification with a recorded reason', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { startJob, jobstore } = await freshModules(home)
  let ran = false
  const runCommandFn = async () => {
    ran = true
    return { stdout: '', stderr: '', code: 0, timedOut: false }
  }

  const { spawn, runWithTimeout, finish } = fakeSpawnAndTimeout()
  const { job, done } = startJob({
    agent: 'fake',
    model: 'm',
    task: 't',
    cwd: '/job/cwd',
    mode: 'read',
    adapterFor: () => noopAdapter({ classifyErrorKind: 'crash' }),
    spawn,
    runWithTimeout,
    runCommandFn,
    verify: [{ name: 'tests', argv: ['npm', 'test'] }],
  })

  finish(0)
  await done

  const finalRecord = jobstore.readResult(job.jobId)
  assert.equal(finalRecord.status, 'failed')
  assert.equal(ran, false)
  assert.equal(finalRecord.verification.ok, null)
  assert.equal(finalRecord.verification.skipped, true)
})

test('job.finished event carries verificationOk for a succeeded verified job', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { startJob, jobstore } = await freshModules(home)
  const tag = Date.now() + Math.random()
  const { readTail } = await import('../src/eventlog.mjs?t=' + tag)
  const runCommandFn = async () => ({ stdout: 'ok', stderr: '', code: 0, timedOut: false })

  const { spawn, runWithTimeout, finish } = fakeSpawnAndTimeout()
  const { done } = startJob({
    agent: 'fake',
    model: 'm',
    task: 't',
    cwd: '/job/cwd',
    mode: 'read',
    adapterFor: () => noopAdapter(),
    spawn,
    runWithTimeout,
    runCommandFn,
    verify: [{ name: 'tests', argv: ['npm', 'test'] }],
  })

  finish(0)
  await done

  const events = readTail({ env: process.env, n: 50 })
  const finishedEvent = events.find((e) => e.kind === 'job.finished')
  assert.ok(finishedEvent)
  assert.equal(finishedEvent.verificationOk, true)
})

test('cancelJob records verification as skipped (with reason) for a canceled job that had verify checks configured', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { startJob, cancelJob, jobstore } = await freshModules(home)
  let ran = false
  const runCommandFn = async () => {
    ran = true
    return { stdout: '', stderr: '', code: 0, timedOut: false }
  }

  const { spawn } = fakeSpawnAndTimeout()
  // No runWithTimeout override here: the job stays 'running' until cancelJob kills it.
  const { job } = startJob({
    agent: 'fake',
    model: 'm',
    task: 't',
    cwd: '/job/cwd',
    mode: 'read',
    adapterFor: () => noopAdapter(),
    spawn,
    runCommandFn,
    verify: [{ name: 'tests', argv: ['npm', 'test'] }],
  })

  const result = await cancelJob(job.jobId, { env: process.env })
  assert.equal(result.status, 'canceled')
  assert.equal(ran, false)
  const finalRecord = jobstore.readResult(job.jobId)
  assert.equal(finalRecord.verification.ok, null)
  assert.equal(finalRecord.verification.skipped, true)
  assert.match(finalRecord.verification.reason, /cancel/i)
})
