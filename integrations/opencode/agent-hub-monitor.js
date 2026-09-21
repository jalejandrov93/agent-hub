/**
 * OpenCode Subagent Monitor Plugin for agent-hub
 *
 * Mirrors OpenCode child sessions (subagents) to agent-hub's event log
 * so that agent-hub's dashboard sees them just like Claude Code subagents.
 *
 * Install:
 *   Copy or symlink this plugin and event-line.mjs into OpenCode's plugins directory:
 *     mkdir -p ~/.config/opencode/plugins
 *     ln -s /path/to/agent-hub/integrations/opencode/agent-hub-monitor.js ~/.config/opencode/plugins/agent-hub-monitor.js
 *     ln -s /path/to/agent-hub/integrations/opencode/event-line.mjs ~/.config/opencode/plugins/event-line.mjs
 *
 * Required environment:
 *   AGENT_HUB_HOME: Path to the agent-hub state directory (defaults to ~/.local/share/agent-hub).
 *                   Events are appended atomically to $AGENT_HUB_HOME/events.jsonl.
 */

import { buildSubagentEvent, appendEventLine } from './event-line.mjs'

// Track active child sessions: sessionID -> { session, stopped: boolean }
const trackedChildren = new Map()

/**
 * Handle a single event payload and append subagent start/stop lines as appropriate.
 */
export function handlePluginEvent(eventPayload, { env = process.env, file } = {}) {
  const event = eventPayload?.event || eventPayload
  if (!event || typeof event !== 'object') return

  const type = event.type
  const properties = event.properties || event.data || {}
  const info = properties.info || properties.session || properties

  if (type === 'session.created') {
    const parentID = info?.parentID || properties?.parentID || event?.data?.parentID
    const sessionID = info?.id || properties?.sessionID || properties?.id || event?.data?.sessionID || event?.data?.id

    if (parentID && sessionID) {
      const childSession = { ...info, id: sessionID, parentID }
      trackedChildren.set(sessionID, { session: childSession, stopped: false })

      const startEvent = buildSubagentEvent({
        phase: 'start',
        session: childSession,
        env,
      })
      if (startEvent) {
        appendEventLine({ file, event: startEvent, env })
      }
    }
    return
  }

  if (type === 'session.idle' || type === 'session.deleted') {
    const sessionID = properties?.sessionID || info?.id || properties?.id || event?.data?.sessionID || event?.data?.id
    if (sessionID && trackedChildren.has(sessionID)) {
      const entry = trackedChildren.get(sessionID)

      if (type === 'session.deleted') {
        trackedChildren.delete(sessionID)
      }

      if (entry && !entry.stopped) {
        if (type === 'session.idle') {
          entry.stopped = true
        }
        const stopEvent = buildSubagentEvent({
          phase: 'stop',
          session: entry.session,
          env,
        })
        if (stopEvent) {
          appendEventLine({ file, event: stopEvent, env })
        }
      }
    }
  }
}

/**
 * OpenCode plugin entry point.
 */
export const AgentHubMonitorPlugin = async (ctx = {}) => {
  if (ctx?.event?.subscribe) {
    ;(async () => {
      try {
        for await (const ev of ctx.event.subscribe()) {
          handlePluginEvent(ev, { env: process.env })
        }
      } catch {
        // stream ended or ignored
      }
    })()
  }

  return {
    event: async (input) => {
      handlePluginEvent(input?.event || input, {
        env: input?.env || process.env,
        file: input?.file,
      })
    },
  }
}

AgentHubMonitorPlugin.id = 'agent-hub-monitor'
AgentHubMonitorPlugin.server = AgentHubMonitorPlugin
AgentHubMonitorPlugin.setup = (ctx) => {
  if (ctx?.event?.subscribe) {
    ;(async () => {
      try {
        for await (const ev of ctx.event.subscribe()) {
          handlePluginEvent(ev, { env: process.env })
        }
      } catch {
        // stream ended or ignored
      }
    })()
  }
}

export default AgentHubMonitorPlugin
