/**
 * Typed fetch layer over the dashboard server's JSON API. Every response is
 * parsed with a zod schema from @shared, so a shape drift between server and
 * client fails loudly (as a thrown ApiError) instead of silently rendering
 * `undefined`. Every write sends `Content-Type: application/json` — the
 * server's CSRF guard (dashboard.mjs) requires it on every non-GET request.
 */
import { z } from "zod"
import {
  StateResponse,
  ConfigResponse,
  MetricsResponse,
  Proposal,
  Learning,
  LearningInput,
  AgentStatusRow,
} from "@shared"
import type {
  StateResponseT,
  ConfigResponseT,
  MetricsResponseT,
  ProposalT,
  LearningT,
  LearningInputT,
  AgentRow,
  CloudAccount,
  CloudSource,
  AccountPolicy,
  CloudSchedule,
  CloudSession,
  CloudActivity,
} from "./types"

// TODO: Remove these local schemas once they are available in @shared
const CloudAccountSchema = z.object({
  id: z.string(),
  label: z.string(),
  keyMasked: z.string(),
  enabled: z.boolean(),
  usageToday: z.number(),
  dailyLimit: z.number().nullable(),
  runningCount: z.number(),
  concurrentLimit: z.number().nullable(),
  sourceCount: z.number(),
  sourceStatus: z.enum(["ok", "no_source_access"]),
  lastUsed: z.string().nullable(),
})

const CloudSourceSchema = z.object({
  id: z.string(),
  repo: z.string(),
  accounts: z.array(z.string()),
  defaultBranch: z.string(),
  branches: z.array(z.string()),
})

const CloudScheduleSchema = z.object({
  id: z.string(),
  label: z.string(),
  schedule: z.string(),
  source: z.string(),
  nextRun: z.string().nullable(),
  lastRun: z.string().nullable(),
  lastResult: z.enum(["success", "failed"]).nullable(),
  enabled: z.boolean(),
})

const CloudSessionSchema = z.object({
  id: z.string(),
  state: z.enum(["running", "completed", "failed"]),
  title: z.string(),
  branch: z.string(),
  pullRequestLink: z.string().nullable(),
  localJobId: z.string().nullable(),
})

const CloudActivitySchema = z.object({
  id: z.string(),
  ts: z.string(),
  message: z.string(),
})

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.status = status
  }
}

/** GET/POST/DELETE and parse the JSON body with `schema`. Throws ApiError on any non-2xx status. */
export async function fetchJson<S extends z.ZodTypeAny>(
  schema: S,
  url: string,
  init?: RequestInit
): Promise<z.infer<S>> {
  const response = await fetch(url, init)
  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }

  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body && typeof (body as { error: unknown }).error === "string"
        ? (body as { error: string }).error
        : `request to ${url} failed with status ${response.status}`
    throw new ApiError(message, response.status)
  }

  return schema.parse(body)
}

function writeInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }
}

export function getState(): Promise<StateResponseT> {
  return fetchJson(StateResponse, "/api/state")
}

export function getConfig(): Promise<ConfigResponseT> {
  return fetchJson(ConfigResponse, "/api/config")
}

export function getMetrics(): Promise<MetricsResponseT> {
  return fetchJson(MetricsResponse, "/api/metrics")
}

const ProposalsPayload = z.object({ proposals: z.array(Proposal) })
export function getProposals(): Promise<{ proposals: ProposalT[] }> {
  return fetchJson(ProposalsPayload, "/api/proposals")
}

export function refreshProposals(): Promise<{ proposals: ProposalT[] }> {
  return fetchJson(ProposalsPayload, "/api/proposals/refresh", writeInit("POST"))
}

export function decideProposal(id: string, decision: "accept" | "reject"): Promise<ProposalT> {
  return fetchJson(Proposal, `/api/proposals/${encodeURIComponent(id)}/${decision}`, writeInit("POST"))
}

const LearningsPayload = z.object({ learnings: z.array(Learning) })
export function getLearnings(): Promise<{ learnings: LearningT[] }> {
  return fetchJson(LearningsPayload, "/api/learnings")
}

export function decideLearning(id: string, decision: "approve" | "reject"): Promise<LearningT> {
  return fetchJson(Learning, `/api/learnings/${encodeURIComponent(id)}/${decision}`, writeInit("POST"))
}

export function deleteLearning(id: string): Promise<{ deleted: true }> {
  return fetchJson(
    z.object({ deleted: z.literal(true) }),
    `/api/learnings/${encodeURIComponent(id)}`,
    writeInit("DELETE")
  )
}

export function createLearning(input: LearningInputT): Promise<LearningT> {
  const parsed = LearningInput.parse(input)
  return fetchJson(Learning, "/api/learnings", writeInit("POST", parsed))
}

const RefreshAgentsPayload = z.object({ results: z.array(AgentStatusRow) })
export function refreshAgents(params: { agent?: string; model?: string; ping?: boolean }): Promise<{
  results: AgentRow[]
}> {
  return fetchJson(RefreshAgentsPayload, "/api/agents/refresh", writeInit("POST", params))
}

export function refreshDiscovery(): Promise<Record<string, unknown>> {
  return fetchJson(z.record(z.string(), z.unknown()), "/api/discovery/refresh", writeInit("POST"))
}

export function setOverride(params: {
  agent: string
  model: string
  hold?: boolean
  breakerReset?: boolean
  reason?: string
}): Promise<unknown> {
  return fetchJson(z.unknown(), "/api/overrides", writeInit("POST", params))
}

export function clearOverride(agent: string, model: string): Promise<unknown> {
  return fetchJson(
    z.unknown(),
    `/api/overrides/${encodeURIComponent(agent)}/${encodeURIComponent(model)}`,
    writeInit("DELETE")
  )
}

export function cancelJob(jobId: string): Promise<unknown> {
  return fetchJson(z.unknown(), `/api/jobs/${encodeURIComponent(jobId)}/cancel`, writeInit("POST"))
}

export function getAccounts(): Promise<{ accounts: CloudAccount[] }> {
  return fetchJson(z.object({ accounts: z.array(CloudAccountSchema) }), "/api/accounts")
}

export function createAccount(data: { label: string; key: string; concurrentLimit?: number; dailyLimit?: number }): Promise<CloudAccount> {
  return fetchJson(CloudAccountSchema, "/api/accounts", writeInit("POST", data))
}

export function updateAccount(id: string, data: Partial<CloudAccount>): Promise<CloudAccount> {
  return fetchJson(CloudAccountSchema, `/api/accounts/${encodeURIComponent(id)}`, writeInit("PATCH", data))
}

export function deleteAccount(id: string): Promise<{ deleted: true }> {
  return fetchJson(z.object({ deleted: z.literal(true) }), `/api/accounts/${encodeURIComponent(id)}`, writeInit("DELETE"))
}

export function setAccountPolicy(policy: AccountPolicy): Promise<{ policy: AccountPolicy }> {
  return fetchJson(z.object({ policy: z.enum(["round_robin", "least_used", "priority"]) }), "/api/accounts/policy", writeInit("PUT", { policy }))
}

export function refreshAccountSources(id: string): Promise<{ success: boolean }> {
  return fetchJson(z.object({ success: z.boolean() }), `/api/accounts/${encodeURIComponent(id)}/refresh-sources`, writeInit("POST"))
}

export function getSources(): Promise<{ sources: CloudSource[] }> {
  return fetchJson(z.object({ sources: z.array(CloudSourceSchema) }), "/api/sources")
}

export function getSchedules(): Promise<{ schedules: CloudSchedule[] }> {
  return fetchJson(z.object({ schedules: z.array(CloudScheduleSchema) }), "/api/schedules")
}

export function createSchedule(data: { label: string; schedule: string; source: string; enabled?: boolean }): Promise<CloudSchedule> {
  return fetchJson(CloudScheduleSchema, "/api/schedules", writeInit("POST", data))
}

export function updateSchedule(id: string, data: Partial<CloudSchedule>): Promise<CloudSchedule> {
  return fetchJson(CloudScheduleSchema, `/api/schedules/${encodeURIComponent(id)}`, writeInit("PATCH", data))
}

export function deleteSchedule(id: string): Promise<{ deleted: true }> {
  return fetchJson(z.object({ deleted: z.literal(true) }), `/api/schedules/${encodeURIComponent(id)}`, writeInit("DELETE"))
}

export function runScheduleNow(id: string): Promise<{ success: boolean }> {
  return fetchJson(z.object({ success: z.boolean() }), `/api/schedules/${encodeURIComponent(id)}/run-now`, writeInit("POST"))
}

export function getCloudSessions(): Promise<{ sessions: CloudSession[] }> {
  return fetchJson(z.object({ sessions: z.array(CloudSessionSchema) }), "/api/cloud/sessions")
}

export function checkCloudJob(id: string): Promise<{ success: boolean }> {
  return fetchJson(z.object({ success: z.boolean() }), `/api/cloud/jobs/${encodeURIComponent(id)}/check`, writeInit("POST"))
}

export function getCloudJobActivities(id: string): Promise<{ activities: CloudActivity[] }> {
  return fetchJson(z.object({ activities: z.array(CloudActivitySchema) }), `/api/cloud/jobs/${encodeURIComponent(id)}/activities`)
}
