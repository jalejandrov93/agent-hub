import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { writeJsonAtomic } from '../src/fsutil.mjs'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-fsutil-'))
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
