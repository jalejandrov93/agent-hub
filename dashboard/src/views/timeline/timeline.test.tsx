import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { mergeTimelineEvents, matchesFilters } from "./events"
import { TimelineView } from "./index"
import type { HubEventT } from "@/lib/types"
import * as queries from "@/lib/queries"
import * as sse from "@/lib/sse"
import * as timelineSeen from "@/lib/timeline-seen"

// Mock router navigation and search
let mockSearchState: { source: string; q: string } = { source: "", q: "" }
const mockNavigate = vi.fn((opts: { to?: string; search?: (prev: any) => any; replace?: boolean }) => {
  if (typeof opts.search === "function") {
    mockSearchState = opts.search(mockSearchState)
  }
  return Promise.resolve()
})

vi.mock("@tanstack/react-router", () => ({
  useSearch: () => mockSearchState,
  useNavigate: () => mockNavigate,
  Link: ({ children, to, search, className }: any) => {
    const qStr = search?.q ? `?q=${search.q}` : ""
    return (
      <a href={`${to}${qStr}`} className={className} data-testid="job-link">
        {children}
      </a>
    )
  },
}))

describe("Timeline pure logic (events.ts)", () => {
  const baseEvent: HubEventT = {
    ts: "2026-09-13T10:00:00.000Z",
    source: "hub",
    kind: "job.started",
    agent: "agy",
    model: "gemini-3.8-flash-high",
    title: "Test Job",
    summary: "Job description",
    jobId: "job-100",
    cwd: "/home/user",
    errorKind: null,
    taskType: "code",
    tokens: 1000,
    costUsd: 0.01,
  }

  describe("dedupe of the same event from state + SSE", () => {
    it("deduplicates identical events with same ts + kind + jobId", () => {
      const serverEvents: HubEventT[] = [baseEvent]
      const sseEvents: HubEventT[] = [
        { ...baseEvent, summary: "Updated from SSE" },
      ]

      const merged = mergeTimelineEvents(serverEvents, sseEvents)
      expect(merged).toHaveLength(1)
      expect(merged[0].summary).toBe("Updated from SSE")
    })

    it("orders events newest first", () => {
      const e1: HubEventT = { ...baseEvent, ts: "2026-09-13T10:00:00.000Z", jobId: "1" }
      const e2: HubEventT = { ...baseEvent, ts: "2026-09-13T12:00:00.000Z", jobId: "2" }
      const e3: HubEventT = { ...baseEvent, ts: "2026-09-13T11:00:00.000Z", jobId: "3" }

      const merged = mergeTimelineEvents([e1, e3], [e2])
      expect(merged.map((e) => e.jobId)).toEqual(["2", "3", "1"])
    })

    it("caps results at 200 events", () => {
      const manyEvents: HubEventT[] = Array.from({ length: 250 }, (_, i) => ({
        ...baseEvent,
        ts: new Date(Date.now() - i * 1000).toISOString(),
        jobId: `job-${i}`,
      }))

      const merged = mergeTimelineEvents(manyEvents, [])
      expect(merged).toHaveLength(200)
    })
  })

  describe("filters by source and q", () => {
    it("filters by source (all, hub, claude-hook)", () => {
      const hubEvent: HubEventT = { ...baseEvent, source: "hub" }
      const hookEvent: HubEventT = { ...baseEvent, source: "claude-hook" }

      expect(matchesFilters(hubEvent, { source: "all" })).toBe(true)
      expect(matchesFilters(hubEvent, { source: "" })).toBe(true)
      expect(matchesFilters(hubEvent, { source: "hub" })).toBe(true)
      expect(matchesFilters(hubEvent, { source: "claude-hook" })).toBe(false)

      expect(matchesFilters(hookEvent, { source: "claude-hook" })).toBe(true)
      expect(matchesFilters(hookEvent, { source: "hub" })).toBe(false)
    })

    it("filters by kind prefix and exact kinds", () => {
      const jobEvent: HubEventT = { ...baseEvent, kind: "job.finished" }
      const preflightEvent: HubEventT = { ...baseEvent, kind: "preflight" }
      const subagentEvent: HubEventT = { ...baseEvent, kind: "subagent.start" }
      const proposalEvent: HubEventT = { ...baseEvent, kind: "proposal.created" }
      const learningEvent: HubEventT = { ...baseEvent, kind: "learning.proposed" }

      expect(matchesFilters(jobEvent, { kind: "job.*" })).toBe(true)
      expect(matchesFilters(preflightEvent, { kind: "job.*" })).toBe(false)
      expect(matchesFilters(preflightEvent, { kind: "preflight" })).toBe(true)
      expect(matchesFilters(subagentEvent, { kind: "subagent.*" })).toBe(true)
      expect(matchesFilters(proposalEvent, { kind: "proposal.*" })).toBe(true)
      expect(matchesFilters(learningEvent, { kind: "learning.*" })).toBe(true)
      expect(matchesFilters(jobEvent, { kind: "all" })).toBe(true)
    })

    it("matches q across title, summary, agent, model, and jobId", () => {
      const e: HubEventT = {
        ...baseEvent,
        title: "Unique Title",
        summary: "Special explanation",
        agent: "my-agent",
        model: "gpt-4o",
        jobId: "special-job-123",
      }

      expect(matchesFilters(e, { q: "unique" })).toBe(true)
      expect(matchesFilters(e, { q: "special explanation" })).toBe(true)
      expect(matchesFilters(e, { q: "my-agent" })).toBe(true)
      expect(matchesFilters(e, { q: "gpt-4o" })).toBe(true)
      expect(matchesFilters(e, { q: "special-job-123" })).toBe(true)
      expect(matchesFilters(e, { q: "nonexistent" })).toBe(false)
    })
  })
})

describe("TimelineView component", () => {
  const markSeenMock = vi.fn()
  const sampleEvents: HubEventT[] = [
    {
      ts: "2026-09-13T12:00:00.000Z",
      source: "hub",
      kind: "job.finished",
      agent: "opencode",
      model: "claude-3-5-sonnet",
      title: "Finished job run",
      summary: "Completed successfully with all tests green and build ready.",
      jobId: "job-abc-123",
      cwd: "/repo",
      errorKind: null,
      taskType: "code",
      tokens: 4500,
      costUsd: 0.05,
    },
    {
      ts: "2026-09-13T11:00:00.000Z",
      source: "claude-hook",
      kind: "subagent.start",
      agent: "claude",
      model: null,
      title: "Hook subagent dispatch",
      summary: "Spawned subagent for code review",
      jobId: null,
      cwd: "/repo",
      errorKind: null,
      taskType: null,
      tokens: null,
      costUsd: null,
    },
    {
      ts: "2026-09-13T10:00:00.000Z",
      source: "hub",
      kind: "job.failed",
      agent: "agy",
      model: "gemini-3.8-flash-high",
      title: "Failed job run",
      summary: "Failed due to auth expiration",
      jobId: "job-fail-999",
      cwd: "/repo",
      errorKind: "auth",
      taskType: "code",
      tokens: 500,
      costUsd: 0.001,
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mockSearchState = { source: "", q: "" }

    vi.spyOn(queries, "useStateQuery").mockReturnValue({
      data: {
        agents: [],
        jobs: [],
        subagents: [],
        events: sampleEvents,
      },
      isLoading: false,
      isError: false,
    } as any)

    vi.spyOn(sse, "useConnection").mockReturnValue({
      connection: "live",
      events: [],
    })

    vi.spyOn(timelineSeen, "useTimelineSeen").mockReturnValue([
      null,
      markSeenMock,
    ])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("marks seen on mount with newest event ts", async () => {
    render(<TimelineView />)

    await waitFor(() => {
      expect(markSeenMock).toHaveBeenCalledWith("2026-09-13T12:00:00.000Z")
    })
  })

  it("marks seen when newer event arrives while mounted", async () => {
    const { rerender } = render(<TimelineView />)
    expect(markSeenMock).toHaveBeenCalledWith("2026-09-13T12:00:00.000Z")

    // Simulate SSE buffer receiving a newer event
    const newerEvent: HubEventT = {
      ts: "2026-09-13T13:00:00.000Z",
      source: "hub",
      kind: "job.started",
      agent: "agy",
      model: "gemini-3.8-flash-high",
      title: "Brand new event",
      summary: "Just started",
      jobId: "job-new-1",
      cwd: "/repo",
      errorKind: null,
      taskType: null,
      tokens: null,
      costUsd: null,
    }

    vi.spyOn(sse, "useConnection").mockReturnValue({
      connection: "live",
      events: [newerEvent],
    })

    rerender(<TimelineView />)

    await waitFor(() => {
      expect(markSeenMock).toHaveBeenCalledWith("2026-09-13T13:00:00.000Z")
    })
  })

  it("renders event details including kind badge, title, agent/model, jobId link, and errorKind", () => {
    render(<TimelineView />)

    expect(screen.getByText("Finished job run")).toBeTruthy()
    expect(screen.getByText("Hook subagent dispatch")).toBeTruthy()
    expect(screen.getByText("Failed job run")).toBeTruthy()

    // Agent and humanized model
    expect(screen.getByText("opencode / Sonnet 3.5")).toBeTruthy()

    // StatusBadge for errorKind="auth"
    expect(screen.getByText("auth")).toBeTruthy()

    // Link to jobId
    const jobLink = screen.getByRole("link", { name: "job-abc-123" })
    expect(jobLink).toBeTruthy()
    expect(jobLink.getAttribute("href")).toBe("/history?q=job-abc-123")
  })

  it("filters events by source when search params change", () => {
    mockSearchState = { source: "claude-hook", q: "" }
    render(<TimelineView />)

    expect(screen.getByText("Hook subagent dispatch")).toBeTruthy()
    expect(screen.queryByText("Finished job run")).toBeNull()
    expect(screen.queryByText("Failed job run")).toBeNull()
  })

  it("filters events by q when search params change", () => {
    mockSearchState = { source: "", q: "job-fail-999" }
    render(<TimelineView />)

    expect(screen.getByText("Failed job run")).toBeTruthy()
    expect(screen.queryByText("Finished job run")).toBeNull()
    expect(screen.queryByText("Hook subagent dispatch")).toBeNull()
  })

  it("renders empty state when no events match active filters", () => {
    mockSearchState = { source: "", q: "non-existent-search-term" }
    render(<TimelineView />)

    expect(screen.getByText("No matching events found")).toBeTruthy()
  })

  it("updates search params on search input typing", () => {
    render(<TimelineView />)

    const searchInput = screen.getByLabelText("Search timeline")
    fireEvent.change(searchInput, { target: { value: "test" } })

    expect(mockNavigate).toHaveBeenCalled()
  })

  it("carries min-w-0 on list root and row content containers to prevent overflow", () => {
    const { container } = render(<TimelineView />)

    const listRoot = container.querySelector('[data-slot="timeline-list"]')
    expect(listRoot).toBeTruthy()
    expect(listRoot?.className).toContain("min-w-0")

    const rowRoot = container.querySelector('[data-slot="timeline-row"]')
    expect(rowRoot).toBeTruthy()
    expect(rowRoot?.className).toContain("min-w-0")

    const rowContent = container.querySelector('[data-slot="timeline-content"]')
    expect(rowContent).toBeTruthy()
    expect(rowContent?.className).toContain("min-w-0")
  })
})
