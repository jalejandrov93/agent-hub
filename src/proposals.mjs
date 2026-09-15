/**
 * Routing proposals: evidence-backed reorders of a DELEGATION_MAP chain,
 * persisted in proposals.json ({version:1, proposals:[...]}) and applied by
 * route() only after a human accepts them in the dashboard.
 *
 * P0 contract stub: pinned by test/v2-contracts.test.mjs. Work package P4
 * replaces the bodies.
 */

/** Pure: proposals suggested by `metrics` ({rows}) for `map` (DELEGATION_MAP shape). */
export function computeProposals({ metrics, map } = {}) {
  void metrics, map
  return []
}

/** Recompute from current metrics, persist new pending proposals, return every stored proposal. */
export function refreshProposals({ env = process.env } = {}) {
  void env
  return []
}

/** Stored proposals, optionally filtered by status. */
export function listProposals({ status } = {}, env = process.env) {
  void status, env
  return []
}

/** Accept or reject a pending proposal. Throws `proposal not found: <id>` or `proposal not pending: <id>`. */
export function decideProposal(id, status, env = process.env) {
  void status, env
  throw new Error(`proposal not found: ${id}`)
}

/** The accepted chain order for a task type, or null to use DELEGATION_MAP as-is. */
export function acceptedOrderFor(taskType, env = process.env) {
  void taskType, env
  return null
}
