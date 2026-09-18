import { listJobs as defaultListJobs, readResult as defaultReadResult, updateResult as defaultUpdateResult } from '../jobstore.mjs'
import { listAccounts as defaultListAccounts, getAccountSecret as defaultGetAccountSecret } from '../accounts.mjs'
import { appendEvent as defaultAppendEvent } from '../eventlog.mjs'
import { finishRemoteJob as defaultFinishRemoteJob } from './runner.mjs'
import { keyForJob, keyForAccount, NO_KEY_MESSAGE } from './credentials.mjs'
import * as defaultClient from './jules/client.mjs'
import * as defaultAdapter from './jules/adapter.mjs'

/**
 * Activities arrive oldest-first, so a session that outlived the machine has
 * more than one page and the newest state hides on the last one. Draining is
 * still a single bounded read: no sleeping or backoff, and the cap stops a
 * server that keeps echoing the same nextPageToken from hanging the call.
 */
export const ACTIVITY_PAGE_CAP = 10

async function collectActivities({ client, apiKey, sessionId, pageSize }) {
  const activities = []
  let pageToken
  for (let page = 0; page < ACTIVITY_PAGE_CAP; page++) {
    const result = await client.listActivities({
      apiKey,
      sessionId,
      pageSize,
      ...(pageToken ? { pageToken } : {}),
    })
    const pageActivities = Array.isArray(result?.activities) ? result.activities : []
    activities.push(...pageActivities)
    pageToken = result?.nextPageToken
    // An empty page means the token is not advancing; stop rather than spin.
    if (!pageToken || pageActivities.length === 0) break
  }
  return activities
}

/**
 * Answer "what did that Jules session do?" with a single live read.
 *
 * A Jules session runs on Google's servers, so this process may have been dead
 * for days when the user asks. This is deliberately NOT a poll loop: it makes
 * one getSession plus a bounded drain of listActivities and returns, so it works
 * after a reboot with no poller, backoff or sleeping involved.
 *
 * A jobId names its own local record; a bare sessionId may still have one (the
 * job_result recovery path), so it is matched against remote.sessionId. When a
 * local job is found and its session is terminal while the job is still
 * 'running', finishRemoteJob finalizes it so the job stops being 'running'
 * forever and job_result returns the real answer.
 */
export function computeAttention({ state, activities = [], record } = {}) {
  const isWaiting = state === 'PAUSED' || (typeof state === 'string' && state.startsWith('AWAITING_'))
  const attentionRequired = Boolean(isWaiting)

  let attentionReason = null
  let recommendedAction = null
  let canAutoResolve = false

  if (state === 'AWAITING_USER_FEEDBACK') {
    attentionReason = 'user_feedback'
    recommendedAction = 'send_message'
    canAutoResolve = false
  } else if (state === 'AWAITING_PLAN_APPROVAL') {
    attentionReason = 'plan_approval'
    recommendedAction = 'approve_plan'
    canAutoResolve = true
  } else if (state === 'PAUSED') {
    attentionReason = 'paused'
    recommendedAction = null
    canAutoResolve = false
  }

  const interactionCount = Array.isArray(activities)
    ? activities.filter((a) => a?.userMessaged != null || a?.planApproved != null).length
    : 0
  // Prefer the semantic intervention counter; attempts is the legacy
  // aggregate and turnDepth is conversation depth (kept as last fallback so
  // old records without counters still report something sane).
  const recordedAttempts = record?.remote?.interventionCount ?? record?.remote?.attempts ?? record?.turnDepth ?? 0
  const attempts = Math.max(recordedAttempts, interactionCount)

  return {
    attentionRequired,
    attentionReason,
    recommendedAction,
    canAutoResolve,
    attempts,
  }
}

export async function checkRemoteSession({
  jobId,
  sessionId,
  env = process.env,
  client = defaultClient,
  adapter = defaultAdapter,
  listJobsFn = defaultListJobs,
  readResultFn = defaultReadResult,
  updateResultFn = defaultUpdateResult,
  appendEventFn = defaultAppendEvent,
  finishRemoteJobFn = defaultFinishRemoteJob,
  getAccountSecretFn = defaultGetAccountSecret,
  listAccountsFn = defaultListAccounts,
  activityPageSize = 100,
  enrich = false,
} = {}) {
  if (!jobId && !sessionId) {
    throw new Error('checkRemoteSession requires a jobId or a sessionId')
  }

  let resolvedJobId = jobId ?? null
  let resolvedSessionId = sessionId ?? null
  let resolvedJob = null

  if (jobId) {
    const record = readResultFn(jobId, env)
    const recorded = record?.remote?.sessionId
    if (!recorded) throw new Error(`job ${jobId} has no Jules session recorded`)
    resolvedSessionId = sessionId ?? recorded
    resolvedJob = record
  } else {
    // A bare sessionId is not a jobId, but this machine may still hold the job
    // that started it — look it up so the caller gets a jobId to finalize and,
    // with it, the account that owns the session.
    let jobs = []
    try {
      jobs = listJobsFn(env)
    } catch {
      // A broken runs dir must never turn a read-only check into a failure.
    }
    const match = Array.isArray(jobs) ? jobs.find((job) => job?.remote?.sessionId === resolvedSessionId) : null
    if (match) {
      resolvedJobId = match.jobId
      resolvedJob = match
    }
  }

  // Poll with the account that started the session (keyForJob); a bare session
  // this machine has no record of uses the account selection policy
  // (keyForAccount). Both live in credentials.mjs — the one source of truth.
  const apiKey = resolvedJob
    ? keyForJob(resolvedJob, { env, getAccountSecretFn })
    : keyForAccount({ env, listAccountsFn, getAccountSecretFn }).apiKey
  if (!apiKey || apiKey.length === 0) {
    throw new Error(NO_KEY_MESSAGE)
  }

  const session = await client.getSession({ apiKey, sessionId: resolvedSessionId })
  const activities = await collectActivities({
    client,
    apiKey,
    sessionId: resolvedSessionId,
    pageSize: activityPageSize,
  })
  const summary = adapter.summarizeActivities(activities)

  const state = adapter.sessionState(session)
  const prUrl = summary?.prUrl ?? adapter.prUrlFromSession(session) ?? null
  const branch = adapter.branchFromSession(session) ?? null
  const sessionUrl = adapter.sessionUrl(session)
  const lastMessage = summary?.lastAgentMessage ?? null
  const terminal = adapter.isTerminalState(state)

  let finalized = false
  let recovered = false
  if (resolvedJobId) {
    const current = readResultFn(resolvedJobId, env)
    const currentRemote = current?.remote ?? {}
    // Only a real state string is fresh; the adapter's 'UNKNOWN' fallback must
    // not clobber a state learned while the machine was up.
    const freshState = typeof session?.state === 'string' && session.state.length > 0 ? session.state : null
    const observedWaiting = freshState === 'PAUSED' || (typeof freshState === 'string' && freshState.startsWith('AWAITING_'))
    updateResultFn(
      resolvedJobId,
      {
        // remote_state mirrors remote.state as a top-level SQL-friendly index
        // (same write the poller does) — the semantic source of truth stays
        // remote.state. Without this, the reboot-recovery path left a stale
        // index behind (e.g. remote.state=COMPLETED beside remote_state=IN_PROGRESS).
        remote_state: freshState ?? currentRemote.state ?? null,
        remote: {
          ...currentRemote,
          state: freshState ?? currentRemote.state ?? null,
          prUrl: prUrl ?? currentRemote.prUrl ?? null,
          branch: branch ?? currentRemote.branch ?? null,
          // Model A: only an observation that sees a NON-waiting state may
          // clear pollingStoppedReason. jules_interact deliberately leaves it
          // (no watcher exists after an interaction), so a stale null here
          // would falsely claim polling is active.
          ...(!observedWaiting ? { pollingStoppedReason: null } : {}),
        },
      },
      env
    )

    // A remote job has no local process, so it can never genuinely be
    // orphaned. An 'orphaned' failure on one was written by a reconcile that
    // did not know about remote jobs — observed for real when an older
    // agent-hub install marked three live Jules jobs failed on its next start.
    // It is a misclassification to undo, not an outcome to respect: without
    // this the job could never be finalized and its pull request would be lost.
    // Any other failure kind is real and is left exactly as it is.
    // 'timeout' belongs here for the same reason: for a remote job it only ever
    // means THIS process's local deadline elapsed, never that the session did.
    if (current?.status === 'failed' && (current?.errorKind === 'orphaned' || current?.errorKind === 'timeout')) {
      updateResultFn(resolvedJobId, { status: 'running', errorKind: null, error: null }, env)
      recovered = true
    }
    const effectiveStatus = recovered ? 'running' : current?.status

    if (terminal && effectiveStatus === 'running') {
      finishRemoteJobFn({
        jobId: resolvedJobId,
        outcome: state === 'COMPLETED' ? 'completed' : 'failed',
        state,
        summary,
        session,
        apiError: null,
        adapter,
        env,
        readResultFn,
        updateResultFn,
        appendEventFn,
      })
      finalized = true
    }
  }

  const baseResult = {
    jobId: resolvedJobId,
    sessionId: resolvedSessionId,
    state,
    prUrl,
    branch,
    sessionUrl,
    lastMessage,
    finalized,
    recovered,
    terminal,
  }

  if (enrich) {
    return {
      ...baseResult,
      ...computeAttention({ state, activities, record: resolvedJob }),
    }
  }

  return baseResult
}
