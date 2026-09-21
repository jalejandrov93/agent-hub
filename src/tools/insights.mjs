import { computeMetrics, DEFAULT_GROUP_BY } from '../metrics.mjs'
import { listJobs } from '../jobstore.mjs'
import { buildExecutionGraph } from '../execution-graph.mjs'

/**
 * MCP tool handler returning aggregated delegation metrics across agent runs.
 * Sourced from the in-memory indexed runs directory under AGENT_HUB_HOME.
 *
 * @param {object} [options]
 * @param {string[]} [options.groupBy] - Dimensions to group by (default: agent, model, mode, taskType).
 * @param {NodeJS.ProcessEnv} [options.env] - Environment configuration holding AGENT_HUB_HOME.
 * @returns {import('../schemas.mjs').MetricsResponse}
 */
export function metricsTool({ groupBy = DEFAULT_GROUP_BY, env = process.env } = {}) {
  return computeMetrics({ groupBy, env })
}

/**
 * MCP tool handler returning a read-only execution graph across agent runs.
 * Sourced from the in-memory indexed runs directory under AGENT_HUB_HOME.
 *
 * @param {object} [options]
 * @param {string|null} [options.rootExecutionId] - Root execution ID to filter subtree (optional).
 * @param {NodeJS.ProcessEnv} [options.env] - Environment configuration holding AGENT_HUB_HOME.
 * @returns {object}
 */
export function executionGraphTool({ rootExecutionId = null, env = process.env } = {}) {
  const jobs = listJobs(env)
  return buildExecutionGraph({ jobs, rootExecutionId })
}

export const execution_graph = executionGraphTool
