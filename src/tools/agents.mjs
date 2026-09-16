import { agentsStatus as runAgentsStatus } from '../preflight.mjs'
import { route as routeFn, DELEGATION_MAP, knownTaskTypes } from '../router.mjs'
import { MODEL_REGISTRY } from '../config.mjs'
import { readDiscovery } from '../discovery.mjs'
import { runCommand } from '../process.mjs'
import { fetchUsage } from '../quota/codexbar.mjs'
import { quotaFor, getProvider } from '../quota/mapping.mjs'

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

export async function agentsStatusTool({ refresh = false, cwd = process.cwd(), env = process.env, commandRunner = runCommand } = {}) {
  const pairs = defaultPairs()
  // A manual refresh from an MCP client is worth showing in the dashboard
  // timeline too; a plain cache-served call stays silent.
  const results = await runAgentsStatus({ agents: pairs, cwd, env, refresh, commandRunner, announce: refresh })
  const discovery = readDiscovery(env)

  const providers = new Set()
  for (const pair of pairs) {
    const p = getProvider(pair.agent, pair.model)
    if (p) providers.add(p)
  }
  const usageByProvider = await fetchUsage({ providers: [...providers], refresh, env })

  return results.map((r) => ({
    agent: r.agent,
    model: r.model,
    status: r.status,
    reason: r.reason ?? null,
    latencyMs: r.latencyMs ?? null,
    quotaSignal: r.quotaSignal ?? 'unknown',
    dataPolicy: MODEL_REGISTRY[r.agent]?.[r.model]?.dataPolicy ?? 'unknown',
    checkedAt: r.checkedAt,
    // Additive: sourced from discovery.json (populated at startup and by
    // the dashboard's "Rediscover CLIs" action), null until a discovery row
    // exists for this agent.
    binPath: discovery[r.agent]?.binPath ?? null,
    cliVersion: discovery[r.agent]?.version ?? null,
    quota: quotaFor({ agent: r.agent, model: r.model }, usageByProvider),
  }))
}

export async function routeTool({ taskType, mode, includeCatalog = false, env = process.env }) {
  const result = await routeFn({ taskType, mode, includeCatalog, env })
  return result
}

export { knownTaskTypes }

export async function agentsQuotaTool({ refresh = false, env = process.env } = {}) {
  const pairs = defaultPairs()
  // Add codex if present
  const discovery = readDiscovery(env)
  if (discovery['codex']) {
    pairs.push({ agent: 'codex', model: 'default' })
  }

  const providers = new Set()
  for (const pair of pairs) {
    const p = getProvider(pair.agent, pair.model)
    if (p) providers.add(p)
  }

  const usageByProvider = await fetchUsage({ providers: [...providers], refresh, env })

  return pairs.map((p) => ({
    agent: p.agent,
    model: p.model,
    quota: quotaFor(p, usageByProvider),
  }))
}
