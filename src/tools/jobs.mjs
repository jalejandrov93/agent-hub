import fs from 'node:fs'
import { startJob as defaultStartJob, cancelJob } from '../jobrunner.mjs'
import { readResult, responsePath } from '../jobstore.mjs'
import { WRITE_ALLOWLIST, TURN_DEPTH_WARNING } from '../config.mjs'
import { TASK_TYPES } from '../schemas.mjs'

/** Reject a caller-supplied taskType that is not one of schemas.mjs TASK_TYPES. */
function assertTaskType(taskType) {
  if (taskType != null && !TASK_TYPES.includes(taskType)) {
    throw new Error(`unknown taskType: ${taskType}`)
  }
}

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

export function delegateTool({ agent, model, task, cwd, mode = 'read', timeoutS, title, variant, taskType }) {
  assertTaskType(taskType)
  const { job } = defaultStartJob({ agent, model, task, cwd, mode, title, timeoutS, variant, taskType, turnDepth: 0, allowlist: WRITE_ALLOWLIST })
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
export async function jobReplyTool({ jobId, message, mode, timeoutS, title, taskType, startJobFn = defaultStartJob }) {
  assertTaskType(taskType)
  const parent = readResult(jobId)

  // Each reply deepens the conversation by one turn; a resumed conversation
  // carries the parent's depth forward (root = 0).
  const turnDepth = (parent.turnDepth ?? 0) + 1
  const warning =
    turnDepth >= TURN_DEPTH_WARNING
      ? `conversation is ${turnDepth} turns deep; consider a fresh delegate with a short summary`
      : null

  if (!TERMINAL_STATUSES.has(parent.status)) {
    return { jobId: null, status: 'failed', parentJobId: jobId, errorKind: 'not_terminal', turnDepth, warning }
  }
  if (!parent.sessionId) {
    return { jobId: null, status: 'failed', parentJobId: jobId, errorKind: 'no_session', turnDepth, warning }
  }
  if (!REPLYABLE_AGENTS.has(parent.agent)) {
    return { jobId: null, status: 'failed', parentJobId: jobId, errorKind: 'unsupported', turnDepth, warning }
  }

  // Inherit the parent's taskType unless the caller overrides it, so metrics
  // and adaptive timeouts keep grouping a conversation's turns together.
  const effectiveTaskType = taskType ?? parent.taskType ?? null
  assertTaskType(effectiveTaskType)
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
    taskType: effectiveTaskType,
    turnDepth,
    variant: parent.variant ?? undefined,
    sessionId: parent.sessionId,
    parentJobId: jobId,
    allowlist: WRITE_ALLOWLIST,
  })
  return { jobId: job.jobId, status: job.status, parentJobId: jobId, errorKind: job.errorKind ?? null, turnDepth, warning }
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

export function jobResultTool({ jobId, maxLines = 20, tailLines = 10 }) {
  const result = readResult(jobId)
  let fullText = ''
  try {
    fullText = fs.readFileSync(responsePath(jobId), 'utf8')
  } catch {
    // no response yet (still running, or the job never produced text)
  }

  const lines = fullText.split('\n')
  const totalLines = lines.length
  const truncated = totalLines > maxLines
  // The tail never repeats a line already in the head: it starts after the
  // head when the response is short enough for both to fit without a gap.
  const tailStart = Math.max(maxLines, totalLines - tailLines)
  const tail = lines.slice(tailStart).join('\n')
  const tailTruncated = totalLines > maxLines + tailLines

  return {
    text: lines.slice(0, maxLines).join('\n'),
    truncated,
    tail,
    totalLines,
    tailTruncated,
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
