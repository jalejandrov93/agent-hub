// Live tests: real CLI calls, real quota usage, real latency. Gated behind
// AGENT_HUB_LIVE=1 — never run as part of `npm test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { runCommand } from '../../src/process.mjs'
import * as agy from '../../src/adapters/agy.mjs'
import * as opencode from '../../src/adapters/opencode.mjs'
import * as copilot from '../../src/adapters/copilot.mjs'

const LIVE = process.env.AGENT_HUB_LIVE === '1'
const CWD = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..')

async function ping(adapter, model, mode = 'read') {
  const argv = adapter.buildArgv({ model, prompt: 'Reply exactly: PONG', cwd: CWD, mode })
  const result = await runCommand(adapter.cmd, argv, { cwd: CWD, timeoutMs: 90_000 })
  return { result, parsed: adapter.parseResult(result.stdout ?? ''), error: adapter.classifyError(result.stdout ?? '', { timedOut: result.timedOut }) }
}

test('agy: a real PONG round-trip with gemini-3.8-flash-low', { skip: !LIVE }, async () => {
  const { parsed, error } = await ping(agy, 'gemini-3.8-flash-low')
  assert.equal(error, null, error && JSON.stringify(error))
  assert.equal(parsed.ok, true)
  assert.match(parsed.text.trim(), /PONG/)
})

test('opencode: a real PONG round-trip with opencode/muse-spark-1.3-contributor-free', { skip: !LIVE }, async () => {
  const argv = opencode.buildArgv({ model: 'opencode/muse-spark-1.3-contributor-free', prompt: 'Reply exactly: PONG', cwd: CWD, title: 'live-pong' })
  const result = await runCommand('opencode', argv, { cwd: CWD, timeoutMs: 90_000 })
  const parsed = opencode.parseResult(result.stdout ?? '')
  const error = opencode.classifyError(result.stdout ?? '', { timedOut: result.timedOut })
  assert.equal(error, null, error && JSON.stringify(error))
  assert.equal(parsed.ok, true)
  assert.match(parsed.text.trim(), /PONG/)
})

// gpt-5-mini (named in the plan) was rejected live by --model's client-side
// allowlist ("is not available") on every attempt during recording; only
// --model auto worked. Ping auto here — see test/fixtures/README.md.
test('copilot: a real PONG round-trip with --model auto', { skip: !LIVE }, async () => {
  const { parsed, error } = await ping(copilot, 'auto')
  assert.equal(error, null, error && JSON.stringify(error))
  assert.equal(parsed.ok, true)
  assert.match(parsed.text.trim(), /PONG/)
})
