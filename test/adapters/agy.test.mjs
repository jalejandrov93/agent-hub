import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildArgv, parseResult, classifyError, listModels } from '../../src/adapters/agy.mjs'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'agy')
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8')

test('buildArgv maps read mode to --mode plan, with stream-json output (agy only accepts plan|accept-edits)', () => {
  const argv = buildArgv({ model: 'gemini-3.8-flash-low', prompt: 'Reply exactly: PONG', cwd: '/repo', mode: 'read' })
  assert.deepEqual(argv, [
    '-p',
    'Reply exactly: PONG',
    '--output-format',
    'stream-json',
    '--model',
    'gemini-3.8-flash-low',
    '--mode',
    'plan',
    '--add-dir',
    '/repo',
    '--dangerously-skip-permissions',
  ])
})

test('buildArgv maps write mode to --mode accept-edits', () => {
  const argv = buildArgv({ model: 'gemini-3.8-flash-low', prompt: 'do it', cwd: '/repo', mode: 'write' })
  assert.ok(argv.includes('accept-edits'))
  assert.ok(!argv.includes('plan'))
})

test('buildArgv defaults to read/plan when mode is omitted', () => {
  const argv = buildArgv({ model: 'gemini-3.8-flash-low', prompt: 'p', cwd: '/repo' })
  assert.ok(argv.includes('plan'))
})

test('buildArgv adds --print-timeout <timeoutS>s only when timeoutS is given', () => {
  const withTimeout = buildArgv({ model: 'gemini-3.8-flash-low', prompt: 'p', cwd: '/repo', mode: 'read', timeoutS: 900 })
  assert.equal(withTimeout[withTimeout.indexOf('--print-timeout') + 1], '900s')

  const withoutTimeout = buildArgv({ model: 'gemini-3.8-flash-low', prompt: 'p', cwd: '/repo', mode: 'read' })
  assert.ok(!withoutTimeout.includes('--print-timeout'))
})

test('buildArgv adds --conversation <sessionId> only when sessionId is given (resume)', () => {
  const withSession = buildArgv({ model: 'x', prompt: 'p', cwd: '/repo', mode: 'read', sessionId: 'abc-123' })
  assert.equal(withSession[withSession.indexOf('--conversation') + 1], 'abc-123')

  const withoutSession = buildArgv({ model: 'x', prompt: 'p', cwd: '/repo', mode: 'read' })
  assert.ok(!withoutSession.includes('--conversation'))
})

test('parseResult reads the legacy single-line --output-format json envelope (old fixtures still work)', () => {
  const result = parseResult(read('success.txt'))
  assert.equal(result.ok, true)
  assert.equal(result.text, 'PONG\n')
  assert.equal(result.tokens, 13767)
  assert.equal(result.sessionId, 'afc76d48-0093-4e96-903d-840b0d12cb14')
})

test('parseResult reads a real NDJSON stream-json success fixture: the final result event wins', () => {
  const result = parseResult(read('stream-success.jsonl'))
  assert.equal(result.ok, true)
  assert.equal(result.text, 'PONG-42\n')
  assert.equal(result.tokens, 28584)
  assert.equal(result.sessionId, '9b4f88b8-d01b-4598-bd6f-045230544fa1')
})

test('classifyError returns null (no error) for a legacy success envelope', () => {
  assert.equal(classifyError(read('success.txt')), null)
})

test('classifyError returns null (no error) for a stream-json success envelope with a non-empty response', () => {
  assert.equal(classifyError(read('stream-success.jsonl')), null)
})

test('classifyError detects CANCELED as a retriable canceled error (silent permission denial)', () => {
  const result = parseResult(read('canceled.txt'))
  assert.equal(result.ok, false)
  const error = classifyError(read('canceled.txt'))
  assert.equal(error.kind, 'canceled')
  assert.equal(error.retriable, true)
})

test('classifyError detects a missing JSON envelope with 429/RESOURCE_EXHAUSTED text as quota', () => {
  const error = classifyError(read('quota.txt'))
  assert.equal(error.kind, 'quota')
  assert.equal(error.retriable, true)
})

test('classifyError reports timeout when the process wrapper says timedOut, regardless of stdout', () => {
  const error = classifyError(read('success.txt'), { timedOut: true })
  assert.equal(error.kind, 'timeout')
  assert.equal(error.retriable, true)
})

test('classifyError detects the real agy print-timeout marker as a retriable timeout, even when exitInfo.timedOut is false (agy exits 0 on its own print-timeout)', () => {
  const stdout = read('stream-timeout.jsonl')
  const error = classifyError(stdout, { timedOut: false })
  assert.equal(error.kind, 'timeout')
  assert.equal(error.retriable, true)
})

test('classifyError attaches sessionId and partialText to a print-timeout error, so job_reply can resume the abandoned turn', () => {
  const stdout = read('stream-timeout.jsonl')
  const error = classifyError(stdout)
  assert.equal(error.sessionId, '327bd6fd-123c-4ba9-9b6d-068f74976538')
  assert.equal(error.partialText, '')
})

test('classifyError attaches accumulated text_delta as partialText on a print-timeout error that DID stream some text first', () => {
  const stdout = read('stream-success.jsonl')
  // Force the timeout branch on an otherwise-successful stream to check the
  // accumulator alone (real timeouts truncate before the result event lands).
  const error = classifyError(stdout, { timedOut: true })
  assert.equal(error.partialText, 'PONG-42\n')
  assert.equal(error.sessionId, '9b4f88b8-d01b-4598-bd6f-045230544fa1')
})

test('classifyError treats a stream-json SUCCESS with empty response and no text_delta as retriable "empty" (turn produced nothing)', () => {
  const stdout = read('stream-empty.jsonl')
  const result = parseResult(stdout)
  assert.equal(result.ok, true, 'parseResult itself does not classify; SUCCESS is SUCCESS')
  const error = classifyError(stdout)
  assert.equal(error.kind, 'empty')
  assert.equal(error.retriable, true)
})

test('listModels parses the real `agy models` fixture into id/label pairs', () => {
  const models = listModels(read('models.txt'))
  assert.ok(models.length >= 10, `expected at least 10 models, got ${models.length}`)
  const byId = Object.fromEntries(models.map((m) => [m.id, m.label]))
  assert.equal(byId['gemini-3.8-flash-low'], 'Gemini 3.8 Flash (Low)')
  assert.equal(byId['claude-opus-4-6-thinking'], 'Claude Opus 4.6 (Thinking)')
  assert.ok(!byId['Fetching'], 'the "Fetching available models..." banner line must not become a model')
})
