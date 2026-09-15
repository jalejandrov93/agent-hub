/**
 * Curated learnings: short, human-approved notes about an agent, model or
 * task type ("X hangs on long prompts"). Stored in learnings.json
 * ({version:1, learnings:[...]}); approved entries matching a job are
 * prepended to its prompt as advisory notes.
 *
 * P0 contract stub: pinned by test/v2-contracts.test.mjs. Work package P5
 * replaces the bodies.
 */

/** Store a new learning as pending. `input` follows schemas.mjs LearningInput; `source` is 'mcp' or 'dashboard'. */
export function proposeLearning(input, env = process.env, { source = 'mcp' } = {}) {
  void input, env, source
  throw new Error('not implemented')
}

/** Approve or reject a learning. Throws `learning not found: <id>`. */
export function decideLearning(id, status, env = process.env) {
  void status, env
  throw new Error(`learning not found: ${id}`)
}

/** Remove a learning. Throws `learning not found: <id>`. */
export function deleteLearning(id, env = process.env) {
  void env
  throw new Error(`learning not found: ${id}`)
}

/** Stored learnings, optionally filtered by status. */
export function listLearnings({ status } = {}, env = process.env) {
  void status, env
  return []
}

/** Approved learnings that apply to one job, most specific first, capped at LEARNINGS_MAX. */
export function selectLearnings({ agent, model, taskType = null, env = process.env } = {}) {
  void agent, model, taskType, env
  return []
}

/** Prepend the learnings block to `task`. Returns the task unchanged when `learnings` is empty. */
export function augmentTask(task, learnings = []) {
  void learnings
  return { task, learningIds: [] }
}
