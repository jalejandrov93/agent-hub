import * as agy from './agy.mjs'
import * as opencode from './opencode.mjs'
import * as copilot from './copilot.mjs'
import * as jules from '../cloud/jules/adapter.mjs'

export const ADAPTERS = { agy, opencode, copilot, jules }

export function adapterFor(agent) {
  const adapter = ADAPTERS[agent]
  if (!adapter) throw new Error(`unknown agent: ${agent}`)
  return adapter
}

// Derived (not hand-maintained) so a future remote adapter is picked up the
// moment it exports `remote = true`, without another list to keep in sync.
export const REMOTE_AGENTS = new Set(
  Object.entries(ADAPTERS)
    .filter(([, adapter]) => adapter.remote === true)
    .map(([id]) => id)
)

/** Argv for the "list models" command per agent, used by preflight L1. */
export function modelsArgv(agent, model) {
  if (agent === 'agy') return ['models']
  if (agent === 'opencode') return ['models', String(model).split('/')[0] || 'opencode', '--verbose']
  if (agent === 'copilot') return ['help', 'config']
  // Jules is an API-only remote agent (see src/cloud/jules/*): there is no
  // local binary to spawn, so no argv exists for "list its models".
  if (agent === 'jules') throw new Error('jules has no CLI to list models from — it is an API-only remote agent')
  throw new Error(`unknown agent: ${agent}`)
}
