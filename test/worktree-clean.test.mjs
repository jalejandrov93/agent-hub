import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { isWorktreeClean } from '../src/worktree.mjs'

test('isWorktreeClean', async (t) => {
  let tmpDir

  t.beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-clean-test-'))
  })

  t.afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  await t.test('clean when git status is empty', () => {
    execFileSync('git', ['init'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir })

    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello')
    execFileSync('git', ['add', 'file.txt'], { cwd: tmpDir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })

    const result = isWorktreeClean(tmpDir)
    assert.deepEqual(result, { clean: true, dirtyPaths: [] })
  })

  await t.test('dirty when untracked file exists', () => {
    execFileSync('git', ['init'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir })

    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello')
    execFileSync('git', ['add', 'file.txt'], { cwd: tmpDir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })

    fs.writeFileSync(path.join(tmpDir, 'untracked.txt'), 'new')

    const result = isWorktreeClean(tmpDir)
    assert.equal(result.clean, false)
    assert.deepEqual(result.dirtyPaths, ['untracked.txt'])
  })

  await t.test('dirty when modified file exists', () => {
    execFileSync('git', ['init'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: tmpDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tmpDir })

    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello')
    execFileSync('git', ['add', 'file.txt'], { cwd: tmpDir })
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir })

    fs.writeFileSync(path.join(tmpDir, 'file.txt'), 'hello world')

    const result = isWorktreeClean(tmpDir)
    assert.equal(result.clean, false)
    assert.deepEqual(result.dirtyPaths, ['file.txt'])
  })

  await t.test('non-git cwd returns not-a-git-worktree without throwing', () => {
    const result = isWorktreeClean(tmpDir)
    assert.deepEqual(result, { clean: false, reason: 'not-a-git-worktree' })
  })
})
