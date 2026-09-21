import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import App from "./App"
import { VIEW_META } from "./lib/nav"

class NoopEventSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  readyState = NoopEventSource.CONNECTING
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  onerror: (() => void) | null = null
  close() {}
}

const CONFIG_RESPONSE = {
  delegationMap: {},
  discovery: {},
  timeouts: {},
  breaker: { windowMs: 60000, failureThreshold: 3, failureKinds: [], immediateKinds: [] },
  ttlMs: 60000,
  agentHubHome: "/home/test/.local/share/agent-hub",
  writeAllowlist: [],
  breakerState: [],
  overrides: {},
  process: { pid: 1, nodeVersion: "v22.0.0", platform: "linux", pathEntries: [], resolvedBins: {} },
}

const STATE_RESPONSE = { agents: [], jobs: [], subagents: [], events: [] }
const METRICS_RESPONSE = { generatedAt: "2024-01-01T00:00:00.000Z", groupBy: [], rows: [] }

function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response)
}

describe("App shell", () => {
  beforeEach(() => {
    // @ts-expect-error test double
    globalThis.EventSource = NoopEventSource

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes("/api/state")) return jsonResponse(STATE_RESPONSE)
        if (url.includes("/api/config")) return jsonResponse(CONFIG_RESPONSE)
        if (url.includes("/api/metrics")) return jsonResponse(METRICS_RESPONSE)
        if (url.includes("/api/proposals")) return jsonResponse({ proposals: [] })
        if (url.includes("/api/learnings")) return jsonResponse({ learnings: [] })
        return jsonResponse({})
      })
    )
  })

  it("renders the sidebar with every nav group's labels and lands on Overview", async () => {
    render(<App />)

    await waitFor(() => expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy())

    // Nav groups
    expect(screen.getAllByText("Operations").length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText("Agents & Topology")).toBeTruthy()
    expect(screen.getByText("System")).toBeTruthy()

    // Nav item labels
    expect(screen.getByText("Agents")).toBeTruthy()
    expect(screen.getByText("Running jobs")).toBeTruthy()
    expect(screen.getByText("Job history")).toBeTruthy()
    expect(screen.getByText("Metrics")).toBeTruthy()
    expect(screen.getByText("Subagents")).toBeTruthy()
    expect(screen.getByText("Execution Tree")).toBeTruthy()
    expect(screen.getByText("Worktree Map")).toBeTruthy()
    expect(screen.getByText("Timeline")).toBeTruthy()
    expect(screen.getByText("Approvals")).toBeTruthy()
    expect(screen.getByText("Cloud")).toBeTruthy()
    expect(screen.getByText("Settings")).toBeTruthy()

    // Nav tips render (e.g. PageHeader subtitle on Overview and sidebar link titles)
    expect(screen.getAllByText(VIEW_META.overview.tip).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByTitle(VIEW_META.agents.tip)).toBeTruthy()

    // The default route ('/' -> '/overview') rendered the Overview view.
    await waitFor(() => expect(screen.getAllByText("Coming soon").length).toBeGreaterThan(0))
  })
})
