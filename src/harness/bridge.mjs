/**
 * Harness lifecycle bridge contract: data-driven waking bridge resolution.
 *
 * The bridge is a CONSUMER of events; the execution engine must never depend
 * on it.
 *
 * NOTE: A real OpenCode bridge is a follow-up slice and must be version-gated.
 * Today all registered bridges declare supportsWake(...) === false.
 */

import { isSupportedOpencodeVersion, opencodeBridge } from './opencode-bridge.mjs'

export const NOOP_BRIDGE = Object.freeze({
  id: 'noop',
  canWake: () => false,
  async wake() {
    return { delivered: false, reason: 'no-bridge' }
  },
})

export const BRIDGES = Object.freeze({
  generic: Object.freeze({
    id: 'generic',
    supportsWake: () => false,
  }),
  'claude-code': Object.freeze({
    id: 'claude-code',
    supportsWake: () => false,
  }),
  opencode: Object.freeze({
    id: 'opencode',
    supportsWake: (version = null, { env = process.env } = {}) => {
      const e = env ?? process.env
      if (e?.AGENT_HUB_OPENCODE_BRIDGE !== '1') return false
      return isSupportedOpencodeVersion(version)
    },
    createBridge: (opts) => opencodeBridge(opts),
    get bridge() {
      return opencodeBridge()
    },
  }),
})

export function bridgeSupportsWake(harnessId, { version = null, env = process.env } = {}) {
  const entry = BRIDGES[harnessId]
  if (!entry || typeof entry.supportsWake !== 'function') return false
  return Boolean(entry.supportsWake(version, { env }))
}

export function resolveBridge(harnessId, { version = null, env = process.env, ...options } = {}) {
  const entry = BRIDGES[harnessId]
  if (!entry || !entry.supportsWake?.(version, { env })) {
    return NOOP_BRIDGE
  }
  if (typeof entry.createBridge === 'function') {
    return entry.createBridge({ version, env, ...options })
  }
  if (typeof entry.bridge === 'function') {
    return entry.bridge({ version, env, ...options })
  }
  return entry.bridge ?? (typeof entry.wake === 'function' ? entry : NOOP_BRIDGE)
}

