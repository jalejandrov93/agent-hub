import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildArgv, parseResult, classifyError, listModels } from '../../src/adapters/codex.mjs'
import { spawnDetached } from '../../src/process.mjs'

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'codex')
const read = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8')

const BYPASS_FLAG = '--dangerously-bypass-approvals-and-sandbox'

test('buildArgv builds a read-mode new-turn argv without -m for the CLI default model', () => {
  const argv = buildArgv({ model: 'default', prompt: 'Reply exactly: PONG', cwd: '/repo', mode: 'read' })
  assert.deepEqual(argv, ['exec', '--json', '--skip-git-repo-check', '-s', 'read-only', '-C', '/repo', 'Reply exactly: PONG'])
})

test('buildArgv builds a write-mode new-turn argv with the workspace-write sandbox', () => {
  const argv = buildArgv({ model: 'default', prompt: 'do it', cwd: '/repo', mode: 'write' })
  assert.equal(argv[argv.indexOf('-s') + 1], 'workspace-write')
  assert.ok(!argv.includes('read-only'))
})

test('buildArgv adds -m <model> only when model is set and not "default"', () => {
  const explicit = buildArgv({ model: 'gpt-5.3-codex', prompt: 'p', cwd: '/repo', mode: 'read' })
  assert.equal(explicit[explicit.indexOf('-m') + 1], 'gpt-5.3-codex')
  assert.equal(explicit[explicit.indexOf('-m') + 2], 'p')

  const cliDefault = buildArgv({ model: 'default', prompt: 'p', cwd: '/repo', mode: 'read' })
  assert.ok(!cliDefault.includes('-m'))

  const missing = buildArgv({ prompt: 'p', cwd: '/repo', mode: 'read' })
  assert.ok(!missing.includes('-m'))
})

test('buildArgv builds a resume argv with the sandbox via -c, never -s or -C', () => {
  const argv = buildArgv({ model: 'default', prompt: 'what did you reply?', cwd: '/repo', mode: 'read', sessionId: 'thread-1' })
  assert.deepEqual(argv, [
    'exec',
    'resume',
    '--json',
    '--skip-git-repo-check',
    '-c',
    'sandbox_mode="read-only"',
    'thread-1',
    'what did you reply?',
  ])
  // `codex exec resume` rejects -s/--sandbox and -C/--cd outright.
  assert.ok(!argv.includes('-s'))
  assert.ok(!argv.includes('-C'))
})

test('buildArgv resume uses sandbox_mode workspace-write in write mode', () => {
  const argv = buildArgv({ model: 'default', prompt: 'p', cwd: '/repo', mode: 'write', sessionId: 'thread-1' })
  assert.equal(argv[argv.indexOf('-c') + 1], 'sandbox_mode="workspace-write"')
})

test('buildArgv passes --ignore-user-config only when env.AGENT_HUB_CODEX_IGNORE_USER_CONFIG is "1"', () => {
  const ignored = buildArgv({ model: 'default', prompt: 'p', cwd: '/repo', mode: 'read', env: { AGENT_HUB_CODEX_IGNORE_USER_CONFIG: '1' } })
  assert.ok(ignored.includes('--ignore-user-config'))

  const respected = buildArgv({ model: 'default', prompt: 'p', cwd: '/repo', mode: 'read', env: {} })
  assert.ok(!respected.includes('--ignore-user-config'))

  const noEnv = buildArgv({ model: 'default', prompt: 'p', cwd: '/repo', mode: 'read' })
  assert.ok(!noEnv.includes('--ignore-user-config'))
})

test('buildArgv never passes the sandbox-bypass flag, in any mode or turn', () => {
  const variants = [
    { model: 'default', prompt: 'p', cwd: '/repo', mode: 'read' },
    { model: 'default', prompt: 'p', cwd: '/repo', mode: 'write' },
    { model: 'default', prompt: 'p', cwd: '/repo', mode: 'read', sessionId: 'thread-1' },
    { model: 'default', prompt: 'p', cwd: '/repo', mode: 'write', sessionId: 'thread-1' },
  ]
  for (const v of variants) assert.ok(!buildArgv(v).includes(BYPASS_FLAG), JSON.stringify(v))
})

test('parseResult reads the real exec-pong fixture: text, sessionId and token usage', () => {
  const result = parseResult(read('exec-pong.jsonl'))
  assert.equal(result.ok, true)
  assert.equal(result.text, 'PONG')
  assert.equal(result.sessionId, '01a0aa3e-0b87-7372-b2e5-a6345b469447')
  assert.deepEqual(result.tokens, { input: 18803, cachedInput: 11008, output: 6, reasoning: 0 })
})

test('parseResult reads the real exec-resume fixture and keeps the same thread_id', () => {
  const result = parseResult(read('exec-resume.jsonl'))
  assert.equal(result.ok, true)
  assert.equal(result.text, 'PONG')
  assert.equal(result.sessionId, '01a0aa3e-0b87-7372-b2e5-a6345b469447')
  assert.deepEqual(result.tokens, { input: 40831, cachedInput: 22016, output: 12, reasoning: 0 })
})

test('parseResult joins several agent_message items in order', () => {
  const stdout = [
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PO"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"NG"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":2,"reasoning_output_tokens":0}}',
  ].join('\n')
  const result = parseResult(stdout)
  assert.equal(result.ok, true)
  assert.equal(result.text, 'PONG')
})

test('parseResult tolerates non-JSON noise lines and unknown event types without throwing', () => {
  const stdout = [
    'Reading additional input from stdin...',
    '{"type":"thread.started","thread_id":"t1"}',
    '{"type":"future.unknown.event","whatever":true}',
    'not json at all',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"PONG"}}',
    '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}',
  ].join('\n')
  const result = parseResult(stdout)
  assert.equal(result.ok, true)
  assert.equal(result.text, 'PONG')
})

test('parseResult is not ok when the turn failed', () => {
  const result = parseResult(read('exec-bad-model.jsonl'))
  assert.equal(result.ok, false)
})

test('parseResult is not ok when no agent_message was produced', () => {
  const result = parseResult('{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.started"}\n')
  assert.equal(result.ok, false)
  assert.equal(result.sessionId, 't1')
})

test('classifyError returns null for the real success stream', () => {
  assert.equal(classifyError(read('exec-pong.jsonl')), null)
})

test('classifyError reads the real exec-bad-model fixture as model_unavailable, not retriable', () => {
  const error = classifyError(read('exec-bad-model.jsonl'))
  assert.equal(error.kind, 'model_unavailable')
  assert.equal(error.retriable, false)
})

test('classifyError maps a synthetic 429 turn.failed to quota and retriable', () => {
  const stdout = '{"type":"turn.failed","error":{"message":"{\\"status\\":429,\\"error\\":{\\"message\\":\\"Too many requests\\"}}"}}'
  const error = classifyError(stdout)
  assert.equal(error.kind, 'quota')
  assert.equal(error.retriable, true)
})

test('classifyError maps a rate-limit message without a status to quota', () => {
  const stdout = '{"type":"turn.failed","error":{"message":"{\\"error\\":{\\"message\\":\\"You have hit your usage limit\\"}}"}}'
  const error = classifyError(stdout)
  assert.equal(error.kind, 'quota')
})

test('classifyError maps a synthetic 401 turn.failed to auth and not retriable', () => {
  const stdout = '{"type":"turn.failed","error":{"message":"{\\"status\\":401,\\"error\\":{\\"message\\":\\"not logged in\\"}}"}}'
  const error = classifyError(stdout)
  assert.equal(error.kind, 'auth')
  assert.equal(error.retriable, false)
})

test('classifyError reports timeout when the process wrapper says timedOut', () => {
  const error = classifyError(read('exec-pong.jsonl'), { timedOut: true })
  assert.equal(error.kind, 'timeout')
  assert.equal(error.retriable, true)
})

test('classifyError reports empty when the stream has no agent_message and no turn.failed', () => {
  const error = classifyError('{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.started"}\n')
  assert.equal(error.kind, 'empty')
  assert.equal(error.retriable, true)
})

test('classifyError ignores an item.completed error warning that is not fatal', () => {
  const stdout = [
    '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `x` not found. Defaulting to fallback metadata."}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"PONG"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"cached_input_tokens":0,"cache_write_input_tokens":0,"output_tokens":1,"reasoning_output_tokens":0}}',
  ].join('\n')
  assert.equal(classifyError(stdout), null)
})

test('spawnDetached pins stdin to "ignore" so codex exec never blocks waiting on it', () => {
  // Node exposes an 'ignore'd stdio slot as null: no writable stdin stream
  // exists, so the child sees an immediate EOF instead of the parent's stdin.
  // A 'pipe' (the default hazard) would make child.stdin a stream and fail here.
  const child = spawnDetached(process.execPath, ['-e', 'setTimeout(() => {}, 200)'])
  try {
    assert.equal(child.stdin, null)
    assert.equal(child.stdio[0], null)
  } finally {
    child.kill()
  }
})

test('listModels returns the single CLI default, since codex has no model-list command', () => {
  assert.deepEqual(listModels('codex-cli 0.154.0'), [{ id: 'default', label: 'Codex CLI default model' }])
})
