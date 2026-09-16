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
  QuotaWindow,
  QuotaInfo,
  AgentQuotaRow,
  AgentsQuotaResponse,
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
export type QuotaWindowT = z.infer<typeof QuotaWindow>
export type QuotaInfoT = z.infer<typeof QuotaInfo>
export type AgentQuotaRowT = z.infer<typeof AgentQuotaRow>
export type AgentsQuotaResponseT = z.infer<typeof AgentsQuotaResponse>
export type OverrideT = z.infer<typeof Override>
export type ProposalT = z.infer<typeof Proposal>
export type LearningT = z.infer<typeof Learning>
export type LearningInputT = z.infer<typeof LearningInput>

/** Minimal shape badges.ts needs — a subset of the live query caches. */
export type DerivedState = {
  agents: AgentRow[]
  jobs: Job[]
  events: HubEventT[]
  config: ConfigResponseT | null | undefined
  proposals?: ProposalT[]
  learnings?: LearningT[]
  lastSeenTimelineTs?: string | null
  quota?: AgentQuotaRowT[]
}

export type Connection = "connecting" | "live" | "reconnecting" | "offline"
