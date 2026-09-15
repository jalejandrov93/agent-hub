import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'
import { handleHookPayload, runHook } from '../src/hook.mjs'

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-hook-'))
}

const noSleep = () => Promise.resolve()

/**
 * Build the real Claude Code project-dir layout:
 *   <projectDir>/<sessionId>.jsonl                         (main transcript, not used here)
 *   <projectDir>/<sessionId>/subagents/agent-<id>.jsonl     (agent transcript)
 *   <projectDir>/<sessionId>/subagents/agent-<id>.meta.json
 */
function makeSubagentFixture({ projectDir, sessionId, agentId, meta, usageLines }) {
  const subDir = path.join(projectDir, sessionId, 'subagents')
  fs.mkdirSync(subDir, { recursive: true })
  const transcriptPath = path.join(subDir, `agent-${agentId}.jsonl`)
  const metaPath = path.join(subDir, `agent-${agentId}.meta.json`)
  fs.writeFileSync(metaPath, JSON.stringify(meta))
  fs.writeFileSync(transcriptPath, usageLines.map((l) => JSON.stringify(l)).join('\n') + '\n')
  return { transcriptPath, metaPath }
}

test('SubagentStart appends a subagent.start event', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  await handleHookPayload(
    { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1', agent_type: 'Explore', cwd: '/repo', transcript_path: '/repo/.claude/s1.jsonl' },
    { env, sleep: noSleep }
  )

  const { readTail } = await import('../src/eventlog.mjs?t=' + Date.now())
  const events = readTail({ n: 10, env })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'subagent.start')
  assert.equal(events[0].source, 'claude-hook')
  assert.equal(events[0].agentId, 'a1')
})

test('SubagentStop reads model/description from the sibling meta.json next to agent_transcript_path and sums usage', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-hook-project-'))

  const { transcriptPath } = makeSubagentFixture({
    projectDir,
    sessionId: 's1',
    agentId: 'a1',
    meta: { agentType: 'Explore', description: 'Explore the widget', toolUseId: 't1', spawnDepth: 1, model: 'sonnet' },
    usageLines: [
      { message: { model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 20 } } },
      { message: { model: 'claude-sonnet-5', usage: { input_tokens: 50, output_tokens: 10 } } },
    ],
  })

  await handleHookPayload(
    {
      hook_event_name: 'SubagentStop',
      session_id: 's1',
      agent_id: 'a1',
      cwd: '/repo',
      transcript_path: path.join(projectDir, 's1.jsonl'),
      agent_transcript_path: transcriptPath,
      last_assistant_message: 'done',
    },
    { env, sleep: noSleep }
  )

  const { readTail } = await import('../src/eventlog.mjs?t=' + Date.now())
  const events = readTail({ n: 10, env })
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'subagent.stop')
  assert.equal(events[0].model, 'sonnet')
  assert.equal(events[0].title, 'Explore')
  assert.equal(events[0].tokens, 180)
})

test('SubagentStop falls back to the derived dirname(transcript_path)/session/subagents path when agent_transcript_path is missing', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-hook-project-'))

  makeSubagentFixture({
    projectDir,
    sessionId: 's1',
    agentId: 'a1',
    meta: { agentType: 'Explore', description: 'x', toolUseId: 't1', spawnDepth: 1, model: 'haiku' },
    usageLines: [{ message: { model: 'claude-haiku-4-5', usage: { input_tokens: 5, output_tokens: 5 } } }],
  })

  await handleHookPayload(
    {
      hook_event_name: 'SubagentStop',
      session_id: 's1',
      agent_id: 'a1',
      cwd: '/repo',
      transcript_path: path.join(projectDir, 's1.jsonl'),
      // no agent_transcript_path this time
    },
    { env, sleep: noSleep }
  )

  const { readTail } = await import('../src/eventlog.mjs?t=' + Date.now())
  const events = readTail({ n: 10, env })
  assert.equal(events[0].model, 'haiku')
})

test('SubagentStop retries up to 3 times at 200ms when the meta.json is not there yet', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-hook-project-'))
  const subDir = path.join(projectDir, 's1', 'subagents')
  fs.mkdirSync(subDir, { recursive: true })
  const transcriptPath = path.join(subDir, 'agent-a1.jsonl')
  fs.writeFileSync(transcriptPath, JSON.stringify({ message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1 } } }) + '\n')
  const metaPath = path.join(subDir, 'agent-a1.meta.json')

  let sleepCalls = 0
  const delayedSleep = async () => {
    sleepCalls++
    if (sleepCalls === 1) {
      // write the meta file only after the first retry delay, simulating a slow flush
      fs.writeFileSync(metaPath, JSON.stringify({ agentType: 'Plan', description: 'planning', toolUseId: 't', spawnDepth: 1, model: 'opus' }))
    }
  }

  await handleHookPayload(
    { hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a1', cwd: '/repo', transcript_path: path.join(projectDir, 's1.jsonl'), agent_transcript_path: transcriptPath },
    { env, sleep: delayedSleep }
  )

  const { readTail } = await import('../src/eventlog.mjs?t=' + Date.now())
  const events = readTail({ n: 10, env })
  assert.equal(events[0].model, 'opus')
  assert.ok(sleepCalls >= 1)
})

test('SubagentStart with no agent_type produces no event (harness-internal noise, ~319 of ~390 real events had this shape)', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  await handleHookPayload(
    { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1', cwd: '/repo', transcript_path: '/repo/.claude/s1.jsonl' },
    { env, sleep: noSleep }
  )

  const { readTail } = await import('../src/eventlog.mjs?t=' + Date.now())
  assert.equal(readTail({ n: 10, env }).length, 0)
})

test('SubagentStart with an empty-string agent_type also produces no event', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  await handleHookPayload(
    { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a1', agent_type: '', cwd: '/repo', transcript_path: '/repo/.claude/s1.jsonl' },
    { env, sleep: noSleep }
  )

  const { readTail } = await import('../src/eventlog.mjs?t=' + Date.now())
  assert.equal(readTail({ n: 10, env }).length, 0)
})

test('SubagentStop with no agent_type and no meta.json (so no agentType either) produces no event', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hub-hook-project-'))

  await handleHookPayload(
    { hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a1', cwd: '/repo', transcript_path: path.join(projectDir, 's1.jsonl') },
    { env, sleep: noSleep }
  )

  const { readTail } = await import('../src/eventlog.mjs?t=' + Date.now())
  assert.equal(readTail({ n: 10, env }).length, 0)
})

test('a malformed stdin payload never throws and produces no event', async () => {
  const home = tmpHome()
  const env = { AGENT_HUB_HOME: home }
  await assert.doesNotReject(() => handleHookPayload(null, { env, sleep: noSleep }))
  await assert.doesNotReject(() => handleHookPayload({ hook_event_name: 'SomethingElse' }, { env, sleep: noSleep }))

  const { readTail } = await import('../src/eventlog.mjs?t=' + Date.now())
  assert.equal(readTail({ n: 10, env }).length, 0)
})

test('runHook always exits 0, even for garbage stdin', async () => {
  const home = tmpHome()
  const originalExit = process.exit
  const originalHome = process.env.AGENT_HUB_HOME
  process.env.AGENT_HUB_HOME = home
  let exitCode
  process.exit = (code) => {
    exitCode = code
  }

  try {
    await runHook(Readable.from(['not { valid json']))
  } finally {
    process.exit = originalExit
    process.env.AGENT_HUB_HOME = originalHome
  }

  assert.equal(exitCode, 0)
})

test('hook.mjs source never writes to stdout (only appendEvent + eventual process.exit)', async () => {
  const fsMod = await import('node:fs')
  const path = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const src = fsMod.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hook.mjs'),
    'utf8'
  )
  assert.ok(!/console\.log|process\.stdout\.write/.test(src), 'hook.mjs must never write to stdout — it would corrupt the hook contract')
})
