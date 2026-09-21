/**
 * Node state machine definition and transitions.
 *
 * States:
 *   pending   - Initial state, waiting for dependencies or condition evaluation.
 *   ready     - Dependencies satisfied and condition passed; ready to be executed.
 *   running   - Claimed by a scheduler worker and actively executing.
 *   waiting   - Execution dispatched but awaiting interaction
 *               (user_feedback | plan_approval | external_event).
 *               Non-terminal: scheduler holds the claim, never re-dispatches.
 *   succeeded - Terminal state: executed successfully.
 *   failed    - Terminal state: execution failed and retry attempts exhausted.
 *   skipped   - Terminal state: condition evaluated to false or upstream dependency failed.
 *   canceled  - Terminal state: execution was aborted/canceled.
 *
 * Valid transitions:
 *   pending -> ready
 *   pending -> skipped   (condition false or dependency failed)
 *   pending -> canceled
 *   ready   -> running
 *   ready   -> skipped   (condition re-evaluated false at launch)
 *   ready   -> canceled
 *   running -> succeeded
 *   running -> failed    (attempts exhausted)
 *   running -> ready     (retry when attempts remain)
 *   running -> canceled
 *   running -> waiting   (remote/local execution waits for interaction)
 *   waiting -> running   (interaction received, resume without re-dispatch)
 *   waiting -> ready     (the wait expired with attempts left: re-queue to retry)
 *   waiting -> failed    (wait aborted or wait outcome failed)
 *   waiting -> canceled  (wait aborted by user)
 */

export const NODE_STATUS = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  RUNNING: 'running',
  WAITING: 'waiting',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  CANCELED: 'canceled',
})

/** Reasons a node may enter WAITING. Persisted in result_json.waitReason. */
export const WAITING_REASONS = Object.freeze({
  USER_FEEDBACK: 'user_feedback',
  PLAN_APPROVAL: 'plan_approval',
  EXTERNAL_EVENT: 'external_event',
})

export function isWaitingReason(reason) {
  return Object.values(WAITING_REASONS).includes(reason)
}

export const VALID_NODE_TRANSITIONS = Object.freeze({
  [NODE_STATUS.PENDING]: Object.freeze([
    NODE_STATUS.READY,
    NODE_STATUS.SKIPPED,
    NODE_STATUS.CANCELED,
  ]),
  [NODE_STATUS.READY]: Object.freeze([
    NODE_STATUS.RUNNING,
    NODE_STATUS.SKIPPED,
    NODE_STATUS.CANCELED,
  ]),
  [NODE_STATUS.RUNNING]: Object.freeze([
    NODE_STATUS.SUCCEEDED,
    NODE_STATUS.FAILED,
    NODE_STATUS.READY,
    NODE_STATUS.CANCELED,
    NODE_STATUS.WAITING,
  ]),
  [NODE_STATUS.WAITING]: Object.freeze([
    NODE_STATUS.RUNNING,
    // A wait that ends without a result (local deadline expired) re-queues the
    // node for another attempt; without this edge every retry throws.
    NODE_STATUS.READY,
    NODE_STATUS.FAILED,
    NODE_STATUS.CANCELED,
  ]),
  [NODE_STATUS.SUCCEEDED]: Object.freeze([]),
  [NODE_STATUS.FAILED]: Object.freeze([]),
  [NODE_STATUS.SKIPPED]: Object.freeze([]),
  [NODE_STATUS.CANCELED]: Object.freeze([]),
})

export const TERMINAL_STATUSES = Object.freeze(
  new Set([
    NODE_STATUS.SUCCEEDED,
    NODE_STATUS.FAILED,
    NODE_STATUS.SKIPPED,
    NODE_STATUS.CANCELED,
  ])
)

/**
 * Checks whether a given status is a terminal state.
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(status)
}

/**
 * Returns true if a state transition from `from` to `to` is allowed.
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function isValidTransition(from, to) {
  const allowed = VALID_NODE_TRANSITIONS[from]
  return Boolean(allowed && allowed.includes(to))
}

/**
 * Asserts that a state transition is valid, throwing an Error if invalid.
 * @param {string} from
 * @param {string} to
 * @param {string} [stepId='unknown']
 */
export function assertValidTransition(from, to, stepId = 'unknown') {
  if (!isValidTransition(from, to)) {
    throw new Error(
      `Invalid node state transition for step "${stepId}": cannot transition from "${from}" to "${to}"`
    )
  }
}
