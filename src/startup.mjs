import { runDiscovery, pruneCacheForMap } from './discovery.mjs'
import { runCommand } from './process.mjs'
import { defaultPairs } from './tools/agents.mjs'
import { getProvider } from './quota/mapping.mjs'
import { fetchUsage } from './quota/codexbar.mjs'

/**
 * Fire CLI discovery + cache pruning in the background right after startup.
 * Returns synchronously (setImmediate defers the actual work to the next
 * event-loop tick), so it never delays the caller — index.mjs calls this
 * before server.connect(), never awaiting it, so the stdio handshake is
 * never blocked by CLI spawns. Only L0 (--version) and L1 (model listing)
 * ever run here; L3 (pingAgent) is never invoked at boot or in bulk.
 *
 * AGENT_HUB_DISABLE_STARTUP_DISCOVERY=1 is an escape hatch for tests that
 * boot the real MCP server over stdio (test/server.test.mjs) and must never
 * spawn a real agy/opencode/copilot process as a side effect of doing so.
 */
export function scheduleStartupDiscovery({ env = process.env, commandRunner = runCommand } = {}) {
  if (env.AGENT_HUB_DISABLE_STARTUP_DISCOVERY === '1') return

  setImmediate(() => {
    pruneCacheForMap(env)
    runDiscovery({ env, commandRunner }).catch((error) => {
      console.error('[agent-hub] startup discovery failed:', error?.message ?? error)
    })
  })
}

/**
 * Warm CodexBar's quota cache once at startup, live (awaiting the network),
 * so the first cached-mode route()/agents_status of a session already has
 * data instead of returning `pending` for every provider. Fire-and-forget,
 * same as scheduleStartupDiscovery above: never awaited by main(), so a
 * cold or unreachable CodexBar can never delay or crash the stdio handshake.
 *
 * Shares AGENT_HUB_DISABLE_STARTUP_DISCOVERY=1 with scheduleStartupDiscovery
 * — the same escape hatch that keeps test/server.test.mjs from spawning real
 * CLI/network side effects also keeps it from hitting a real CodexBar.
 */
export function scheduleQuotaWarmup({ env = process.env, fetchUsageFn = fetchUsage } = {}) {
  if (env.AGENT_HUB_DISABLE_STARTUP_DISCOVERY === '1') return

  setImmediate(() => {
    const providers = new Set()
    for (const pair of defaultPairs()) {
      const p = getProvider(pair.agent, pair.model)
      if (p) providers.add(p)
    }
    if (providers.size === 0) return
    fetchUsageFn({ providers: [...providers], mode: 'live', env }).catch((error) => {
      console.error('[agent-hub] quota warmup failed:', error?.message ?? error)
    })
  })
}
