import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { takeSnapshot, diffSnapshots, formatViolation } from '../src/readguard.mjs'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-readguard-'))
  git(['init', '-q'], dir)
  git(['config', 'user.email', 'test@test.local'], dir)
  git(['config', 'user.name', 'Test'], dir)
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello')
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'init'], dir)
  return dir
}

test('takeSnapshot returns null outside a git work tree', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-readguard-notgit-'))
  assert.equal(takeSnapshot(dir), null)
})

test('takeSnapshot returns null when the injected exec throws', () => {
  const dir = makeRepo()
  const exec = () => {
    throw new Error('boom')
  }
  assert.equal(takeSnapshot(dir, { exec }), null)
})

test('clean before/after snapshots produce no diff', () => {
  const dir = makeRepo()
  const before = takeSnapshot(dir)
  const after = takeSnapshot(dir)
  const diff = diffSnapshots(before, after)
  assert.deepEqual(diff, { changed: false, headChanged: false, paths: [] })
})

test('new untracked file is detected', () => {
  const dir = makeRepo()
  const before = takeSnapshot(dir)
  fs.writeFileSync(path.join(dir, 'new.txt'), 'x')
  const after = takeSnapshot(dir)
  const diff = diffSnapshots(before, after)
  assert.equal(diff.changed, true)
  assert.equal(diff.headChanged, false)
  assert.deepEqual(diff.paths, ['new.txt'])
})

test('modified tracked file is detected', () => {
  const dir = makeRepo()
  const before = takeSnapshot(dir)
  fs.appendFileSync(path.join(dir, 'a.txt'), ' world')
  const after = takeSnapshot(dir)
  const diff = diffSnapshots(before, after)
  assert.equal(diff.changed, true)
  assert.deepEqual(diff.paths, ['a.txt'])
})

test('deleted tracked file is detected', () => {
  const dir = makeRepo()
  const before = takeSnapshot(dir)
  fs.rmSync(path.join(dir, 'a.txt'))
  const after = takeSnapshot(dir)
  const diff = diffSnapshots(before, after)
  assert.equal(diff.changed, true)
  assert.deepEqual(diff.paths, ['a.txt'])
})

test('a file already dirty before the job that is modified again is flagged (fingerprint change)', () => {
  const dir = makeRepo()
  fs.appendFileSync(path.join(dir, 'a.txt'), ' first-change')
  const before = takeSnapshot(dir)
  // Sleep-free mtime bump: change size too, so the fingerprint differs even
  // on filesystems with coarse mtime resolution.
  fs.appendFileSync(path.join(dir, 'a.txt'), ' second-change-longer')
  const after = takeSnapshot(dir)
  const diff = diffSnapshots(before, after)
  assert.equal(diff.changed, true)
  assert.deepEqual(diff.paths, ['a.txt'])
})

test('unchanged pre-existing dirt is not flagged', () => {
  const dir = makeRepo()
  fs.appendFileSync(path.join(dir, 'a.txt'), ' pre-existing-dirt')
  const before = takeSnapshot(dir)
  // Touch an unrelated clean file's snapshot pass only; a.txt is left alone.
  const after = takeSnapshot(dir)
  const diff = diffSnapshots(before, after)
  assert.deepEqual(diff, { changed: false, headChanged: false, paths: [] })
})

test('a new commit is detected as headChanged', () => {
  const dir = makeRepo()
  const before = takeSnapshot(dir)
  fs.writeFileSync(path.join(dir, 'b.txt'), 'y')
  git(['add', '-A'], dir)
  git(['commit', '-q', '-m', 'second'], dir)
  const after = takeSnapshot(dir)
  const diff = diffSnapshots(before, after)
  assert.equal(diff.changed, true)
  assert.equal(diff.headChanged, true)
})

test('a rename is detected, covering both the new and old paths in porcelain -z output', () => {
  const dir = makeRepo()
  const before = takeSnapshot(dir)
  git(['mv', 'a.txt', 'renamed.txt'], dir)
  const after = takeSnapshot(dir)
  const diff = diffSnapshots(before, after)
  assert.equal(diff.changed, true)
  assert.deepEqual(diff.paths, ['a.txt', 'renamed.txt'])
})

test('repo with no commits yields a null head', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-readguard-nocommit-'))
  git(['init', '-q'], dir)
  const snap = takeSnapshot(dir)
  assert.ok(snap)
  assert.equal(snap.head, null)
})

test('more than 5000 dirty entries falls back to a truncated, count-only snapshot', () => {
  const dir = makeRepo()
  const exec = (cmd, args, opts) => {
    if (args[0] === 'status') {
      let out = ''
      for (let i = 0; i < 5001; i++) out += `?? file${i}.txt\0`
      return out
    }
    return execFileSync(cmd, args, opts)
  }
  const snap = takeSnapshot(dir, { exec })
  assert.deepEqual(snap.entries, { truncated: true, count: 5001 })
})

test('truncated snapshots compare by count and head only', () => {
  const dir = makeRepo()
  const makeExec = (count) => (cmd, args, opts) => {
    if (args[0] === 'status') {
      let out = ''
      for (let i = 0; i < count; i++) out += `?? file${i}.txt\0`
      return out
    }
    return execFileSync(cmd, args, opts)
  }
  const before = takeSnapshot(dir, { exec: makeExec(5001) })
  const sameCount = takeSnapshot(dir, { exec: makeExec(5001) })
  const diffCount = takeSnapshot(dir, { exec: makeExec(5002) })

  assert.deepEqual(diffSnapshots(before, sameCount), { changed: false, headChanged: false, paths: [] })
  const changed = diffSnapshots(before, diffCount)
  assert.equal(changed.changed, true)
  assert.deepEqual(changed.paths, [])
})

test('a null snapshot on either side is unverifiable, not a violation', () => {
  const dir = makeRepo()
  const after = takeSnapshot(dir)
  assert.deepEqual(diffSnapshots(null, after), { changed: false, headChanged: false, paths: [], unverifiable: true })
  assert.deepEqual(diffSnapshots(after, null), { changed: false, headChanged: false, paths: [], unverifiable: true })
  assert.deepEqual(diffSnapshots(null, null), { changed: false, headChanged: false, paths: [], unverifiable: true })
})

test('diffSnapshots caps the reported path list at 50', () => {
  const dir = makeRepo()
  const before = takeSnapshot(dir)
  for (let i = 0; i < 60; i++) fs.writeFileSync(path.join(dir, `f${String(i).padStart(2, '0')}.txt`), 'x')
  const after = takeSnapshot(dir)
  const diff = diffSnapshots(before, after)
  assert.equal(diff.changed, true)
  assert.equal(diff.paths.length, 50)
})

test('formatViolation renders a one-line message with a bounded path list', () => {
  const diff = { changed: true, headChanged: false, paths: ['a.txt', 'src/x.mjs', 'test/y.mjs'] }
  assert.equal(formatViolation(diff), 'read-mode job modified 3 path(s): a.txt, src/x.mjs, test/y.mjs')
})

test('formatViolation truncates the listed paths past 10 and appends an ellipsis marker', () => {
  const paths = Array.from({ length: 12 }, (_, i) => `f${i}.txt`)
  const diff = { changed: true, headChanged: false, paths }
  const message = formatViolation(diff)
  assert.match(message, /^read-mode job modified 12 path\(s\): f0\.txt, f1\.txt, f2\.txt, f3\.txt, f4\.txt, f5\.txt, f6\.txt, f7\.txt, f8\.txt, f9\.txt, …$/)
})

test('formatViolation appends a HEAD-moved note', () => {
  const diff = { changed: true, headChanged: true, paths: ['a.txt'] }
  assert.equal(formatViolation(diff), 'read-mode job modified 1 path(s): a.txt and moved HEAD')
})
