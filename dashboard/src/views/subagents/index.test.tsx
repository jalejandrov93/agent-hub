import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SubagentsView } from "./index"
import * as api from "@/lib/api"

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api")
  return {
    ...actual,
    getState: vi.fn(),
  }
})

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe("SubagentsView", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("renders empty state with a hint when there are no subagent events", async () => {
    vi.mocked(api.getState).mockResolvedValue({
      agents: [],
      jobs: [],
      events: [],
      subagents: [],
    })

    renderWithClient(<SubagentsView />)

    await waitFor(() => {
      expect(screen.getByText("No subagent activity recorded")).toBeTruthy()
    })
    expect(
      screen.getByText(/Claude Code.*hook/i)
    ).toBeTruthy()
  })

  it("pairs start/stop events by agentId into runs with duration, tokens, and cwd", async () => {
    const startTs = "2026-09-13T18:14:00.000Z"
    const stopTs = "2026-09-13T18:15:30.000Z"

    vi.mocked(api.getState).mockResolvedValue({
      agents: [],
      jobs: [],
      events: [],
      subagents: [
        {
          ts: startTs,
          source: "claude-hook",
          kind: "subagent.start",
          agent: "claude",
          agentId: "agent-1",
          sessionId: "sess-1",
          cwd: "/home/user/workspace/repo",
          title: "Refactor core loop",
        },
        {
          ts: stopTs,
          source: "claude-hook",
          kind: "subagent.stop",
          agent: "claude",
          agentId: "agent-1",
          sessionId: "sess-1",
          cwd: "/home/user/workspace/repo",
          title: "Refactor core loop",
          tokens: 4500,
        },
      ],
    })

    renderWithClient(<SubagentsView />)

    await waitFor(() => {
      expect(screen.getByText("Refactor core loop")).toBeTruthy()
    })

    expect(screen.getByText("claude")).toBeTruthy()
    // 90 seconds = 1m 30s
    expect(screen.getByText("1m 30s")).toBeTruthy()
    // 4500 tokens = 4.5k
    expect(screen.getByText("4.5k")).toBeTruthy()
    // CWD is rendered
    expect(screen.getByText("/home/user/workspace/repo")).toBeTruthy()
  })

  it("renders 'running' badge when there is no stop event yet", async () => {
    vi.mocked(api.getState).mockResolvedValue({
      agents: [],
      jobs: [],
      events: [],
      subagents: [
        {
          ts: new Date().toISOString(),
          source: "claude-hook",
          kind: "subagent.start",
          agent: "claude",
          agentId: "agent-running-1",
          sessionId: "sess-2",
          cwd: "/home/user/app",
          title: "Active exploration",
        },
      ],
    })

    renderWithClient(<SubagentsView />)

    await waitFor(() => {
      expect(screen.getByText("Active exploration")).toBeTruthy()
    })

    // Running badge should be displayed for the active run
    expect(screen.getByText("Running")).toBeTruthy()
  })

  it("renders summary cards: running now, finished in last 24h, and total tokens", async () => {
    const now = new Date()
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString()
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000).toISOString()

    vi.mocked(api.getState).mockResolvedValue({
      agents: [],
      jobs: [],
      events: [],
      subagents: [
        // Running run
        {
          ts: fiveMinutesAgo,
          source: "claude-hook",
          kind: "subagent.start",
          agent: "claude",
          agentId: "agent-live",
          title: "Live subagent",
          cwd: "/app",
        },
        // Finished run
        {
          ts: tenMinutesAgo,
          source: "claude-hook",
          kind: "subagent.start",
          agent: "claude",
          agentId: "agent-done",
          title: "Done subagent",
          cwd: "/app",
        },
        {
          ts: fiveMinutesAgo,
          source: "claude-hook",
          kind: "subagent.stop",
          agent: "claude",
          agentId: "agent-done",
          title: "Done subagent",
          cwd: "/app",
          tokens: 2500,
        },
      ],
    })

    renderWithClient(<SubagentsView />)

    await waitFor(() => {
      expect(screen.getByText("Live subagent")).toBeTruthy()
    })

    expect(screen.getByText("Running now")).toBeTruthy()
    expect(screen.getByText("Finished (last 24h)")).toBeTruthy()
    expect(screen.getByText("Total tokens (last 24h)")).toBeTruthy()
    expect(screen.getAllByText("2.5k").length).toBeGreaterThanOrEqual(1)
  })

  it("sorts runs newest first and opens detail sheet on row click", async () => {
    vi.mocked(api.getState).mockResolvedValue({
      agents: [],
      jobs: [],
      events: [],
      subagents: [
        {
          ts: "2026-09-13T10:00:00.000Z",
          source: "claude-hook",
          kind: "subagent.start",
          agent: "claude",
          agentId: "older-run",
          title: "Older run title",
          cwd: "/app/older",
        },
        {
          ts: "2026-09-13T12:00:00.000Z",
          source: "claude-hook",
          kind: "subagent.start",
          agent: "claude",
          agentId: "newer-run",
          title: "Newer run title",
          cwd: "/app/newer",
        },
      ],
    })

    renderWithClient(<SubagentsView />)

    await waitFor(() => {
      expect(screen.getByText("Newer run title")).toBeTruthy()
    })

    const rows = screen.getAllByRole("row")
    // Row 0 is header, Row 1 should be newer-run, Row 2 should be older-run
    expect(rows[1].textContent).toContain("Newer run title")
    expect(rows[2].textContent).toContain("Older run title")

    // Click on older run to open sheet
    rows[2].click()

    await waitFor(() => {
      expect(screen.getByText("Agent ID: older-run")).toBeTruthy()
      expect(screen.getAllByText("/app/older").length).toBeGreaterThanOrEqual(1)
    })
  })
})
