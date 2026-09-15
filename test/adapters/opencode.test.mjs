import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildArgv, parseResult, classifyError, listModels } from '../../src/adapters/opencode.mjs'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'opencode')
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8')

test('buildArgv builds a read-mode plan argv without --auto', () => {
  const argv = buildArgv({
    model: 'opencode/muse-spark-1.3-contributor-free',
    prompt: 'Reply exactly: PONG',
    cwd: '/repo',
    mode: 'read',
    title: 'fixture-pong',
  })
  assert.deepEqual(argv, [
    'run',
    'Reply exactly: PONG',
    '-m',
    'opencode/muse-spark-1.3-contributor-free',
    '--format',
    'json',
    '--agent',
    'plan',
    '--dir',
    '/repo',
    '--title',
    'fixture-pong',
  ])
})

test('buildArgv builds a write-mode argv with --agent build and --auto', () => {
  const argv = buildArgv({ model: 'deepseek/deepseek-v4-flash', prompt: 'do it', cwd: '/repo', mode: 'write' })
  assert.ok(argv.includes('--auto'))
  assert.ok(argv.includes('build'))
  assert.ok(!argv.includes('plan'))
})

test('buildArgv defaults to read/plan when mode is omitted', () => {
  const argv = buildArgv({ model: 'x', prompt: 'p', cwd: '/repo' })
  assert.ok(argv.includes('plan'))
  assert.ok(!argv.includes('--auto'))
})

test('buildArgv adds --variant only when given', () => {
  const withVariant = buildArgv({ model: 'x', prompt: 'p', cwd: '/repo', variant: 'high' })
  assert.equal(withVariant[withVariant.indexOf('--variant') + 1], 'high')
  const withoutVariant = buildArgv({ model: 'x', prompt: 'p', cwd: '/repo' })
  assert.ok(!withoutVariant.includes('--variant'))
})

test('buildArgv adds -s <sessionId> only when given (session resume)', () => {
  const withSession = buildArgv({ model: 'x', prompt: 'p', cwd: '/repo', sessionId: 'ses_abc' })
  assert.equal(withSession[withSession.indexOf('-s') + 1], 'ses_abc')
  const withoutSession = buildArgv({ model: 'x', prompt: 'p', cwd: '/repo' })
  assert.ok(!withoutSession.includes('-s'))
})

test('parseResult reads the real success fixture (JSONL with a leading non-JSON noise line)', () => {
  const result = parseResult(read('success.jsonl'))
  assert.equal(result.ok, true)
  assert.equal(result.text, 'PONG')
  assert.equal(result.tokens, 39465)
  assert.equal(result.sessionId, 'ses_f6f0a1e89ffe702DvBLQmWfcpn')
})

test('classifyError returns null for a success stream', () => {
  assert.equal(classifyError(read('success.jsonl')), null)
})

test('classifyError treats a dropped text/step_finish stream as empty and retriable', () => {
  const result = parseResult(read('empty.jsonl'))
  assert.equal(result.ok, false)
  const error = classifyError(read('empty.jsonl'))
  assert.equal(error.kind, 'empty')
  assert.equal(error.retriable, true)
})

test('classifyError reports timeout when the process wrapper says timedOut (opencode ignores SIGTERM)', () => {
  const error = classifyError(read('success.jsonl'), { timedOut: true })
  assert.equal(error.kind, 'timeout')
})

test('classifyError detects a real DeepSeek 402/Insufficient Balance error event as "billing" (not "crash"), not retriable', () => {
  const error = classifyError(read('billing-402.jsonl'))
  assert.equal(error.kind, 'billing')
  assert.equal(error.retriable, false)
})

test('listModels parses the real `opencode models opencode --verbose` fixture', () => {
  const models = listModels(read('models-verbose.txt'))
  assert.equal(models.length, 7)
  const byId = Object.fromEntries(models.map((m) => [m.id, m]))
  assert.ok(byId['opencode/muse-spark-1.3-contributor-free'])
  assert.equal(byId['opencode/muse-spark-1.3-contributor-free'].cost.input, 0)
  assert.equal(byId['opencode/nemotron-3-ultra-free'].limit.context, 1000000)
})
