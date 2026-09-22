import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { captureDiffBase, computeDiffStats } from '../src/diffstats.mjs'

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo(cwd) {
  git(['init', '-q'], cwd)
  git(['config', 'user.email', 'test@test.local'], cwd)
  git(['config', 'user.name', 'Test'], cwd)
}

function commitAll(cwd, message) {
  git(['add', '-A'], cwd)
  git(['commit', '-q', '-m', message], cwd)
}

test('captureDiffBase', async (t) => {
  let repo

  t.beforeEach(() => {
    repo = tmpDir('agent-hub-diffbase-')
  })

  t.afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  await t.test('returns HEAD when cwd is a git work tree with a commit', () => {
    initRepo(repo)
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x')
    commitAll(repo, 'init')
    const expectedHead = git(['rev-parse', 'HEAD'], repo).trim()

    const base = captureDiffBase({ cwd: repo })
    assert.equal(base, expectedHead)
  })

  await t.test('returns null for a non-git cwd, without throwing', () => {
    const base = captureDiffBase({ cwd: repo }) // repo dir exists but `git init` never ran
    assert.equal(base, null)
  })

  await t.test('returns null for a git repo with no commits yet', () => {
    initRepo(repo)
    const base = captureDiffBase({ cwd: repo })
    assert.equal(base, null)
  })

  await t.test('returns null when the git binary is unavailable, without throwing', () => {
    initRepo(repo)
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x')
    commitAll(repo, 'init')

    const throwingExec = () => {
      throw new Error('ENOENT: git not found')
    }
    const base = captureDiffBase({ cwd: repo, execFn: throwingExec })
    assert.equal(base, null)
  })
})

test('computeDiffStats', async (t) => {
  let repo

  t.beforeEach(() => {
    repo = tmpDir('agent-hub-diffstats-')
  })

  t.afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  await t.test('returns null when baseCommit is missing (no baseline -> no stats, no error)', async () => {
    const stats = await computeDiffStats({ cwd: repo, baseCommit: null })
    assert.equal(stats, null)
  })

  await t.test('measures modified + new + untracked files against the baseline, including a commit made after it', async () => {
    initRepo(repo)
    fs.writeFileSync(path.join(repo, 'keep.txt'), 'unchanged\n')
    fs.writeFileSync(path.join(repo, 'modify.txt'), 'line1\nline2\nline3\n')
    commitAll(repo, 'init')
    const base = git(['rev-parse', 'HEAD'], repo).trim()

    // Simulate the agent's work: modify a tracked file, commit it (still
    // measured because numstat diffs the WORKING TREE against base), then
    // add a brand-new tracked file, and finally an untracked file.
    fs.writeFileSync(path.join(repo, 'modify.txt'), 'line1\nCHANGED\nline3\nline4\n')
    git(['add', 'modify.txt'], repo)
    git(['commit', '-q', '-m', 'agent edit'], repo)

    fs.writeFileSync(path.join(repo, 'new-tracked.txt'), 'brand new\n')
    git(['add', 'new-tracked.txt'], repo)
    git(['commit', '-q', '-m', 'agent adds file'], repo)

    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'a\nb\nc\n')

    const stats = await computeDiffStats({ cwd: repo, baseCommit: base })

    assert.equal(stats.baseCommit, base)
    assert.equal(stats.error, null)
    assert.equal(stats.truncated, false)
    assert.equal(stats.filesChanged, 3)

    const byPath = Object.fromEntries(stats.files.map((f) => [f.path, f]))
    assert.ok(byPath['modify.txt'])
    assert.equal(byPath['modify.txt'].binary, false)
    assert.equal(byPath['modify.txt'].deletions, 1)
    assert.ok(byPath['new-tracked.txt'])
    assert.equal(byPath['new-tracked.txt'].additions, 1)
    assert.ok(byPath['scratch.txt'])
    assert.equal(byPath['scratch.txt'].additions, 3)
    assert.equal(byPath['scratch.txt'].binary, false)

    assert.equal(stats.additions, byPath['modify.txt'].additions + byPath['new-tracked.txt'].additions + byPath['scratch.txt'].additions)
    assert.equal(stats.deletions, byPath['modify.txt'].deletions)
  })

  await t.test('counts an untracked binary file as 0 lines with binary:true', async () => {
    initRepo(repo)
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n')
    commitAll(repo, 'init')
    const base = git(['rev-parse', 'HEAD'], repo).trim()

    fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 5]))

    const stats = await computeDiffStats({ cwd: repo, baseCommit: base })
    const entry = stats.files.find((f) => f.path === 'blob.bin')
    assert.ok(entry)
    assert.equal(entry.binary, true)
    assert.equal(entry.additions, 0)
    assert.equal(entry.deletions, 0)
  })

  await t.test('marks a tracked binary change from numstat (-\\t-) as binary with 0 lines', async () => {
    initRepo(repo)
    fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2]))
    commitAll(repo, 'init')
    const base = git(['rev-parse', 'HEAD'], repo).trim()

    fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 9, 9, 9]))

    const stats = await computeDiffStats({ cwd: repo, baseCommit: base })
    const entry = stats.files.find((f) => f.path === 'blob.bin')
    assert.ok(entry)
    assert.equal(entry.binary, true)
    assert.equal(entry.additions, 0)
    assert.equal(entry.deletions, 0)
  })

  await t.test('caps the file list at maxFiles and sets truncated, while filesChanged stays the true total', async () => {
    initRepo(repo)
    fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n')
    commitAll(repo, 'init')
    const base = git(['rev-parse', 'HEAD'], repo).trim()

    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(repo, `u${i}.txt`), 'x\n')
    }

    const stats = await computeDiffStats({ cwd: repo, baseCommit: base, maxFiles: 2 })
    assert.equal(stats.truncated, true)
    assert.equal(stats.files.length, 2)
    assert.equal(stats.filesChanged, 5)
  })

  await t.test('degrades to null numeric fields with a reason when the git call fails, and never throws', async () => {
    initRepo(repo)
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n')
    commitAll(repo, 'init')

    const stats = await computeDiffStats({ cwd: repo, baseCommit: 'not-a-real-commit-sha' })
    assert.equal(stats.additions, null)
    assert.equal(stats.deletions, null)
    assert.equal(stats.filesChanged, null)
    assert.deepEqual(stats.files, [])
    assert.equal(typeof stats.error, 'string')
    assert.ok(stats.error.length > 0)
  })

  await t.test('bounds the git call with a timeout via the injected runner', async () => {
    initRepo(repo)
    fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n')
    commitAll(repo, 'init')
    const base = git(['rev-parse', 'HEAD'], repo).trim()

    const hangingRunner = async () => ({ stdout: '', stderr: '', code: null, timedOut: true })
    const stats = await computeDiffStats({ cwd: repo, baseCommit: base, runner: hangingRunner })
    assert.equal(stats.additions, null)
    assert.match(stats.error, /timed out/)
  })
})
