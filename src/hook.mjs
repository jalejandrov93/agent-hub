import fs from 'node:fs'
import path from 'node:path'
import { appendEvent } from './eventlog.mjs'

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Two candidate locations for the subagent's meta.json, tried in order:
 *  1. sibling of agent_transcript_path (same dir, .jsonl -> .meta.json) — the
 *     robust choice, since SubagentStop already hands us that exact file.
 *  2. derived from the *main* transcript_path: dirname(transcript_path)/
 *     <session_id>/subagents/agent-<agent_id>.meta.json — a fallback for a
 *     payload shape that omits agent_transcript_path.
 */
function metaCandidates(payload) {
  const candidates = []
  if (payload.agent_transcript_path) {
    candidates.push(payload.agent_transcript_path.replace(/\.jsonl$/, '.meta.json'))
  }
  if (payload.transcript_path && payload.session_id && payload.agent_id) {
    candidates.push(
      path.join(path.dirname(payload.transcript_path), payload.session_id, 'subagents', `agent-${payload.agent_id}.meta.json`)
    )
  }
  return candidates
}

async function readMetaWithRetry(payload, { retries = 3, delayMs = 200, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const candidates = metaCandidates(payload)
  for (let attempt = 0; attempt < retries; attempt++) {
    for (const candidate of candidates) {
      const meta = readJsonSafe(candidate)
      if (meta) return meta
    }
    if (attempt < retries - 1) await sleep(delayMs)
  }
  return null
}

/** Sum message.usage across the agent's own transcript and grab the last model seen. */
function sumUsage(transcriptPath) {
  let inputTokens = 0
  let outputTokens = 0
  let lastModel = null
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      let obj
      try {
        obj = JSON.parse(line)
      } catch {
        continue
      }
      const usage = obj?.message?.usage
      if (usage) {
        inputTokens += usage.input_tokens ?? 0
        outputTokens += usage.output_tokens ?? 0
      }
      if (obj?.message?.model) lastModel = obj.message.model
    }
  } catch {
    // transcript unreadable — report zero usage rather than failing the hook
  }
  return { inputTokens, outputTokens, model: lastModel }
}

/**
 * Enrich one hook payload and append the corresponding event. Never throws —
 * an unknown event, missing files, or bad JSON all degrade to "no-op" rather
 * than blocking Claude Code's own SubagentStart/Stop flow.
 */
export async function handleHookPayload(payload, { env = process.env, sleep } = {}) {
  if (!payload || typeof payload !== 'object') return
  const eventName = payload.hook_event_name

  if (eventName === 'SubagentStart') {
    // Most SubagentStart/Stop events are Claude Code harness-internal agents
    // with no agent_type (measured: 319 of ~390 events in the real log, one
    // every ~32s) — they push real hub jobs out of the dashboard's 200-event
    // timeline window. Never worth an event.
    if (!payload.agent_type) return
    appendEvent(
      {
        kind: 'subagent.start',
        source: 'claude-hook',
        agent: 'claude',
        agentId: payload.agent_id,
        sessionId: payload.session_id,
        cwd: payload.cwd,
        title: payload.agent_type,
      },
      { env }
    )
    return
  }

  if (eventName === 'SubagentStop') {
    let meta = null
    let usage = { inputTokens: 0, outputTokens: 0, model: null }
    try {
      meta = await readMetaWithRetry(payload, sleep ? { sleep } : {})
    } catch {
      // keep meta null — still emit the event
    }
    if (payload.agent_transcript_path) {
      try {
        usage = sumUsage(payload.agent_transcript_path)
      } catch {
        // keep zeroed usage
      }
    }

    // Same harness-internal-noise filter as SubagentStart, checked after the
    // meta.json lookup so a real agent whose type only lives in meta still counts.
    const title = meta?.agentType ?? payload.agent_type ?? ''
    if (!title) return

    appendEvent(
      {
        kind: 'subagent.stop',
        source: 'claude-hook',
        agent: 'claude',
        model: meta?.model ?? usage.model ?? null,
        agentId: payload.agent_id,
        sessionId: payload.session_id,
        cwd: payload.cwd,
        title,
        summary: meta?.description ?? payload.last_assistant_message ?? '',
        tokens: usage.inputTokens + usage.outputTokens,
      },
      { env }
    )
    return
  }

  // Unknown hook_event_name: intentionally a no-op.
}

/**
 * `agent-hub hook` entry point: read hook JSON from stdin, enrich, append
 * one event. ALWAYS exits 0 and never writes to stdout — a hook that fails
 * or prints noise breaks Claude Code's own flow, not just this server.
 */
export async function runHook(stdin = process.stdin) {
  try {
    let raw = ''
    for await (const chunk of stdin) raw += chunk
    const payload = JSON.parse(raw)
    await handleHookPayload(payload)
  } catch {
    // malformed stdin, unreadable files, whatever — never fail the hook
  }
  process.exit(0)
}
