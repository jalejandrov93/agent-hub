import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { execFileSync } from 'node:child_process'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-jobrunner-diffstats-'))
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeRepoWithSecondaryWorktree() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-diffstats-repo-'))
  const primary = path.join(base, 'primary')
  const secondary = path.join(base, 'secondary')
  fs.mkdirSync(primary)
  git(['init', '-q'], primary)
  git(['config', 'user.email', 'test@test.local'], primary)
  git(['config', 'user.name', 'Test'], primary)
  fs.writeFileSync(path.join(primary, 'a.txt'), 'x')
  git(['add', '-A'], primary)
  git(['commit', '-q', '-m', 'init'], primary)
  git(['worktree', 'add', secondary, '-b', 'wt-branch'], primary)
  return { primary, secondary }
}

async function freshModules(home) {
  process.env.AGENT_HUB_HOME = home
  const tag = Date.now() + Math.random()
  const jobrunner = await import('../src/jobrunner.mjs?t=' + tag)
  const jobstore = await import('../src/jobstore.mjs?t=' + tag)
  return { ...jobrunner, jobstore }
}

/** A minimal fake child_process.ChildProcess: closes on the next tick, never spawns anything real. */
function fakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

function noopAdapter() {
  return {
    id: 'fake',
    cmd: 'fake-cmd',
    buildArgv: () => [],
    parseResult: () => ({ ok: true, text: '' }),
    classifyError: () => null,
    listModels: () => [],
  }
}

/** startJob spawns via `spawn`, then relies on runWithTimeout's exitPromise
 * to drive finishJob. This fake spawn+runWithTimeout pair lets the test
 * control exactly when/how the "child" exits without a real process. */
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

test('startJob captures a diffBase for a write-mode job in a git work tree', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { startJob, jobstore } = await freshModules(home)
  const { secondary } = makeRepoWithSecondaryWorktree()
  const expectedHead = git(['rev-parse', 'HEAD'], secondary).trim()

  const { spawn, runWithTimeout, finish } = fakeSpawnAndTimeout()
  const { job, done } = startJob({
    agent: 'fake',
    model: 'm',
    task: 't',
    cwd: secondary,
    mode: 'write',
    adapterFor: () => noopAdapter(),
    spawn,
    runWithTimeout,
  })

  assert.equal(job.diffBase, expectedHead)

  finish(0)
  await done
  const finalRecord = jobstore.readResult(job.jobId)
  assert.equal(finalRecord.diffBase, expectedHead)
})

test('startJob records no diffBase for a read-mode job (never captured)', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { startJob, jobstore } = await freshModules(home)
  const { secondary } = makeRepoWithSecondaryWorktree()

  const { spawn, runWithTimeout, finish } = fakeSpawnAndTimeout()
  const { job, done } = startJob({
    agent: 'fake',
    model: 'm',
    task: 't',
    cwd: secondary,
    mode: 'read',
    adapterFor: () => noopAdapter(),
    spawn,
    runWithTimeout,
  })

  assert.equal(job.diffBase ?? null, null)
  finish(0)
  await done
  const finalRecord = jobstore.readResult(job.jobId)
  assert.equal(finalRecord.diffBase ?? null, null)
})

test('startJob records no diffBase for a write-mode job in a non-git cwd, without failing the job', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { startJob, jobstore } = await freshModules(home)
  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-nongit-'))
  t.after(() => fs.rmSync(nonGitDir, { recursive: true, force: true }))

  const { spawn, runWithTimeout, finish } = fakeSpawnAndTimeout()
  const { job, done } = startJob({
    agent: 'fake',
    model: 'm',
    task: 't',
    cwd: nonGitDir,
    mode: 'write',
    adapterFor: () => noopAdapter(),
    spawn,
    runWithTimeout,
    allowlist: [nonGitDir],
  })

  assert.equal(job.diffBase ?? null, null)
  finish(0)
  await done
  const finalRecord = jobstore.readResult(job.jobId)
  assert.equal(finalRecord.status, 'succeeded')
  assert.equal(finalRecord.diffBase ?? null, null)
})
