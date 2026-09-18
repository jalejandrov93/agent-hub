import fs from 'node:fs'
import { startJob as defaultStartJob, cancelJob } from '../jobrunner.mjs'
import { readResult, responsePath } from '../jobstore.mjs'
import { WRITE_ALLOWLIST, TURN_DEPTH_WARNING } from '../config.mjs'
import { TASK_TYPES } from '../schemas.mjs'
import { keyForJob, NO_KEY_MESSAGE } from '../cloud/credentials.mjs'
import { computeAttention } from '../cloud/check.mjs'
import { isWaitingRemoteState } from '../cloud/poller.mjs'
import * as defaultJulesClient from '../cloud/jules/client.mjs'
import * as defaultJulesAdapter from '../cloud/jules/adapter.mjs'

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
// --conversation, opencode has -s/--session, codex has `exec resume <thread_id>`,
// jules has sendMessage/approvePlan against its remote session. copilot has none
// of these.
const REPLYABLE_AGENTS = new Set(['agy', 'opencode', 'codex', 'jules'])

/**
 * job_reply for a jules parent: unlike agy/opencode, this never spawns a new
 * local job — it talks directly to the existing remote session via
 * client.sendMessage/approvePlan, using the SAME jobId (the poller already
 * started by startRemoteJob keeps tracking that one job/session).
 */
async function julesReply({ jobId, parent, message, action, client, env, turnDepth, warning }) {
  const sessionId = parent.remote?.sessionId
  if (!sessionId) {
    return { jobId: null, status: 'failed', parentJobId: jobId, errorKind: 'no_session', turnDepth, warning }
  }

  // No action given: approve the plan only when the session is actually
  // waiting on one and the caller did not also send free text (a message
  // always means "say this", regardless of the session's current state).
  const resolvedAction = action ?? (parent.remote?.state === 'AWAITING_PLAN_APPROVAL' && !message ? 'approve_plan' : 'message')

  if (resolvedAction === 'message' && (!message || String(message).trim().length === 0)) {
    return {
      jobId: null,
      status: 'failed',
      parentJobId: jobId,
      errorKind: 'invalid',
      error: 'job_reply on a jules job needs either message text or action:"approve_plan"',
      turnDepth,
      warning,
    }
  }

  // The session belongs to the account that STARTED the job, so reply with
  // that account's key (credentials.mjs), not whatever env holds. Sending
  // unkeyed produced a real 401 on /sessions/<id>:sendMessage once keys moved
  // into accounts.json and JULES_API_KEY was gone.
  const apiKey = keyForJob(parent, { env })
  if (!apiKey) {
    return { jobId: null, status: 'failed', parentJobId: jobId, errorKind: 'auth', error: NO_KEY_MESSAGE, turnDepth, warning }
  }

  try {
    if (resolvedAction === 'approve_plan') {
      await client.approvePlan({ apiKey, sessionId })
    } else {
      await client.sendMessage({ apiKey, sessionId, prompt: message })
    }
  } catch (error) {
    // Mirrors the createSession error mapping in src/cloud/runner.mjs: 429 is
    // quota exhaustion, 401/403 is a rejected/missing key, anything else is an
    // unclassified remote failure. The message is carried through so a caller
    // can tell a rejected key apart from a genuine bug instead of seeing an
    // opaque 'crash' for all three.
    const status = error?.status
    const errorKind = status === 429 ? 'quota' : status === 401 || status === 403 ? 'auth' : 'crash'
    return { jobId: null, status: 'failed', parentJobId: jobId, errorKind, error: String(error?.message ?? error), turnDepth, warning }
  }

  // The reply lands on the SAME job/session — there is no new jobId to hand
  // back, so callers keep polling job_status/job_wait on the original one.
  return { jobId, status: parent.status, parentJobId: jobId, errorKind: null, turnDepth, warning }
}

/**
 * job_reply: start a new turn in a terminal job's conversation, using its
 * recorded sessionId. Mirrors delegate()'s shape but resumes instead of
 * starting fresh — the guided agy workflow is plan (read) -> feedback
 * (read, same session) -> "execute the approved plan" (write, same session).
 *
 * For a jules parent this instead relays `message`/`action` to the existing
 * remote session (see julesReply above) rather than spawning a new job.
 */
export async function jobReplyTool({
  jobId,
  message,
  mode,
  timeoutS,
  title,
  taskType,
  action,
  startJobFn = defaultStartJob,
  client = defaultJulesClient,
  env = process.env,
}) {
  assertTaskType(taskType)
  const parent = readResult(jobId)

  // Each reply deepens the conversation by one turn; a resumed conversation
  // carries the parent's depth forward (root = 0).
  const turnDepth = (parent.turnDepth ?? 0) + 1
  const warning =
    turnDepth >= TURN_DEPTH_WARNING
      ? `conversation is ${turnDepth} turns deep; consider a fresh delegate with a short summary`
      : null

  const isJules = parent.agent === 'jules'
  // A running Jules session is exactly when a reply is useful — it is a live
  // remote conversation, not a finished local process — so 'running' is
  // accepted in addition to a terminal status. Every other agent still
  // requires the parent to have finished first.
  const parentReady = isJules ? parent.status === 'running' || TERMINAL_STATUSES.has(parent.status) : TERMINAL_STATUSES.has(parent.status)
  if (!parentReady) {
    return { jobId: null, status: 'failed', parentJobId: jobId, errorKind: 'not_terminal', turnDepth, warning }
  }

  if (isJules) {
    return julesReply({ jobId, parent, message, action, client, env, turnDepth, warning })
  }

  // Only a jules approve_plan may omit message text. For every other agent the
  // reply IS the message: without this check a schema-legal job_reply({jobId})
  // would reach startJobFn with task: undefined and spawn the CLI with the
  // literal prompt "undefined".
  if (!message || String(message).trim().length === 0) {
    return {
      jobId: null,
      status: 'failed',
      parentJobId: jobId,
      errorKind: 'invalid',
      error: 'job_reply requires message text',
      turnDepth,
      warning,
    }
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
  while (true) {
    if (TERMINAL_STATUSES.has(result.status)) {
      return { ...jobStatusView(result), done: true, waiting: false, timedOut: false }
    }
    // P0.1: a remote session waiting for interaction (AWAITING_*/PAUSED) is
    // a result, not a reason to block until timeout. Return immediately with
    // the waiting signal + attention fields so the caller (supervisor/human)
    // can act via jules_interact instead of burning its own timeout. This
    // uses the same isWaitingRemoteState definition as the poller — no drift.
    if (result.status === 'running' && isWaitingRemoteState(defaultJulesAdapter, result.remote?.state)) {
      const attention = computeAttention({ state: result.remote.state, record: result })
      return { ...jobStatusView(result), done: true, waiting: true, timedOut: false, ...attention }
    }
    if (Date.now() >= deadline) {
      return { ...jobStatusView(result), done: false, waiting: false, timedOut: true }
    }
    await new Promise((r) => setTimeout(r, 300))
    result = readResult(jobId)
  }
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
