import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildArgv, parseResult, classifyError, listModels } from '../../src/adapters/copilot.mjs'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'copilot')
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8')

test('buildArgv denies write and shell tools in read mode', () => {
  const argv = buildArgv({ model: 'gpt-5-mini', prompt: 'Reply exactly: PONG', cwd: '/repo', mode: 'read' })
  assert.deepEqual(argv, [
    '-p',
    'Reply exactly: PONG',
    '-s',
    '--output-format',
    'json',
    '--model',
    'gpt-5-mini',
    '--no-ask-user',
    '--deny-tool=write',
    '--deny-tool=shell',
    '--add-dir',
    '/repo',
  ])
})

test('buildArgv allows all tools in write mode, with no deny-tool flags', () => {
  const argv = buildArgv({ model: 'claude-haiku-4.5', prompt: 'do it', cwd: '/repo', mode: 'write' })
  assert.ok(argv.includes('--allow-all-tools'))
  assert.ok(!argv.some((a) => a.startsWith('--deny-tool')))
})

test('parseResult reads the real success fixture (JSONL, text lives in the assistant.message event)', () => {
  const result = parseResult(read('success.jsonl'))
  assert.equal(result.ok, true)
  assert.equal(result.text, 'PONG')
  assert.equal(result.sessionId, '057e4919-2278-4977-a8f1-0e457150dff2')
  assert.equal(result.premiumRequests, 1)
})

test('classifyError returns null for a success stream', () => {
  assert.equal(classifyError(read('success.jsonl')), null)
})

test('a real model-unavailable rejection is not a successful JSON stream and classifies distinctly (not "crash")', () => {
  const result = parseResult(read('model_unavailable.txt'))
  assert.equal(result.ok, false)
  const error = classifyError(read('model_unavailable.txt'))
  assert.equal(error.kind, 'model_unavailable')
  assert.equal(error.retriable, false)
  assert.match(error.message, /gpt-5-mini/)
})

test('a real write-mode tool denial still parses as an overall success, with the denial surfaced separately', () => {
  const result = parseResult(read('tool_denied.jsonl'))
  assert.equal(result.ok, true, 'the copilot session itself completed (exitCode 0)')
  assert.equal(result.toolDenials.length, 1)
  assert.equal(result.toolDenials[0].message, 'Permission to run this tool was denied due to the following rules: `write`')
})

test('classifyError detects an unauthenticated failure', () => {
  const error = classifyError(read('auth_failed.txt'))
  assert.equal(error.kind, 'auth')
  assert.equal(error.retriable, false)
})

test('classifyError reports timeout when the process wrapper says timedOut', () => {
  const error = classifyError(read('success.jsonl'), { timedOut: true })
  assert.equal(error.kind, 'timeout')
})

test('listModels parses the documented catalog from `copilot help config` (advisory only — not account availability)', () => {
  const models = listModels(read('help-config.txt'))
  assert.ok(models.length >= 15, `expected at least 15 documented model ids, got ${models.length}`)
  assert.ok(models.some((m) => m.id === 'gpt-5-mini'))
  assert.ok(models.some((m) => m.id === 'claude-sonnet-4.6'))
})
