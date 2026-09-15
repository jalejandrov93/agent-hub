import type { HubEventT } from "@/lib/types"

export const MAX_TIMELINE_EVENTS = 200

export function eventKey(e: HubEventT): string {
  return `${e.ts}:${e.kind}:${e.jobId ?? ""}`
}

/**
 * Merge server events with live SSE buffer, dedupe by ts+kind+jobId,
 * sort newest first, and cap at 200 events.
 */
export function mergeTimelineEvents(
  serverEvents: HubEventT[] = [],
  sseEvents: HubEventT[] = []
): HubEventT[] {
  const map = new Map<string, HubEventT>()
  for (const e of serverEvents) {
    map.set(eventKey(e), e)
  }
  for (const e of sseEvents) {
    map.set(eventKey(e), e)
  }
  const merged = Array.from(map.values())
  merged.sort((a, b) => {
    const timeDiff = new Date(b.ts).getTime() - new Date(a.ts).getTime()
    if (!Number.isNaN(timeDiff) && timeDiff !== 0) return timeDiff
    return b.ts.localeCompare(a.ts)
  })
  return merged.slice(0, MAX_TIMELINE_EVENTS)
}

export type TimelineFilterParams = {
  source?: string
  kind?: string
  q?: string
}

export function matchesFilters(e: HubEventT, filters: TimelineFilterParams): boolean {
  const { source, kind, q } = filters

  if (source && source !== "all" && e.source !== source) {
    return false
  }

  if (kind && kind !== "all") {
    if (kind === "preflight") {
      if (e.kind !== "preflight") return false
    } else if (kind.endsWith(".*")) {
      const prefix = kind.slice(0, -1)
      if (!e.kind.startsWith(prefix)) return false
    } else if (e.kind !== kind) {
      return false
    }
  }

  if (q) {
    const needle = q.trim().toLowerCase()
    if (needle) {
      const fields = [e.title, e.summary, e.agent, e.model, e.jobId]
      const matches = fields.some(
        (val) => typeof val === "string" && val.toLowerCase().includes(needle)
      )
      if (!matches) return false
    }
  }

  return true
}
