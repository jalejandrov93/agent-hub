import { proposeLearning } from '../learnings.mjs'

/**
 * MCP tool handler for learning_propose. Always stores as pending — a human
 * must approve it in the dashboard before selectLearnings can ever return it.
 *
 * @param {import('../schemas.mjs').LearningInput} input
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] - Environment configuration holding AGENT_HUB_HOME.
 */
export function learningProposeTool(input, { env = process.env } = {}) {
  const learning = proposeLearning(input, env, { source: 'mcp' })
  return {
    learning,
    note: 'Stored as pending. A human must approve it in the dashboard (#/approvals?tab=learnings) before it is used.',
  }
}
