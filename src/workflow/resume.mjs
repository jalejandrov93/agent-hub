/**
 * C1.2: resume a workflow node from an execution (job) record.
 *
 * The wave loop in engine.mjs parks a node in WAITING while the remote
 * session needs interaction, then watches WAITING -> RUNNING to continue
 * waiting on the SAME handle (no re-dispatch). This module is the other
 * half: after a successful interactWithSession (reply / approve_plan) the
 * supervisor / interact tool flips the node back to RUNNING so the parked
 * wave wakes up.
 *
 * Ownership rules (never steal):
 * - Only a node currently in WAITING is touched; every other state returns
 *   {resumed:false, reason:'not-waiting:<state>'} without writing anything.
 * - The CAS write only flips a row that is STILL waiting and preserves
 *   claimed_by — the scheduler holding the claim keeps it.
 * - When the caller knows scheduler ownership (claimedBy + isOwnerAlive) and
 *   the claim belongs to another LIVE scheduler, the resume backs off with
 *   {resumed:false, reason:'owned-elsewhere'} instead of writing.
 * - A lost CAS race (row moved under us) re-reads: moved elsewhere ->
 *   'not-waiting:<state>', still waiting but unflippable -> 'owned-elsewhere'.
 */
import { getDb, getWorkflowNode, resumeWorkflowNode } from '../storage/index.mjs'
import { readResult as defaultReadResult } from '../jobstore.mjs'
import { NODE_STATUS, assertValidTransition } from './state.mjs'

function workflowIdsFromRecord(record) {
  const workflowId = record?.workflow_id ?? record?.workflowId ?? null
  const stepId = record?.step_id ?? record?.stepId ?? null
  return { workflowId, stepId }
}

/**
 * Resume the workflow node linked to a job record.
 *
 * @param {string} jobId
 * @param {object} [opts]
 * @param {object} [opts.env=process.env]
 * @param {Function} [opts.readResultFn] - (jobId, env) => record
 * @param {Function} [opts.transitionNodeFn] - override for the
 *   waiting -> running write, called as (ctx, {workflowId, stepId, from, to});
 *   truthy = resumed, falsy = lost the race. Defaults to the atomic
 *   storage CAS (same transition semantics as transitionNode).
 * @param {object} [opts.ctx] - storage context; defaults to getDb(env)
 * @param {string} [opts.claimedBy] - resumer identity for the ownership gate
 * @param {Function} [opts.isOwnerAlive] - (owner, me) => boolean; only
 *   consulted when the node carries a foreign claim AND claimedBy is set.
 * @returns {{resumed:boolean, reason?:string, workflowId?:string, stepId?:string}}
 */
export function resumeWorkflowNodeFromExecution(jobId, {
  env = process.env,
  readResultFn = defaultReadResult,
  transitionNodeFn = null,
  ctx = null,
  claimedBy = null,
  isOwnerAlive = null,
} = {}) {
  let record = null
  try {
    record = readResultFn(jobId, env)
  } catch {
    record = null
  }
  const { workflowId, stepId } = workflowIdsFromRecord(record ?? {})
  if (!workflowId || !stepId) {
    return { resumed: false, reason: 'no-workflow' }
  }

  const dbCtx = ctx ?? getDb(env)
  const row = getWorkflowNode(dbCtx, workflowId, stepId)
  if (!row || row.status !== NODE_STATUS.WAITING) {
    return { resumed: false, reason: `not-waiting:${row?.status ?? 'missing'}` }
  }

  // Ownership gate: a claim held by another LIVE scheduler is never stolen.
  // Without caller identity (the supervise/interact path) there is nothing
  // to compare against, so the atomic CAS below is the only gate.
  const owner = row.claimed_by ?? null
  if (owner && claimedBy && owner !== claimedBy) {
    const alive = typeof isOwnerAlive === 'function' ? isOwnerAlive(owner, claimedBy) : false
    if (alive) {
      return { resumed: false, reason: 'owned-elsewhere' }
    }
  }

  // Same discipline as engine.mjs C1.1: assert the transition first.
  assertValidTransition(NODE_STATUS.WAITING, NODE_STATUS.RUNNING, stepId)

  let flipped = false
  if (transitionNodeFn) {
    flipped = Boolean(transitionNodeFn(dbCtx, {
      workflowId, stepId, from: NODE_STATUS.WAITING, to: NODE_STATUS.RUNNING,
    }))
  } else {
    // Default: the atomic storage CAS — the waiting -> running transition
    // with the same semantics transitionNode() (engine.mjs) would apply
    // (asserted above), but as one conditional write that never steals the
    // claim.
    flipped = resumeWorkflowNode(dbCtx, { workflowId, stepId })
  }

  if (flipped) {
    return { resumed: true, workflowId, stepId, from: NODE_STATUS.WAITING, to: NODE_STATUS.RUNNING }
  }

  // Lost the race: re-read to report precisely.
  const current = getWorkflowNode(dbCtx, workflowId, stepId)
  if (!current || current.status !== NODE_STATUS.WAITING) {
    return { resumed: false, reason: `not-waiting:${current?.status ?? 'missing'}` }
  }
  return { resumed: false, reason: 'owned-elsewhere' }
}

/**
 * Best-effort wrapper for call sites (supervise / interact): never throws,
 * so a resume bookkeeping failure can never fail the interaction itself.
 */
export function bestEffortResumeWorkflowNode(jobId, opts = {}) {
  try {
    return resumeWorkflowNodeFromExecution(jobId, opts)
  } catch (error) {
    return { resumed: false, reason: `resume-error:${error?.message ?? String(error)}` }
  }
}
