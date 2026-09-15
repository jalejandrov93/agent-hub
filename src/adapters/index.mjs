import * as agy from './agy.mjs'
import * as opencode from './opencode.mjs'
import * as copilot from './copilot.mjs'

export const ADAPTERS = { agy, opencode, copilot }

export function adapterFor(agent) {
  const adapter = ADAPTERS[agent]
  if (!adapter) throw new Error(`unknown agent: ${agent}`)
  return adapter
}

/** Argv for the "list models" command per agent, used by preflight L1. */
export function modelsArgv(agent, model) {
  if (agent === 'agy') return ['models']
  if (agent === 'opencode') return ['models', String(model).split('/')[0] || 'opencode', '--verbose']
  if (agent === 'copilot') return ['help', 'config']
  throw new Error(`unknown agent: ${agent}`)
}
