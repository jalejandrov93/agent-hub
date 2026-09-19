import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildArgv, stdinFor, parseResult, classifyError, listModels } from '../../src/adapters/opencode.mjs'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'opencode')
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8')

test('buildArgv builds a read-mode plan argv with no prompt positional and no --dir (v2: prompt rides stdin, --dir was removed)', () => {
  const argv = buildArgv({
    model: 'opencode/muse-spark-1.3-contributor-free',
    prompt: 'Reply exactly: PONG',
    cwd: '/repo',
    mode: 'read',
    title: 'fixture-pong',
  })
  assert.deepEqual(argv, [
    'run',
    '-m',
    'opencode/muse-spark-1.3-contributor-free',
    '--format',
    'json',
    '--agent',
    'plan',
    '--title',
    'fixture-pong',
  ])
})

test('buildArgv builds a write-mode argv with --agent build and --auto, and never leaks the prompt into argv', () => {
  const argv = buildArgv({ model: 'deepseek/deepseek-v4-flash', prompt: 'do it', cwd: '/repo', mode: 'write' })
  assert.ok(argv.includes('--auto'))
  assert.ok(argv.includes('build'))
  assert.ok(!argv.includes('plan'))
  assert.ok(!argv.includes('do it'), 'the prompt must never appear as an argv element (E3: argv quoting corrupts it)')
  assert.ok(!argv.includes('--dir'), '--dir was removed in v2 (E1)')
})

test('buildArgv defaults to read/plan when mode is omitted', () => {
  const argv = buildArgv({ model: 'x', prompt: 'p', cwd: '/repo' })
  assert.ok(argv.includes('plan'))
  assert.ok(!argv.includes('--auto'))
})

test('buildArgv folds variant into the model id as model#variant instead of a --variant flag (E2)', () => {
  const withVariant = buildArgv({ model: 'x', prompt: 'p', cwd: '/repo', variant: 'high' })
  assert.ok(!withVariant.includes('--variant'), '--variant was removed in v2')
  assert.equal(withVariant[withVariant.indexOf('-m') + 1], 'x#high')

  const withoutVariant = buildArgv({ model: 'x', prompt: 'p', cwd: '/repo' })
  assert.equal(withoutVariant[withoutVariant.indexOf('-m') + 1], 'x')
})

test('buildArgv does not double up the variant when the model id already carries one', () => {
  const argv = buildArgv({ model: 'x#already', prompt: 'p', cwd: '/repo', variant: 'high' })
  assert.equal(argv[argv.indexOf('-m') + 1], 'x#already')
})

test('buildArgv adds -s <sessionId> only when given (session resume)', () => {
  const withSession = buildArgv({ model: 'x', prompt: 'p', cwd: '/repo', sessionId: 'ses_abc' })
  assert.equal(withSession[withSession.indexOf('-s') + 1], 'ses_abc')
  const withoutSession = buildArgv({ model: 'x', prompt: 'p', cwd: '/repo' })
  assert.ok(!withoutSession.includes('-s'))
})

test('buildArgv never adds --standalone (E11: a standalone server has zero credentials/providers/models)', () => {
  const argv = buildArgv({ model: 'x', prompt: 'p', cwd: '/repo', mode: 'write' })
  assert.ok(!argv.includes('--standalone'))
})

test('stdinFor returns the prompt string, which is now piped to opencode run on stdin instead of argv (E3/E4)', () => {
  assert.equal(stdinFor({ prompt: 'Reply exactly: PONG' }), 'Reply exactly: PONG')
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

test('classifyError reports timeout when the process wrapper says timedOut (opencode handles SIGINT but not SIGTERM)', () => {
  const error = classifyError(read('success.jsonl'), { timedOut: true })
  assert.equal(error.kind, 'timeout')
})

test('classifyError detects a real DeepSeek 402/Insufficient Balance error event as "billing" (not "crash"), not retriable', () => {
  const error = classifyError(read('billing-402.jsonl'))
  assert.equal(error.kind, 'billing')
  assert.equal(error.retriable, false)
})

test('parseResult keeps only the last assistant message when a run emits several (E7: group by part.messageID, take the last group)', () => {
  const result = parseResult(read('v2-two-assistant-messages.jsonl'))
  assert.equal(result.ok, true)
  assert.equal(result.text, 'Ready to plan — what do you want to work on?')
  assert.notEqual(result.text, 'PONGReady to plan — what do you want to work on?', 'must not splice unrelated turns together')
})

test('parseResult sums step_finish.part.tokens components since v2 has no `total` field (E5)', () => {
  const result = parseResult(read('v2-two-assistant-messages.jsonl'))
  // input:19401 + output:12 + reasoning:14 + cache.read:0 + cache.write:0
  assert.equal(result.tokens, 19427)
  assert.equal(result.costUsd, 0)
  assert.equal(result.sessionId, 'ses_f442b8afeffeTPaFVPlSIhCR8b')
})

test('parseResult still computes the pre-v2 fixture total by summing components, matching its own recorded total (39465)', () => {
  const result = parseResult(read('success.jsonl'))
  assert.equal(result.tokens, 39465)
})

test('parseResult degrades tokens/cost to null but stays ok when step_finish is absent entirely (E6)', () => {
  const result = parseResult(read('v2-no-step-finish.jsonl'))
  assert.equal(result.ok, true)
  assert.equal(result.text, 'Repeat back the exact characters of my message, nothing else.')
  assert.equal(result.tokens, null)
  assert.equal(result.costUsd, null)
  assert.equal(result.sessionId, 'ses_f442abe80ffeDArU3srUc4szQR')
})

test('classifyError treats exit code 130 as a canceled interrupt, not a crash (E16: our own kill ladder sends SIGINT first)', () => {
  const error = classifyError(read('success.jsonl'), { code: 130 })
  assert.equal(error.kind, 'canceled')
  assert.equal(error.retriable, true)
})

test('classifyError still reports timeout when the process wrapper says timedOut, even if a code is also present', () => {
  const error = classifyError(read('success.jsonl'), { timedOut: true, code: 130 })
  assert.equal(error.kind, 'timeout')
})

test('classifyError timeout message reflects that opencode handles SIGINT but not SIGTERM (not "ignores SIGTERM")', () => {
  const error = classifyError(read('success.jsonl'), { timedOut: true })
  assert.match(error.message, /SIGTERM/)
  assert.doesNotMatch(error.message, /ignores SIGTERM/)
})

test('classifyError no longer special-cases a session.error event (v2 only emits "error", E18)', () => {
  const lines = [
    JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'partial', messageID: 'm1' } }),
    JSON.stringify({ type: 'session.error', error: { message: 'boom' } }),
  ].join('\n')
  const error = classifyError(lines)
  assert.equal(error, null, 'session.error is not a recognized v2 event type, so it is ignored and the text event still counts as success')
})

test('listModels parses the real `opencode models opencode --verbose` fixture', () => {
  const models = listModels(read('models-verbose.txt'))
  assert.equal(models.length, 7)
  const byId = Object.fromEntries(models.map((m) => [m.id, m]))
  assert.ok(byId['opencode/muse-spark-1.3-contributor-free'])
  assert.equal(byId['opencode/muse-spark-1.3-contributor-free'].cost.input, 0)
  assert.equal(byId['opencode/nemotron-3-ultra-free'].limit.context, 1000000)
})

test('parseResult tolerates a tokens object missing a component instead of reporting NaN', () => {
  // Not every model reports every component -- a model without reasoning
  // support can omit `reasoning` entirely. An unguarded sum would turn the
  // whole total into NaN and carry it into the job result.
  const stdout = [
    JSON.stringify({ type: 'text', sessionID: 'ses_x', part: { messageID: 'm1', text: 'hi' } }),
    JSON.stringify({ type: 'step_finish', sessionID: 'ses_x', part: { messageID: 'm1', cost: 0, tokens: { input: 10, output: 5 } } }),
  ].join('\n')

  const result = parseResult(stdout)
  assert.equal(result.tokens, 15)
})
