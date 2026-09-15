import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-preflight-'))
}

async function fresh(home) {
  process.env.AGENT_HUB_HOME = home
  return import('../src/preflight.mjs?t=' + Date.now() + Math.random())
}

const AGY_MODELS = 'gemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n'

function fakeRunner(responses) {
  const calls = []
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    const key = `${cmd} ${args.join(' ')}`
    for (const [pattern, response] of responses) {
      if (typeof pattern === 'string' ? key.includes(pattern) : pattern.test(key)) {
        return response
      }
    }
    throw new Error(`fakeRunner: no response configured for "${key}"`)
  }
  runner.calls = calls
  return runner
}

test('the ladder short-circuits: an L0 version failure never calls L1/L2', async () => {
  const { runPreflight } = await fresh(tmpHome())
  const runner = fakeRunner([['--version', { stdout: '', stderr: 'not found', code: 127 }]])

  const entry = await runPreflight({ agent: 'agy', model: 'gemini-3.8-flash-low', cwd: '/tmp', commandRunner: runner, level: 'L2' })

  assert.equal(entry.status, 'unavailable')
  assert.equal(runner.calls.length, 1, 'only the L0 version check ran')
})

test('a full L2 preflight walks L0 -> L1 -> L2 and reports ready', async () => {
  const { runPreflight } = await fresh(tmpHome())
  const runner = fakeRunner([
    ['--version', { stdout: '1.2.1', stderr: '', code: 0 }],
    ['models', { stdout: AGY_MODELS, stderr: '', code: 0 }],
  ])

  const entry = await runPreflight({ agent: 'agy', model: 'gemini-3.8-flash-low', cwd: '/tmp', commandRunner: runner, level: 'L2' })

  assert.equal(entry.status, 'ready')
  assert.equal(entry.ladderLevel, 'L2')
  assert.equal(runner.calls.length, 2)
})

test('L1 fails when the model is not in the listed catalog', async () => {
  const { runPreflight } = await fresh(tmpHome())
  const runner = fakeRunner([
    ['--version', { stdout: '1.2.1', stderr: '', code: 0 }],
    ['models', { stdout: AGY_MODELS, stderr: '', code: 0 }],
  ])

  const entry = await runPreflight({ agent: 'agy', model: 'not-a-real-model', cwd: '/tmp', commandRunner: runner, level: 'L2' })

  assert.equal(entry.status, 'unavailable')
  assert.match(entry.reason, /not listed/i)
})

test('a fresh cache entry is reused without calling the command runner again', async () => {
  const home = tmpHome()
  const { runPreflight } = await fresh(home)
  const runner = fakeRunner([
    ['--version', { stdout: '1.2.1', stderr: '', code: 0 }],
    ['models', { stdout: AGY_MODELS, stderr: '', code: 0 }],
  ])

  await runPreflight({ agent: 'agy', model: 'gemini-3.8-flash-low', cwd: '/tmp', commandRunner: runner, level: 'L2' })
  const callsAfterFirst = runner.calls.length

  await runPreflight({ agent: 'agy', model: 'gemini-3.8-flash-low', cwd: '/tmp', commandRunner: runner, level: 'L2' })
  assert.equal(runner.calls.length, callsAfterFirst, 'second call served from cache, no new commandRunner calls')
})

test('force:true bypasses the cache and re-runs the ladder', async () => {
  const home = tmpHome()
  const { runPreflight } = await fresh(home)
  const runner = fakeRunner([
    ['--version', { stdout: '1.2.1', stderr: '', code: 0 }],
    ['models', { stdout: AGY_MODELS, stderr: '', code: 0 }],
  ])

  await runPreflight({ agent: 'agy', model: 'gemini-3.8-flash-low', cwd: '/tmp', commandRunner: runner, level: 'L2' })
  const callsAfterFirst = runner.calls.length
  await runPreflight({ agent: 'agy', model: 'gemini-3.8-flash-low', cwd: '/tmp', commandRunner: runner, level: 'L2', force: true })
  assert.ok(runner.calls.length > callsAfterFirst)
})

test('agentsStatus never runs an L3 ping (it stops at L2 for every configured pair)', async () => {
  const home = tmpHome()
  const { agentsStatus } = await fresh(home)
  const runner = fakeRunner([
    ['--version', { stdout: 'v', stderr: '', code: 0 }],
    [/models|help config/, { stdout: 'gemini-3.8-flash-low\tlabel\n', stderr: '', code: 0 }],
  ])

  await agentsStatus({ agents: [{ agent: 'agy', model: 'gemini-3.8-flash-low' }], cwd: '/tmp', commandRunner: runner })

  // Neither the -p/run/prompt invocation nor anything containing our ping text should ever be called.
  assert.ok(!runner.calls.some((c) => c.args.includes('Reply exactly: PONG')), 'agents_status must never ping')
})

test('an open circuit breaker (>=2 quota/canceled failures in 30 min) marks the pair degraded', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { appendEvent } = await import('../src/eventlog.mjs?t=' + Date.now())
  appendEvent({ kind: 'job.failed', agent: 'agy', model: 'gemini-3.8-flash-low', errorKind: 'quota', cwd: '/tmp', title: 'x' })
  appendEvent({ kind: 'job.failed', agent: 'agy', model: 'gemini-3.8-flash-low', errorKind: 'canceled', cwd: '/tmp', title: 'x' })

  const { runPreflight } = await fresh(home)
  const runner = fakeRunner([
    ['--version', { stdout: '1.2.1', stderr: '', code: 0 }],
    ['models', { stdout: AGY_MODELS, stderr: '', code: 0 }],
  ])

  const entry = await runPreflight({ agent: 'agy', model: 'gemini-3.8-flash-low', cwd: '/tmp', commandRunner: runner, level: 'L2' })
  assert.equal(entry.status, 'degraded')
  assert.match(entry.reason, /circuit_breaker_open|breaker/i)
})

test('a single billing failure opens the breaker immediately (no threshold wait, unlike quota/canceled)', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { appendEvent } = await import('../src/eventlog.mjs?t=' + Date.now())
  appendEvent({ kind: 'job.failed', agent: 'opencode', model: 'deepseek/deepseek-v4-pro', errorKind: 'billing', cwd: '/tmp', title: 'x' })

  const { runPreflight } = await fresh(home)
  const runner = fakeRunner([
    ['--version', { stdout: '1.18.30', stderr: '', code: 0 }],
    [/models|help config/, { stdout: 'deepseek/deepseek-v4-pro\n{\n"providerID":"deepseek",\n"id":"deepseek-v4-pro",\n"name":"n"\n}\n', stderr: '', code: 0 }],
  ])

  const entry = await runPreflight({ agent: 'opencode', model: 'deepseek/deepseek-v4-pro', cwd: '/tmp', commandRunner: runner, level: 'L2' })
  assert.equal(entry.status, 'degraded')
  assert.match(entry.reason, /circuit_breaker_open|breaker/i)
})

test('L1 raises the models-list timeout to 60s', async () => {
  const { runPreflight } = await fresh(tmpHome())
  const runner = fakeRunner([
    ['--version', { stdout: '1.2.1', stderr: '', code: 0 }],
    ['models', { stdout: AGY_MODELS, stderr: '', code: 0 }],
  ])

  await runPreflight({ agent: 'agy', model: 'gemini-3.8-flash-low', cwd: '/tmp', commandRunner: runner, level: 'L1' })
  const modelsCall = runner.calls.find((c) => c.args.includes('models'))
  assert.equal(modelsCall.opts.timeoutMs, 60_000)
})

test('L1 caches "degraded" (not "unavailable") when the models-list command itself times out', async () => {
  const { runPreflight } = await fresh(tmpHome())
  const runner = fakeRunner([
    ['--version', { stdout: '1.2.1', stderr: '', code: 0 }],
    ['models', { stdout: '', stderr: '', code: null, timedOut: true }],
  ])

  const entry = await runPreflight({ agent: 'agy', model: 'gemini-3.8-flash-low', cwd: '/tmp', commandRunner: runner, level: 'L1' })
  assert.equal(entry.status, 'degraded')
  assert.match(entry.reason, /model list timed out/i)
})

test('L1 caches "degraded" when the models-list command produces no stdout at all, even without timedOut set', async () => {
  const { runPreflight } = await fresh(tmpHome())
  const runner = fakeRunner([
    ['--version', { stdout: '1.2.1', stderr: '', code: 0 }],
    ['models', { stdout: '', stderr: '', code: 0 }],
  ])

  const entry = await runPreflight({ agent: 'agy', model: 'gemini-3.8-flash-low', cwd: '/tmp', commandRunner: runner, level: 'L1' })
  assert.equal(entry.status, 'degraded')
  assert.match(entry.reason, /model list timed out/i)
})

test('a single quota failure does not open the breaker', async () => {
  const home = tmpHome()
  process.env.AGENT_HUB_HOME = home
  const { appendEvent } = await import('../src/eventlog.mjs?t=' + Date.now())
  appendEvent({ kind: 'job.failed', agent: 'agy', model: 'gemini-3.8-flash-low', errorKind: 'quota', cwd: '/tmp', title: 'x' })

  const { runPreflight } = await fresh(home)
  const runner = fakeRunner([
    ['--version', { stdout: '1.2.1', stderr: '', code: 0 }],
    ['models', { stdout: AGY_MODELS, stderr: '', code: 0 }],
  ])

  const entry = await runPreflight({ agent: 'agy', model: 'gemini-3.8-flash-low', cwd: '/tmp', commandRunner: runner, level: 'L2' })
  assert.equal(entry.status, 'ready')
})

test('pingAgent (L3) runs the real argv and classifies a successful PONG as ready', async () => {
  const { pingAgent } = await fresh(tmpHome())
  const runner = fakeRunner([[/-p Reply exactly: PONG/, { stdout: '{"status":"SUCCESS","response":"PONG\\n","usage":{"total_tokens":10},"conversation_id":"c1"}', stderr: '', code: 0 }]])

  const entry = await pingAgent({ agent: 'agy', model: 'gemini-3.8-flash-low', cwd: '/tmp', commandRunner: runner })
  assert.equal(entry.status, 'ready')
  assert.equal(entry.ladderLevel, 'L3')
})

test('pingAgent (L3) marks unavailable when the CLI reports CANCELED', async () => {
  const { pingAgent } = await fresh(tmpHome())
  const runner = fakeRunner([[/-p Reply exactly: PONG/, { stdout: '{"status":"CANCELED","response":"","usage":{"total_tokens":0},"conversation_id":"c1"}', stderr: '', code: 0 }]])

  const entry = await pingAgent({ agent: 'agy', model: 'gemini-3.8-flash-low', cwd: '/tmp', commandRunner: runner })
  assert.equal(entry.status, 'unavailable')
})

const COPILOT_HELP_CONFIG = [
  '  `model`: AI model to use for Copilot CLI; can be changed with /model command or --model flag option.',
  '    - "gpt-5-mini"',
  '    - "claude-sonnet-4.6"',
  '',
  '  `contextTier`: context window tier for tiered-pricing models.',
].join('\n')

test('copilot: a catalog-listed non-auto model never reaches "ready" — L1 alone reports degraded (catalog only, unverified)', async () => {
  const { runPreflight } = await fresh(tmpHome())
  const runner = fakeRunner([
    ['--version', { stdout: 'GitHub Copilot CLI 1.0.83.', stderr: '', code: 0 }],
    ['help config', { stdout: COPILOT_HELP_CONFIG, stderr: '', code: 0 }],
  ])

  const entry = await runPreflight({ agent: 'copilot', model: 'gpt-5-mini', cwd: '/tmp', commandRunner: runner, level: 'L1' })
  assert.equal(entry.status, 'degraded')
  assert.match(entry.reason, /catalog only/i)
})

test('copilot: a catalog-listed non-auto model stays degraded at L2 too (never silently promoted to ready)', async () => {
  const { runPreflight } = await fresh(tmpHome())
  const runner = fakeRunner([
    ['--version', { stdout: 'GitHub Copilot CLI 1.0.83.', stderr: '', code: 0 }],
    ['help config', { stdout: COPILOT_HELP_CONFIG, stderr: '', code: 0 }],
  ])

  const entry = await runPreflight({ agent: 'copilot', model: 'gpt-5-mini', cwd: '/tmp', commandRunner: runner, level: 'L2' })
  assert.equal(entry.status, 'degraded')
  assert.match(entry.reason, /catalog only/i)
})

test('copilot: "auto" is always considered listed (no models-listing call) and reaches ready at L2', async () => {
  const { runPreflight } = await fresh(tmpHome())
  const runner = fakeRunner([['--version', { stdout: 'GitHub Copilot CLI 1.0.83.', stderr: '', code: 0 }]])

  const entry = await runPreflight({ agent: 'copilot', model: 'auto', cwd: '/tmp', commandRunner: runner, level: 'L2' })
  assert.equal(entry.status, 'ready')
  assert.equal(runner.calls.length, 1, 'only --version ran; no "help config" call for auto')
})

test('pingAgent (L3): a real model_unavailable rejection marks the pair unavailable with that reason', async () => {
  const { pingAgent } = await fresh(tmpHome())
  const runner = fakeRunner([
    [
      /-p Reply exactly: PONG/,
      {
        stdout: 'Error: Model "gpt-5-mini" from --model flag is not available.',
        stderr: '',
        code: 1,
      },
    ],
  ])

  const entry = await pingAgent({ agent: 'copilot', model: 'gpt-5-mini', cwd: '/tmp', commandRunner: runner })
  assert.equal(entry.status, 'unavailable')
  assert.match(entry.reason, /model_unavailable/)
})

test('pingAgent (L3): copilot writes the model-unavailable rejection to STDERR (measured live) — pingAgent must still catch it', async () => {
  const { pingAgent } = await fresh(tmpHome())
  const runner = fakeRunner([
    [
      /-p Reply exactly: PONG/,
      {
        // Matches the real, live-measured shape: JSONL status noise on
        // stdout, the actual rejection on stderr, exit code 1.
        stdout: '{"type":"session.mcp_server_status_changed","data":{"serverName":"github-mcp-server","status":"connected"},"ephemeral":true}',
        stderr: 'Error: Model "gpt-5-mini" from --model flag is not available.',
        code: 1,
      },
    ],
  ])

  const entry = await pingAgent({ agent: 'copilot', model: 'gpt-5-mini', cwd: '/tmp', commandRunner: runner })
  assert.equal(entry.status, 'unavailable')
  assert.match(entry.reason, /model_unavailable/)
})
