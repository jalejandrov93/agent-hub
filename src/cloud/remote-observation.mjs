import { updateResult as defaultUpdateResult, readResult as defaultReadResult } from '../jobstore.mjs'

/**
 * Apply a remote observation snapshot to a job's record.
 *
 * Writes:
 * 1. state: remote session state (fallback to previous if fresh is null/empty)
 * 2. stateSince: updated ONLY on state transition, preserved on identical state
 * 3. lastActivityAt: updated ONLY when sawNewActivity is true, preserved otherwise
 * 4. remote_state: top-level mirror of remote.state
 * 5. pollingStoppedReason: cleared to null ONLY if state is non-waiting
 *
 * Used by both pollOnce() and checkRemoteSession() to eliminate duplicated logic
 * and guarantee that check and poller never diverge on these 5 fields.
 */
export function applyRemoteObservation({
  jobId,
  state,
  isWaiting,
  sawNewActivity = false,
  patch = {},
  currentRecord,
  currentRemote,
  updateResultFn = defaultUpdateResult,
  readResultFn = defaultReadResult,
  env = process.env,
  nowFn = Date.now,
} = {}) {
  let remote = currentRemote
  if (!remote && jobId && readResultFn) {
    try {
      remote = readResultFn(jobId, env)?.remote
    } catch {
      // ignore
    }
  }
  remote = remote ?? currentRecord?.remote ?? {}

  const previousState = remote.state ?? null
  const freshState = typeof state === 'string' && state.length > 0 ? state : null
  const resolvedState = freshState ?? previousState ?? null
  const stateChanged = resolvedState != null && resolvedState !== previousState

  const nowIso = new Date(nowFn()).toISOString()
  const stateSince = stateChanged ? nowIso : (remote.stateSince ?? (resolvedState ? nowIso : null))
  const lastActivityAt = sawNewActivity ? nowIso : (remote.lastActivityAt ?? null)

  const patchRemote = patch.remote ?? patch

  const remoteUpdate = {
    ...remote,
    ...patchRemote,
    state: resolvedState,
    stateSince,
    lastActivityAt,
  }

  // Clear pollingStoppedReason only if state is non-waiting
  if (!isWaiting) {
    remoteUpdate.pollingStoppedReason = null
  } else if (patchRemote.pollingStoppedReason !== undefined) {
    remoteUpdate.pollingStoppedReason = patchRemote.pollingStoppedReason
  }

  const resultPatch = {
    remote_state: resolvedState,
    remote: remoteUpdate,
  }

  if (jobId && updateResultFn) {
    updateResultFn(jobId, resultPatch, env)
  }

  return resultPatch
}
