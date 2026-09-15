import fs from 'node:fs'
import { startJob as defaultStartJob, cancelJob } from '../jobrunner.mjs'
import { readResult, responsePath } from '../jobstore.mjs'
import { WRITE_ALLOWLIST } from '../config.mjs'

function jobStatusView(result) {
  return {
    jobId: result.jobId,
    agent: result.agent,
    model: result.model,
    title: result.title,
    cwd: result.cwd,
    mode: result.mode,
    status: result.status,
    errorKind: result.errorKind ?? null,
    error: result.error ?? null,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
  }
}

export function delegateTool({ agent, model, task, cwd, mode = 'read', timeoutS, title, variant }) {
  const { job } = defaultStartJob({ agent, model, task, cwd, mode, title, timeoutS, variant, allowlist: WRITE_ALLOWLIST })
  return { jobId: job.jobId, status: job.status, errorKind: job.errorKind ?? null }
}

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled'])

// job_reply supports resuming a conversation for these agents only: agy has
// --conversation, opencode has -s/--session. copilot has neither.
const REPLYABLE_AGENTS = new Set(['agy', 'opencode'])

/**
 * job_reply: start a new turn in a terminal job's conversation, using its
 * recorded sessionId. Mirrors delegate()'s shape but resumes instead of
 * starting fresh — the guided agy workflow is plan (read) -> feedback
 * (read, same session) -> "execute the approved plan" (write, same session).
 */
export async function jobReplyTool({ jobId, message, mode, timeoutS, title, startJobFn = defaultStartJob }) {
  const parent = readResult(jobId)

  if (!TERMINAL_STATUSES.has(parent.status)) {
    return { jobId: null, status: 'failed', parentJobId: jobId, errorKind: 'not_terminal' }
  }
  if (!parent.sessionId) {
    return { jobId: null, status: 'failed', parentJobId: jobId, errorKind: 'no_session' }
  }
  if (!REPLYABLE_AGENTS.has(parent.agent)) {
    return { jobId: null, status: 'failed', parentJobId: jobId, errorKind: 'unsupported' }
  }

  const effectiveMode = mode ?? parent.mode ?? 'read'
  const effectiveTitle = title ?? `${parent.title || parent.jobId} (reply)`

  const { job } = startJobFn({
    agent: parent.agent,
    model: parent.model,
    task: message,
    cwd: parent.cwd,
    mode: effectiveMode,
    title: effectiveTitle,
    timeoutS,
    variant: parent.variant ?? undefined,
    sessionId: parent.sessionId,
    parentJobId: jobId,
    allowlist: WRITE_ALLOWLIST,
  })
  return { jobId: job.jobId, status: job.status, parentJobId: jobId, errorKind: job.errorKind ?? null }
}

export async function jobWaitTool({ jobId, timeoutS = 30 }) {
  const boundedTimeoutS = Math.min(Math.max(timeoutS, 1), 60)
  const deadline = Date.now() + boundedTimeoutS * 1000
  let result = readResult(jobId)
  while (!TERMINAL_STATUSES.has(result.status) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300))
    result = readResult(jobId)
  }
  return jobStatusView(result)
}

export function jobStatusTool({ jobId }) {
  return jobStatusView(readResult(jobId))
}

export function jobResultTool({ jobId, maxLines = 20 }) {
  const result = readResult(jobId)
  let fullText = ''
  try {
    fullText = fs.readFileSync(responsePath(jobId), 'utf8')
  } catch {
    // no response yet (still running, or the job never produced text)
  }

  const lines = fullText.split('\n')
  const truncated = lines.length > maxLines
  return {
    text: lines.slice(0, maxLines).join('\n'),
    truncated,
    fullPath: responsePath(jobId),
    tokens: result.tokens ?? null,
    costUsd: result.costUsd ?? null,
    sessionId: result.sessionId ?? null,
    status: result.status,
    errorKind: result.errorKind ?? null,
  }
}

export async function jobCancelTool({ jobId }) {
  const result = await cancelJob(jobId)
  return jobStatusView(result)
}
