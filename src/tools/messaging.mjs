/**
 * Inter-agent messaging tools and handlers.
 *
 * ACK SEMANTICS:
 * An ACK means the message was deposited into the peer's context envelope.
 * It NEVER means the peer read, understood, agreed, or acted on it.
 */
import { getDb, insertAgentMessage, listAgentMessages, markAgentMessageDelivered, markAgentMessageAck, getAgentMessage } from '../storage/index.mjs'
import { listJobs } from '../jobstore.mjs'
import { capabilitiesFor } from '../capabilities.mjs'

const MAX_TEXT_LEN = 4000
const WILDCARDS = new Set(['*', 'all', 'broadcast'])
const VALID_KINDS = new Set(['notice', 'query', 'response'])

/**
 * Send a message to a peer agent.
 *
 * @param {object} params
 * @param {string} params.to - Recipient agent name or jobId.
 * @param {string} params.text - Message text.
 * @param {'notice' | 'query' | 'response'} [params.kind='notice'] - Message kind.
 * @param {string|null} [params.rootExecutionId=null] - Root execution ID.
 * @param {string} [params.from='orchestrator'] - Sender identifier.
 * @param {string|null} [params.workflowId=null] - Optional workflow ID.
 * @param {NodeJS.ProcessEnv} [params.env=process.env]
 * @returns {Promise<{ ok: true, messageId: number, status: string, truncated: boolean } | { ok: false, error: string }>}
 */
export async function agentSendMessageTool({
  to,
  text,
  kind = 'notice',
  rootExecutionId = null,
  from = 'orchestrator',
  workflowId = null,
  env = process.env,
} = {}) {
  if (!to || typeof to !== 'string' || to.trim().length === 0) {
    return { ok: false, error: 'recipient (to) is required' }
  }

  const trimmedTo = to.trim()
  if (WILDCARDS.has(trimmedTo.toLowerCase())) {
    return { ok: false, error: 'broadcast is not supported: address one peer' }
  }

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return { ok: false, error: 'message text is required' }
  }

  if (!VALID_KINDS.has(kind)) {
    return { ok: false, error: "kind must be one of 'notice' | 'query' | 'response'" }
  }

  let resolvedRoot = rootExecutionId
  if (!resolvedRoot) {
    const jobs = listJobs(env)
    const targetJob = jobs.find((j) => j.jobId === trimmedTo || j.job_id === trimmedTo)
    if (targetJob) {
      resolvedRoot = targetJob.root_execution_id ?? targetJob.executionId ?? targetJob.execution_id ?? null
    }
  }

  if (!resolvedRoot) {
    return { ok: false, error: 'rootExecutionId is required (or address a known jobId)' }
  }

  const ctx = getDb(env)
  const undelivered = listAgentMessages(ctx, { to: trimmedTo, rootExecutionId: resolvedRoot, unreadOnly: true })
  if (undelivered.length >= 10) {
    return { ok: false, error: 'mailbox_full' }
  }

  let finalText = text
  let truncated = false
  if (text.length > MAX_TEXT_LEN) {
    truncated = true
    finalText = text.slice(0, MAX_TEXT_LEN) + '...[truncated]'
  }

  const row = insertAgentMessage(ctx, {
    root_execution_id: resolvedRoot,
    workflow_id: workflowId,
    from_agent: from,
    to_agent: trimmedTo,
    kind,
    text: finalText,
    created_at: new Date().toISOString(),
  })

  return { ok: true, messageId: row.id, status: 'enqueued', truncated }
}

/**
 * Retrieve messages from the agent inbox, oldest-first, and mark them delivered.
 *
 * @param {object} params
 * @param {string} [params.to]
 * @param {string} [params.rootExecutionId]
 * @param {boolean} [params.unreadOnly=true]
 * @param {NodeJS.ProcessEnv} [params.env=process.env]
 * @returns {Promise<{ ok: true, messages: Array<{ id: number, from: string, kind: string, text: string, createdAt: string, deliveredAt: string|null, ackAt: string|null }> }>}
 */
export async function agentInboxTool({
  to,
  rootExecutionId,
  unreadOnly = true,
  env = process.env,
} = {}) {
  const ctx = getDb(env)
  const rows = listAgentMessages(ctx, { to, rootExecutionId, unreadOnly })
  const now = new Date().toISOString()

  for (const r of rows) {
    if (!r.delivered_at) {
      markAgentMessageDelivered(ctx, r.id, now)
      r.delivered_at = now
    }
  }

  const messages = rows.map((r) => ({
    id: r.id,
    from: r.from_agent ?? r.from,
    kind: r.kind,
    text: r.text,
    createdAt: r.created_at ?? r.createdAt,
    deliveredAt: r.delivered_at ?? r.deliveredAt ?? null,
    ackAt: r.ack_at ?? r.ackAt ?? null,
  }))

  return { ok: true, messages }
}

/**
 * Acknowledge receipt of a message into context envelope.
 *
 * @param {object} params
 * @param {number} params.messageId
 * @param {NodeJS.ProcessEnv} [params.env=process.env]
 * @returns {Promise<{ ok: true, acked: true, ackAt: string } | { ok: false, error: string }>}
 */
export async function agentAckTool({
  messageId,
  env = process.env,
} = {}) {
  if (messageId == null) {
    return { ok: false, error: 'messageId is required' }
  }

  const ctx = getDb(env)
  const existing = getAgentMessage(ctx, messageId)
  if (!existing) {
    return { ok: false, error: `message not found: ${messageId}` }
  }

  const ackAt = new Date().toISOString()
  markAgentMessageAck(ctx, messageId, ackAt)
  return { ok: true, acked: true, ackAt }
}

/**
 * List peers participating in a root execution.
 *
 * @param {object} params
 * @param {string} params.rootExecutionId
 * @param {NodeJS.ProcessEnv} [params.env=process.env]
 * @returns {Promise<{ ok: true, peers: Array<{ jobId: string, agent: string, model: string, status: string, stepId: string|null, messagingTurnBoundary: boolean, messagingMidRun: boolean }> }>}
 */
export async function agentPeersTool({
  rootExecutionId,
  env = process.env,
} = {}) {
  if (!rootExecutionId) {
    return { ok: true, peers: [] }
  }

  const jobs = listJobs(env)
  const matching = jobs.filter(
    (j) =>
      j.root_execution_id === rootExecutionId ||
      j.executionId === rootExecutionId ||
      j.rootExecutionId === rootExecutionId
  )

  const peers = matching.map((job) => {
    const caps = capabilitiesFor(job.agent, job.model)
    return {
      jobId: job.jobId,
      agent: job.agent,
      model: job.model,
      status: job.status,
      stepId: job.step_id ?? job.stepId ?? null,
      messagingTurnBoundary: Boolean(caps.messagingTurnBoundary),
      messagingMidRun: Boolean(caps.messagingMidRun),
    }
  })

  return { ok: true, peers }
}

export const agentSendMessage = agentSendMessageTool
export const agentInbox = agentInboxTool
export const agentAck = agentAckTool
export const agentPeers = agentPeersTool
