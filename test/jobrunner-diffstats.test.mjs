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

test('finishJob persists a final diffStats snapshot on a succeeded write-mode job', async (t) => {
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
    mode: 'write',
    adapterFor: () => noopAdapter(),
    spawn,
    runWithTimeout,
  })
  assert.ok(job.diffBase)

  // Simulate the agent's own work in the secondary worktree: one modified
  // tracked file, one new untracked file.
  fs.writeFileSync(path.join(secondary, 'a.txt'), 'x\nCHANGED\n')
  fs.writeFileSync(path.join(secondary, 'new.txt'), 'brand new\n')

  finish(0)
  await done

  const finalRecord = jobstore.readResult(job.jobId)
  assert.equal(finalRecord.status, 'succeeded')
  assert.ok(finalRecord.diffStats)
  assert.equal(finalRecord.diffStats.error, null)
  assert.equal(finalRecord.diffStats.filesChanged, 2)
  assert.ok(finalRecord.diffStats.additions > 0)
})

test('finishJob never persists diffStats for a read-mode job', async (t) => {
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

  finish(0)
  await done
  const finalRecord = jobstore.readResult(job.jobId)
  assert.equal(finalRecord.status, 'succeeded')
  assert.equal(finalRecord.diffStats ?? null, null)
})

test('cancelJob persists a final diffStats snapshot for a canceled write-mode job', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { startJob, cancelJob, jobstore } = await freshModules(home)
  const { secondary } = makeRepoWithSecondaryWorktree()

  const { spawn, runWithTimeout } = fakeSpawnAndTimeout()
  const { job } = startJob({
    agent: 'fake',
    model: 'm',
    task: 't',
    cwd: secondary,
    mode: 'write',
    adapterFor: () => noopAdapter(),
    spawn,
    runWithTimeout,
  })
  assert.ok(job.diffBase)

  fs.writeFileSync(path.join(secondary, 'a.txt'), 'x\nCHANGED\n')

  const updated = await cancelJob(job.jobId, {})
  assert.equal(updated.status, 'canceled')

  const finalRecord = jobstore.readResult(job.jobId)
  assert.equal(finalRecord.status, 'canceled')
  assert.ok(finalRecord.diffStats)
  assert.equal(finalRecord.diffStats.error, null)
  assert.equal(finalRecord.diffStats.filesChanged, 1)
})

test('finishJob flags a changedFiles mismatch against a handoff declared for the same workflow/step', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  process.env.AGENT_HUB_HOME = home
  const tag = Date.now() + Math.random()
  const jobrunner = await import('../src/jobrunner.mjs?t=' + tag)
  const jobstore = await import('../src/jobstore.mjs?t=' + tag)
  const context = await import('../src/context.mjs?t=' + tag)
  const { secondary } = makeRepoWithSecondaryWorktree()

  context.writeHandoff({
    workflowId: 'wf-1',
    stepId: 'step-1',
    handoff: { summary: 'did work', changedFiles: ['declared-only.txt'] },
    schema: 'ImplementationHandoff',
  })

  const { spawn, runWithTimeout, finish } = fakeSpawnAndTimeout()
  const { job, done } = jobrunner.startJob({
    agent: 'fake',
    model: 'm',
    task: 't',
    cwd: secondary,
    mode: 'write',
    adapterFor: () => noopAdapter(),
    spawn,
    runWithTimeout,
    workflow_id: 'wf-1',
    step_id: 'step-1',
  })

  fs.writeFileSync(path.join(secondary, 'measured-only.txt'), 'x\n')

  finish(0)
  await done

  const finalRecord = jobstore.readResult(job.jobId)
  assert.ok(finalRecord.diffStats)
  const mismatch = finalRecord.diffStats.changedFilesMismatch
  assert.ok(mismatch)
  assert.equal(mismatch.matches, false)
  assert.deepEqual(mismatch.onlyDeclared, ['declared-only.txt'])
  assert.deepEqual(mismatch.onlyMeasured, ['measured-only.txt'])
})

test('getJobDiffStats computes live stats for a running write-mode job on demand', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { startJob, getJobDiffStats } = await freshModules(home)
  const { secondary } = makeRepoWithSecondaryWorktree()

  const { spawn, runWithTimeout } = fakeSpawnAndTimeout()
  const { job } = startJob({
    agent: 'fake',
    model: 'm',
    task: 't',
    cwd: secondary,
    mode: 'write',
    adapterFor: () => noopAdapter(),
    spawn,
    runWithTimeout,
  })

  fs.writeFileSync(path.join(secondary, 'a.txt'), 'x\nCHANGED\n')

  const live = await getJobDiffStats({ jobId: job.jobId })
  assert.ok(live)
  assert.equal(live.error, null)
  assert.equal(live.filesChanged, 1)
})

test('getJobDiffStats returns null for a read-mode job and for a write-mode job without a baseline', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { startJob, getJobDiffStats } = await freshModules(home)
  const { secondary } = makeRepoWithSecondaryWorktree()
  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-nongit-live-'))
  t.after(() => fs.rmSync(nonGitDir, { recursive: true, force: true }))

  const readJob = startJob({
    agent: 'fake',
    model: 'm',
    task: 't',
    cwd: secondary,
    mode: 'read',
    adapterFor: () => noopAdapter(),
    ...fakeSpawnAndTimeout(),
  }).job

  const writeNonGitJob = startJob({
    agent: 'fake',
    model: 'm',
    task: 't',
    cwd: nonGitDir,
    mode: 'write',
    adapterFor: () => noopAdapter(),
    allowlist: [nonGitDir],
    ...fakeSpawnAndTimeout(),
  }).job

  assert.equal(await getJobDiffStats({ jobId: readJob.jobId }), null)
  assert.equal(await getJobDiffStats({ jobId: writeNonGitJob.jobId }), null)
})

test('getJobDiffStats returns the persisted snapshot for a terminal job without recomputing', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { startJob, getJobDiffStats, jobstore } = await freshModules(home)
  const { secondary } = makeRepoWithSecondaryWorktree()

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
  fs.writeFileSync(path.join(secondary, 'a.txt'), 'x\nCHANGED\n')
  finish(0)
  await done

  // Deleting the worktree proves getJobDiffStats reads the persisted
  // snapshot for a terminal job instead of recomputing against a cwd that
  // may no longer exist.
  fs.rmSync(secondary, { recursive: true, force: true })

  const persisted = jobstore.readResult(job.jobId).diffStats
  const live = await getJobDiffStats({ jobId: job.jobId })
  assert.deepEqual(live, persisted)
})

test('getJobDiffStats caches a live computation for the cache TTL', async (t) => {
  const home = tmpHome()
  t.after(() => fs.rmSync(home, { recursive: true, force: true }))
  const { startJob, getJobDiffStats, diffstats } = await (async () => {
    const mods = await freshModules(home)
    const tag = Date.now() + Math.random()
    const diffstats = await import('../src/diffstats.mjs?t=' + tag)
    return { ...mods, diffstats }
  })()
  const { secondary } = makeRepoWithSecondaryWorktree()

  const { spawn, runWithTimeout } = fakeSpawnAndTimeout()
  const { job } = startJob({
    agent: 'fake',
    model: 'm',
    task: 't',
    cwd: secondary,
    mode: 'write',
    adapterFor: () => noopAdapter(),
    spawn,
    runWithTimeout,
  })

  let calls = 0
  const countingFn = async (...args) => {
    calls++
    return diffstats.computeDiffStats(...args)
  }

  const cache = diffstats.createDiffStatsCache({ ttlMs: 10_000 })
  const first = await getJobDiffStats({ jobId: job.jobId, cache, computeDiffStatsFn: countingFn })
  const second = await getJobDiffStats({ jobId: job.jobId, cache, computeDiffStatsFn: countingFn })
  assert.equal(calls, 1)
  assert.deepEqual(first, second)
})
