import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const MAX_LINE_BYTES = 4096
const MAX_SUMMARY_CHARS = 1500

/**
 * Builds a single JSON-serialisable HubEvent object for an OpenCode subagent lifecycle phase.
 * Returns null if the session has no parent (i.e. it is a root session, not a subagent).
 */
export function buildSubagentEvent({
  phase,
  session,
  parent = null,
  now = () => new Date().toISOString(),
  env = process.env,
} = {}) {
  if (!session || typeof session !== 'object') return null

  const parentId = (typeof parent === 'string' ? parent : (parent?.id || parent?.sessionID)) ||
    session.parentID ||
    session.parentId ||
    null

  if (!parentId) return null

  let kind = null
  if (phase === 'start' || phase === 'subagent.start') {
    kind = 'subagent.start'
  } else if (phase === 'stop' || phase === 'subagent.stop') {
    kind = 'subagent.stop'
  } else {
    return null
  }

  const ts = typeof now === 'function' ? now() : (now || new Date().toISOString())
  const title = session.title || session.agent || 'subagent'
  const sessionId = session.id || session.sessionID || null

  return {
    ts,
    source: 'opencode',
    kind,
    agent: session.agent || 'opencode',
    model: session.model || null,
    title,
    summary: session.summary
      ? (typeof session.summary === 'string' ? session.summary : JSON.stringify(session.summary))
      : null,
    jobId: session.jobId || null,
    cwd: session.directory || session.cwd || null,
    errorKind: session.errorKind || null,
    taskType: session.taskType || null,
    tokens: typeof session.tokens === 'number' ? session.tokens : null,
    costUsd: typeof session.costUsd === 'number' ? session.costUsd : null,
    harness: 'opencode',
    waitMode: session.waitMode || null,
    sessionId,
    sessionID: sessionId,
    agentId: session.agentId || sessionId,
    parentSessionId: parentId,
    parentId,
  }
}

/**
 * Appends a JSON event line atomically to AGENT_HUB_HOME/events.jsonl (or the specified file).
 * Returns null without writing if event is null/undefined.
 */
export function appendEventLine({ file, event, env = process.env } = {}) {
  if (!event || typeof event !== 'object') return null

  const targetFile = file || path.join(
    env?.AGENT_HUB_HOME || path.join(os.homedir(), '.local', 'share', 'agent-hub'),
    'events.jsonl'
  )

  fs.mkdirSync(path.dirname(targetFile), { recursive: true })

  const normalized = { ...event }

  if (typeof normalized.summary === 'string' && normalized.summary.length > MAX_SUMMARY_CHARS) {
    normalized.summary = normalized.summary.slice(0, MAX_SUMMARY_CHARS) + '…[truncated]'
  }

  let line = JSON.stringify(normalized)
  if (Buffer.byteLength(line, 'utf8') + 1 > MAX_LINE_BYTES) {
    const { summary, ...rest } = normalized
    line = JSON.stringify({ ...rest, summary: '[dropped: line too large]' })
  }

  fs.appendFileSync(targetFile, line + '\n', { encoding: 'utf8' })
  return normalized
}
