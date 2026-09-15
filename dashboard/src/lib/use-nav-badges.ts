import * as React from "react"
import { useStateQuery, useConfigQuery, useProposalsQuery, useLearningsQuery } from "./queries"
import { useConnection } from "./sse"
import { navBadges, type NavBadgeKey, type NavBadgeEntry } from "./badges"
import { useTimelineSeen } from "./timeline-seen"
import type { DerivedState } from "./types"

/** Assembles the sidebar's nav-badge counts from the live query caches + SSE buffer. */
export function useNavBadges(): Record<NavBadgeKey, NavBadgeEntry> {
  const stateQuery = useStateQuery()
  const configQuery = useConfigQuery()
  const proposalsQuery = useProposalsQuery()
  const learningsQuery = useLearningsQuery()
  const { events: liveEvents } = useConnection()
  const [lastSeenTimelineTs] = useTimelineSeen()

  return React.useMemo(() => {
    const state: DerivedState = {
      agents: stateQuery.data?.agents ?? [],
      jobs: stateQuery.data?.jobs ?? [],
      // Prefer the live SSE buffer once it has events; it's the freshest
      // source and is what the timeline view renders from too. Before the
      // first SSE message (or if the connection never comes up) fall back
      // to the last /api/state snapshot so the badge isn't stuck at zero.
      events: liveEvents.length > 0 ? liveEvents : (stateQuery.data?.events ?? []),
      config: configQuery.data ?? null,
      proposals: proposalsQuery.data?.proposals ?? [],
      learnings: learningsQuery.data?.learnings ?? [],
      lastSeenTimelineTs,
    }
    return navBadges(state)
  }, [
    stateQuery.data,
    configQuery.data,
    proposalsQuery.data,
    learningsQuery.data,
    liveEvents,
    lastSeenTimelineTs,
  ])
}
