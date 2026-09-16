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
  CloudAccountsResponse,
  CloudAccountRow,
  CloudSourcesResponse,
  CloudSchedulesResponse,
  CloudScheduleRow,
  CloudSessionsResponse,
  CloudSessionRow,
  CloudActivitiesResponse,
  CloudSourceCacheEntry,
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

/**
 * Cloud view types, inferred from the shared server contracts (@shared ==
 * ../src/schemas.mjs) — the real /api/accounts, /api/sources, /api/schedules
 * and /api/cloud/* response shapes, never hand-redeclared.
 */
export type AccountPolicy = "round_robin" | "least_used" | "priority"

export type CloudAccountsResponseT = z.infer<typeof CloudAccountsResponse>
export type CloudAccount = z.infer<typeof CloudAccountRow>
/** Fields the create/edit forms may send; `id` and server-computed fields are never client-writable. */
export type CloudAccountInput = { label?: string | null; apiKey?: string; dailyLimit?: number; concurrentLimit?: number }
export type CloudAccountPatch = Partial<Pick<CloudAccount, "label" | "enabled" | "priority" | "dailyLimit" | "concurrentLimit">> & {
  apiKey?: string
}
export type CloudSourceCacheEntryT = z.infer<typeof CloudSourceCacheEntry>

export type CloudSourcesResponseT = z.infer<typeof CloudSourcesResponse>
export type CloudSource = CloudSourcesResponseT["sources"][number]
export type CloudSourceAccountSummary = CloudSourcesResponseT["accounts"][number]

/**
 * `schedule` on the wire is a permissive passthrough object (src/schemas.mjs)
 * because the server owns validation (src/schedules.mjs); this narrower
 * union is only for building the create/edit form, and every value of it is
 * still a valid `schedule` on the wire.
 */
export type CloudScheduleSpec = { kind: "interval"; everyMinutes: number } | { kind: "daily"; at: string; weekdays: number[] }

export type CloudSchedulesResponseT = z.infer<typeof CloudSchedulesResponse>
export type CloudSchedule = z.infer<typeof CloudScheduleRow>
export type CloudScheduleInput = {
  label?: string | null
  schedule: CloudScheduleSpec
  prompt: string
  source: string
  startingBranch?: string | null
  automationMode?: string | null
  requirePlanApproval?: boolean
  accountId?: string | null
  enabled?: boolean
}
export type CloudSchedulePatch = Partial<Omit<CloudScheduleInput, "schedule">> & { schedule?: CloudScheduleSpec }

export type CloudSessionsResponseT = z.infer<typeof CloudSessionsResponse>
export type CloudSession = z.infer<typeof CloudSessionRow>

export type CloudActivitiesResponseT = z.infer<typeof CloudActivitiesResponse>

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
