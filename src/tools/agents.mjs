import { agentsStatus as runAgentsStatus } from '../preflight.mjs'
import { route as routeFn, DELEGATION_MAP, knownTaskTypes } from '../router.mjs'
import { MODEL_REGISTRY } from '../config.mjs'

/**
 * The default set of agent+model pairs agents_status checks: every distinct
 * CLI pair (not Claude subagent tiers, which are not CLI-preflighted) named
 * anywhere in the delegation map.
 */
export function defaultPairs() {
  const seen = new Set()
  const pairs = []
  const add = (c) => {
    if (!c || c.agent === 'claude') return
    const key = `${c.agent}:${c.model}`
    if (seen.has(key)) return
    seen.add(key)
    pairs.push({ agent: c.agent, model: c.model })
  }
  for (const entry of Object.values(DELEGATION_MAP)) {
    for (const candidate of entry.chain) {
      add(candidate)
      add(candidate.parallelWith)
    }
  }
  return pairs
}

export async function agentsStatusTool({ refresh = false, cwd = process.cwd(), env = process.env } = {}) {
  const pairs = defaultPairs()
  const results = await runAgentsStatus({ agents: pairs, cwd, env, refresh })
  return results.map((r) => ({
    agent: r.agent,
    model: r.model,
    status: r.status,
    reason: r.reason ?? null,
    latencyMs: r.latencyMs ?? null,
    quotaSignal: r.quotaSignal ?? 'unknown',
    dataPolicy: MODEL_REGISTRY[r.agent]?.[r.model]?.dataPolicy ?? 'unknown',
    checkedAt: r.checkedAt,
  }))
}

export async function routeTool({ taskType, mode, env = process.env }) {
  const result = await routeFn({ taskType, mode, env })
  return result
}

export { knownTaskTypes }
