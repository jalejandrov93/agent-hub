/**
 * Delegation metrics per (agent, model, mode, taskType), derived from job
 * records under runs/. Feeds adaptive timeouts, routing proposals, the
 * agents_metrics MCP tool and GET /api/metrics.
 *
 * P0 contract stub: signatures and empty-state behavior are frozen here and
 * pinned by test/v2-contracts.test.mjs. Work package P2 replaces the body.
 */

export const DEFAULT_GROUP_BY = ['agent', 'model', 'mode', 'taskType']

/** @returns {{generatedAt: string, groupBy: string[], rows: import('./schemas.mjs').MetricsRow[]}} */
export function computeMetrics({ env = process.env, groupBy = DEFAULT_GROUP_BY } = {}) {
  void env
  return { generatedAt: new Date().toISOString(), groupBy: [...groupBy], rows: [] }
}

/** The single metrics row for one exact key, or null when there is no history. */
export function metricsFor({ agent, model, mode = 'read', taskType = null, env = process.env } = {}) {
  void agent, model, mode, taskType, env
  return null
}
