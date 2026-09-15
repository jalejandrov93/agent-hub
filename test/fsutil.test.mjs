import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeJsonAtomic, readJsonSafe, updateJsonLocked } from '../src/fsutil.mjs'

const FSUTIL_PATH = fileURLToPath(new URL('../src/fsutil.mjs', import.meta.url))

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-fsutil-'))
}

function lockAndTmpLeftovers(dir) {
  return fs.readdirSync(dir).filter((f) => f.includes('.lock') || f.includes('.tmp'))
}

test('writeJsonAtomic writes a file that parses back to the same data', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'data.json')
  writeJsonAtomic(file, { a: 1, b: [1, 2, 3] })
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(parsed, { a: 1, b: [1, 2, 3] })
})

test('writeJsonAtomic leaves no .tmp file behind in the target directory', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'data.json')
  writeJsonAtomic(file, { ok: true })
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'))
  assert.deepEqual(leftovers, [])
})

test('writeJsonAtomic creates the parent directory if missing', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'nested', 'deep', 'data.json')
  writeJsonAtomic(file, { nested: true })
  assert.equal(fs.existsSync(file), true)
})

test('writeJsonAtomic overwrites an existing file instead of merging', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'data.json')
  writeJsonAtomic(file, { first: 1 })
  writeJsonAtomic(file, { second: 2 })
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(parsed, { second: 2 })
})

test('repeated writes never leave a stale temp file even under back-to-back calls', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'data.json')
  for (let i = 0; i < 10; i++) writeJsonAtomic(file, { i })
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'))
  assert.deepEqual(leftovers, [])
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { i: 9 })
})

test('readJsonSafe returns the default value when the file does not exist', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'missing.json')
  assert.deepEqual(readJsonSafe(file, { a: 1 }), { a: 1 })
})

test('readJsonSafe returns the default value when the file contains invalid JSON', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'garbled.json')
  fs.writeFileSync(file, '{not valid json')
  assert.deepEqual(readJsonSafe(file, { a: 1 }), { a: 1 })
})

test('readJsonSafe returns a clone of the default, not the same object reference', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'missing.json')
  const defaultValue = { list: [1, 2] }
  const result = readJsonSafe(file, defaultValue)
  result.list.push(3)
  assert.deepEqual(defaultValue.list, [1, 2], 'mutating the returned value must not mutate the caller-supplied default')
})

test('readJsonSafe returns the parsed content when the file is valid JSON', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'data.json')
  writeJsonAtomic(file, { real: true })
  assert.deepEqual(readJsonSafe(file, {}), { real: true })
})

test('updateJsonLocked creates the file from defaultValue and applies the updater when the file is missing', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'state.json')
  const result = updateJsonLocked(file, (current) => ({ ...current, x: 1 }), { defaultValue: { seed: true } })
  assert.deepEqual(result, { seed: true, x: 1 })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { seed: true, x: 1 })
})

test('updateJsonLocked supports mutate-in-place updaters that return undefined', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'state.json')
  updateJsonLocked(file, (current) => {
    current.count = (current.count ?? 0) + 1
  })
  updateJsonLocked(file, (current) => {
    current.count = (current.count ?? 0) + 1
  })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { count: 2 })
})

test('updateJsonLocked leaves no .lock and no .tmp files behind after a successful update', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'state.json')
  updateJsonLocked(file, (current) => ({ ...current, ok: true }))
  assert.deepEqual(lockAndTmpLeftovers(dir), [])
})

test('updateJsonLocked releases the lock when the updater throws, and the error propagates', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'state.json')
  assert.throws(() => {
    updateJsonLocked(file, () => {
      throw new Error('updater exploded')
    })
  }, /updater exploded/)
  assert.deepEqual(lockAndTmpLeftovers(dir), [])
})

test('updateJsonLocked reclaims a lock left by a dead pid', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'state.json')
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 999999, acquiredAt: new Date().toISOString() }))

  const result = updateJsonLocked(file, (current) => ({ ...current, done: true }))
  assert.deepEqual(result, { done: true })
  assert.deepEqual(lockAndTmpLeftovers(dir), [])
})

test('updateJsonLocked throws "lock timeout" when a live-pid lock is held throughout', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'state.json')
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }))

  assert.throws(() => {
    updateJsonLocked(file, (current) => current, { retries: 3, retryDelayMs: 5 })
  }, new RegExp(`lock timeout: ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
})

test('two processes racing 200 updateJsonLocked increments each never lose an update', async () => {
  const dir = tmpDir()
  const file = path.join(dir, 'race.json')
  const fileUrl = new URL('file://' + FSUTIL_PATH.replace(/\\/g, '/')).href

  const script = `
    import { updateJsonLocked } from '${fileUrl}'
    for (let i = 0; i < 200; i++) {
      updateJsonLocked(${JSON.stringify(file)}, (current) => ({ count: (current.count ?? 0) + 1 }))
    }
  `

  function runChild() {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.on('data', (d) => {
        stderr += d.toString()
      })
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`child exited ${code}: ${stderr}`))
      })
      child.on('error', reject)
    })
  }

  await Promise.all([runChild(), runChild()])

  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { count: 400 })
})
