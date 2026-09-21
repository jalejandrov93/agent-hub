/**
 * Harness lifecycle bridge contract: data-driven waking bridge resolution.
 *
 * The bridge is a CONSUMER of events; the execution engine must never depend
 * on it.
 *
 * NOTE: A real OpenCode bridge is a follow-up slice and must be version-gated.
 * Today all registered bridges declare supportsWake(...) === false.
 */

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
    supportsWake: (_version = null) => false,
  }),
})

export function bridgeSupportsWake(harnessId, { version = null } = {}) {
  const entry = BRIDGES[harnessId]
  if (!entry || typeof entry.supportsWake !== 'function') return false
  return Boolean(entry.supportsWake(version))
}

export function resolveBridge(harnessId, { version = null } = {}) {
  const entry = BRIDGES[harnessId]
  if (!entry || !entry.supportsWake?.(version)) {
    return NOOP_BRIDGE
  }
  return entry.bridge ?? (typeof entry.wake === 'function' ? entry : NOOP_BRIDGE)
}
