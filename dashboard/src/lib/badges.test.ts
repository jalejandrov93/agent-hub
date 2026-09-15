import { describe, expect, it } from "vitest"
import {
  unhealthyAgentCount,
  runningJobCount,
  failedLast24hCount,
  openBreakerCount,
  unresolvedAgents,
  unseenTimelineCount,
  errorKindSeverity,
  pendingApprovalsCount,
} from "./badges"
import type { DerivedState, AgentRow, Job } from "./types"

function agent(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    agent: "agy",
    model: "gemini-3.8-flash-low",
    status: "ready",
    reason: null,
    ladderLevel: "L1",
    checkedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    jobId: "j1",
    agent: "agy",
    model: "gemini-3.8-flash-low",
    title: null,
    cwd: "/tmp",
    mode: "read",
    status: "queued",
    errorKind: null,
    error: null,
    variant: null,
    sessionId: null,
    parentJobId: null,
    tokens: null,
    costUsd: null,
    timeoutS: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function baseState(overrides: Partial<DerivedState> = {}): DerivedState {
  return {
    agents: [],
    jobs: [],
    events: [],
    config: null,
    ...overrides,
  }
}

describe("unhealthyAgentCount", () => {
  it("counts degraded and unavailable rows", () => {
    const state = baseState({
      agents: [agent({ status: "ready" }), agent({ status: "degraded" }), agent({ status: "unavailable" })],
    })
    expect(unhealthyAgentCount(state)).toBe(2)
  })

  it("counts a held override as unhealthy even when status is ready", () => {
    const state = baseState({
      agents: [agent({ status: "ready" })],
      config: {
        overrides: { "agy:gemini-3.8-flash-low": { hold: true, setAt: "2024-01-01T00:00:00.000Z" } },
      } as unknown as DerivedState["config"],
    })
    expect(unhealthyAgentCount(state)).toBe(1)
  })
})

describe("runningJobCount", () => {
  it("counts queued and running jobs only", () => {
    const state = baseState({
      jobs: [job({ status: "queued" }), job({ status: "running" }), job({ status: "succeeded" })],
    })
    expect(runningJobCount(state)).toBe(2)
  })
})

describe("failedLast24hCount", () => {
  it("counts only failures within the last 24h window", () => {
    const now = new Date("2024-01-02T00:00:00.000Z").getTime()
    const state = baseState({
      jobs: [
        job({ status: "failed", updatedAt: "2024-01-01T12:00:00.000Z" }),
        job({ status: "failed", updatedAt: "2023-12-30T00:00:00.000Z" }),
        job({ status: "succeeded", updatedAt: "2024-01-01T12:00:00.000Z" }),
      ],
    })
    expect(failedLast24hCount(state, now)).toBe(1)
  })
})

describe("openBreakerCount", () => {
  it("counts breaker entries with open === true", () => {
    const state = baseState({
      config: {
        breakerState: [
          { agent: "agy", model: "m1", open: true, failureCount: 3, lastFailureAt: null },
          { agent: "agy", model: "m2", open: false, failureCount: 0, lastFailureAt: null },
        ],
      } as unknown as DerivedState["config"],
    })
    expect(openBreakerCount(state)).toBe(1)
  })
})

describe("unresolvedAgents", () => {
  it("lists agents with a null resolvedBins entry", () => {
    const state = baseState({
      config: {
        process: { resolvedBins: { agy: "/usr/bin/agy", opencode: null } },
      } as unknown as DerivedState["config"],
    })
    expect(unresolvedAgents(state)).toEqual(["opencode"])
  })
})

describe("unseenTimelineCount", () => {
  it("counts every event when nothing has been seen yet", () => {
    const state = baseState({
      events: [{ ts: "2024-01-01T00:00:00.000Z", source: "hub", kind: "job.queued" }] as DerivedState["events"],
    })
    expect(unseenTimelineCount(state)).toBe(1)
  })

  it("counts only events newer than lastSeenTimelineTs", () => {
    const state = baseState({
      events: [
        { ts: "2024-01-01T00:00:00.000Z", source: "hub", kind: "job.queued" },
        { ts: "2024-01-02T00:00:00.000Z", source: "hub", kind: "job.finished" },
      ] as DerivedState["events"],
      lastSeenTimelineTs: "2024-01-01T00:00:00.000Z",
    })
    expect(unseenTimelineCount(state)).toBe(1)
  })
})

describe("pendingApprovalsCount", () => {
  it("sums pending proposals and pending learnings", () => {
    const state = baseState({
      proposals: [{ status: "pending" }, { status: "accepted" }] as DerivedState["proposals"],
      learnings: [{ status: "pending" }, { status: "pending" }] as DerivedState["learnings"],
    })
    expect(pendingApprovalsCount(state)).toBe(3)
  })
})

describe("errorKindSeverity", () => {
  it("maps the same severities as the legacy ERROR_KIND_SEVERITY table", () => {
    expect(errorKindSeverity("billing")).toBe("destructive")
    expect(errorKindSeverity("quota")).toBe("warning")
    expect(errorKindSeverity("orphaned")).toBe("muted")
  })

  it("falls back to warning for an unknown kind, and muted for none", () => {
    expect(errorKindSeverity("some_future_kind")).toBe("warning")
    expect(errorKindSeverity(null)).toBe("muted")
  })
})
