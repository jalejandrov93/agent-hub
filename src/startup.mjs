import { runDiscovery, pruneCacheForMap } from './discovery.mjs'
import { runCommand } from './process.mjs'

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
