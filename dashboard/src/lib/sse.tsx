import * as React from "react"
import { useQueryClient, type QueryKey } from "@tanstack/react-query"
import { qk } from "./query-keys"
import type { Connection, HubEventT } from "./types"

export const MAX_EVENTS = 200
const SSE_DEBOUNCE_MS = 250

/**
 * Map an SSE event kind to the query key it should invalidate:
 * job.* and preflight -> state; proposal.* -> proposals; learning.* ->
 * learnings; any other (unknown) kind -> state, so a server-added event
 * kind this build doesn't know about still keeps the dashboard fresh.
 */
export function keyForEventKind(kind: string): QueryKey {
  if (kind.startsWith("job.") || kind === "preflight") return qk.state
  if (kind.startsWith("proposal.")) return qk.proposals
  if (kind.startsWith("learning.")) return qk.learnings
  return qk.state
}

export type EventStreamState = {
  connection: Connection
  events: HubEventT[]
}

/**
 * Owns exactly one EventSource('/events'). Appends every message into a
 * capped client-side buffer (used by the timeline view/badge) and schedules
 * a trailing-debounced query invalidation per distinct affected key, so a
 * burst of events triggers at most one refetch per key every
 * SSE_DEBOUNCE_MS.
 */
export function useEventStream(): EventStreamState {
  const queryClient = useQueryClient()
  const [connection, setConnection] = React.useState<Connection>("connecting")
  const [events, setEvents] = React.useState<HubEventT[]>([])
  const pendingKeys = React.useRef<Map<string, QueryKey>>(new Map())
  const debounceTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)

  React.useEffect(() => {
    setConnection("connecting")
    const source = new EventSource("/events")

    source.onopen = () => setConnection("live")

    source.onerror = () => {
      setConnection(source.readyState === EventSource.CLOSED ? "offline" : "reconnecting")
    }

    source.onmessage = (message: MessageEvent<string>) => {
      let event: HubEventT | null = null
      try {
        event = JSON.parse(message.data) as HubEventT
      } catch {
        return
      }
      if (!event || typeof event.kind !== "string") return

      setEvents((prev) => {
        const next = [...prev, event as HubEventT]
        return next.length > MAX_EVENTS ? next.slice(next.length - MAX_EVENTS) : next
      })

      const key = keyForEventKind(event.kind)
      pendingKeys.current.set(JSON.stringify(key), key)
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
      debounceTimer.current = setTimeout(() => {
        for (const key of pendingKeys.current.values()) {
          queryClient.invalidateQueries({ queryKey: key })
        }
        pendingKeys.current.clear()
      }, SSE_DEBOUNCE_MS)
    }

    return () => {
      source.close()
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
    }
  }, [queryClient])

  return { connection, events }
}

const ConnectionContext = React.createContext<EventStreamState | undefined>(undefined)

export function SseProvider({ children }: { children: React.ReactNode }) {
  const value = useEventStream()
  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>
}

export function useConnection(): EventStreamState {
  const ctx = React.useContext(ConnectionContext)
  if (!ctx) throw new Error("useConnection must be used within a SseProvider")
  return ctx
}
