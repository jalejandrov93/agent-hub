/**
 * Types inferred from the shared server contracts (src/schemas.mjs, aliased
 * as @shared). This is the ONLY place that imports zod's `z.infer` over
 * those schemas — everything else in the dashboard imports these type names.
 */
import type { z } from "zod"
import type {
  AgentStatusRow,
  JobRecord,
  HubEvent,
  StateResponse,
  ConfigResponse,
  MetricsResponse,
  MetricsRow,
  BreakerState,
  Override,
  Proposal,
  Learning,
  LearningInput,
} from "@shared"

export type AgentRow = z.infer<typeof AgentStatusRow>
export type Job = z.infer<typeof JobRecord>
export type HubEventT = z.infer<typeof HubEvent>
export type StateResponseT = z.infer<typeof StateResponse>
export type ConfigResponseT = z.infer<typeof ConfigResponse>
export type MetricsResponseT = z.infer<typeof MetricsResponse>
export type MetricsRowT = z.infer<typeof MetricsRow>
export type BreakerStateT = z.infer<typeof BreakerState>
export type OverrideT = z.infer<typeof Override>
export type ProposalT = z.infer<typeof Proposal>
export type LearningT = z.infer<typeof Learning>
export type LearningInputT = z.infer<typeof LearningInput>

// TODO: Move these types to @shared when parallel branch lands
export type AccountPolicy = "round_robin" | "least_used" | "priority"
export type CloudAccount = {
  id: string
  label: string
  keyMasked: string
  enabled: boolean
  usageToday: number
  dailyLimit: number | null
  runningCount: number
  concurrentLimit: number | null
  sourceCount: number
  sourceStatus: "ok" | "no_source_access"
  lastUsed: string | null
}
export type CloudSource = {
  id: string
  repo: string
  accounts: string[]
  defaultBranch: string
  branches: string[]
}
export type CloudSchedule = {
  id: string
  label: string
  schedule: string
  source: string
  nextRun: string | null
  lastRun: string | null
  lastResult: "success" | "failed" | null
  enabled: boolean
}
export type CloudSession = {
  id: string
  state: "running" | "completed" | "failed"
  title: string
  branch: string
  pullRequestLink: string | null
  localJobId: string | null
}
export type CloudActivity = {
  id: string
  ts: string
  message: string
}

/** Minimal shape badges.ts needs — a subset of the live query caches. */
export type DerivedState = {
  agents: AgentRow[]
  jobs: Job[]
  events: HubEventT[]
  config: ConfigResponseT | null | undefined
  proposals?: ProposalT[]
  learnings?: LearningT[]
  lastSeenTimelineTs?: string | null
}

export type Connection = "connecting" | "live" | "reconnecting" | "offline"
