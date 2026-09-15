import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router"
import { AgentsSearch, HistorySearch, ConfigSearch, ApprovalsSearch } from "@/routes/search"
import { OverviewView } from "./index"

import stateFixture from "../../../../test/fixtures/v2/state.json"
import configFixture from "../../../../test/fixtures/v2/config.json"
import proposalsFixture from "../../../../test/fixtures/v2/proposals.json"
import learningsFixture from "../../../../test/fixtures/v2/learnings.json"

function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response)
}

function errorResponse(status = 500, message = "Internal Server Error") {
  return Promise.resolve({
    ok: false,
    status,
    text: () => Promise.resolve(JSON.stringify({ error: message })),
  } as Response)
}

function createTestRouter() {
  const root = createRootRoute({ component: () => <Outlet /> })
  const overviewRoute = createRoute({
    getParentRoute: () => root,
    path: "/overview",
    component: OverviewView,
  })
  const agentsRoute = createRoute({
    getParentRoute: () => root,
    path: "/agents",
    validateSearch: AgentsSearch,
    component: () => null,
  })
  const jobsRoute = createRoute({
    getParentRoute: () => root,
    path: "/jobs",
    component: () => null,
  })
  const historyRoute = createRoute({
    getParentRoute: () => root,
    path: "/history",
    validateSearch: HistorySearch,
    component: () => null,
  })
  const approvalsRoute = createRoute({
    getParentRoute: () => root,
    path: "/approvals",
    validateSearch: ApprovalsSearch,
    component: () => null,
  })
  const configRoute = createRoute({
    getParentRoute: () => root,
    path: "/config",
    validateSearch: ConfigSearch,
    component: () => null,
  })

  const routeTree = root.addChildren([
    overviewRoute,
    agentsRoute,
    jobsRoute,
    historyRoute,
    approvalsRoute,
    configRoute,
  ])

  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/overview"] }),
  })
}

function renderOverview({
  state = stateFixture,
  config = configFixture,
  proposals = proposalsFixture,
  learnings = learningsFixture,
  shouldFail = false,
} = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (shouldFail) return errorResponse(500, "Network error")
      const url = String(input)
      if (url.includes("/api/state")) return jsonResponse(state)
      if (url.includes("/api/config")) return jsonResponse(config)
      if (url.includes("/api/proposals")) return jsonResponse(proposals)
      if (url.includes("/api/learnings")) return jsonResponse(learnings)
      return jsonResponse({})
    })
  )

  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  })

  const router = createTestRouter()

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
}

describe("OverviewView", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-09-15T04:00:00.000Z").getTime())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders KPI values from fixture data", async () => {
    renderOverview()

    await waitFor(() => {
      expect(screen.getByText("Agents healthy")).toBeTruthy()
    })

    expect(screen.getByText("11 / 11")).toBeTruthy()
    expect(screen.getByText("Running jobs")).toBeTruthy()
    expect(screen.getByText("Failed last 24h")).toBeTruthy()
    expect(screen.getByText("Breakers open")).toBeTruthy()
    expect(screen.getByText("Holds")).toBeTruthy()
    expect(screen.getByText("Unresolved CLIs")).toBeTruthy()
    expect(screen.getByText("Pending approvals")).toBeTruthy()

    const runningCard = screen.getByText("Running jobs").closest("a")
    expect(runningCard?.textContent).toContain("0")

    const failedCard = screen.getByText("Failed last 24h").closest("a")
    expect(failedCard?.textContent).toContain("1")

    const breakerCard = screen.getByText("Breakers open").closest("a")
    expect(breakerCard?.textContent).toContain("0")

    const holdCard = screen.getByText("Holds").closest("a")
    expect(holdCard?.textContent).toContain("0")

    const unresolvedCard = screen.getByText("Unresolved CLIs").closest("a")
    expect(unresolvedCard?.textContent).toContain("0")

    const approvalsCard = screen.getByText("Pending approvals").closest("a")
    expect(approvalsCard?.textContent).toContain("2")
  })

  it("links have the right hrefs", async () => {
    renderOverview()

    await waitFor(() => {
      expect(screen.getByText("Agents healthy")).toBeTruthy()
    })

    const agentsLink = screen.getByText("Agents healthy").closest("a")
    expect(agentsLink?.getAttribute("href")).toContain("/agents?filter=unhealthy")

    const jobsLink = screen.getByText("Running jobs").closest("a")
    expect(jobsLink?.getAttribute("href")).toBe("/jobs")

    const historyLink = screen.getByText("Failed last 24h").closest("a")
    expect(historyLink?.getAttribute("href")).toContain("/history?status=failed")

    const breakerLink = screen.getByText("Breakers open").closest("a")
    expect(breakerLink?.getAttribute("href")).toContain("/agents?filter=breaker")

    const holdsLink = screen.getByText("Holds").closest("a")
    expect(holdsLink?.getAttribute("href")).toContain("/agents?filter=held")

    const unresolvedLink = screen.getByText("Unresolved CLIs").closest("a")
    expect(unresolvedLink?.getAttribute("href")).toContain("/config?section=process")

    const approvalsLink = screen.getByText("Pending approvals").closest("a")
    expect(approvalsLink?.getAttribute("href")).toContain("/approvals")
  })

  it("attention list shows failed job and pending approvals from fixtures", async () => {
    renderOverview()

    const attentionSection = await waitFor(() => {
      const section = screen.getByRole("region", { name: "Needs attention" })
      expect(within(section).getByText("agy-task-3")).toBeTruthy()
      return section
    })

    expect(within(attentionSection).getByText("worktree_denied")).toBeTruthy()
  })

  it("attention list shows empty state 'All clear' when healthy", async () => {
    const cleanState = {
      ...stateFixture,
      agents: stateFixture.agents.map((a) => ({ ...a, status: "ready" })),
      jobs: stateFixture.jobs.filter((j) => j.status === "succeeded"),
    }
    const cleanConfig = {
      ...configFixture,
      breakerState: [],
      overrides: {},
    }
    const cleanProposals = { version: 1, proposals: [] }
    const cleanLearnings = { version: 1, learnings: [] }

    renderOverview({
      state: cleanState,
      config: cleanConfig,
      proposals: cleanProposals,
      learnings: cleanLearnings,
    })

    const attentionSection = await waitFor(() => {
      const section = screen.getByRole("region", { name: "Needs attention" })
      expect(within(section).getByText("All clear")).toBeTruthy()
      return section
    })

    expect(within(attentionSection).queryByText("agy-task-3")).toBeNull()
  })

  it("renders recent activity with last 10 events", async () => {
    renderOverview()

    await waitFor(() => {
      expect(screen.getAllByText("job.failed").length).toBeGreaterThan(0)
    })

    expect(screen.getAllByText("preflight").length).toBeGreaterThan(0)
    expect(screen.getAllByText("job.canceled").length).toBeGreaterThan(0)
  })

  it("renders alert when a query fails", async () => {
    renderOverview({ shouldFail: true })

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy()
    })
  })
})
