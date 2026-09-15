import { computeMetrics, DEFAULT_GROUP_BY } from '../metrics.mjs'

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
