import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { HistorySearch, type HistorySearchT } from "@/routes/search"
import { qk } from "@/lib/query-keys"
import type { Job } from "@/lib/types"
import { HistoryView } from "./index"

const MOCK_JOBS: Job[] = [
  {
    jobId: "job-failed-1",
    agent: "agy",
    model: "gemini-3.8-flash-high",
    title: "failed-build-task",
    cwd: "/home/user/project",
    mode: "read",
    status: "failed",
    errorKind: "worktree_denied",
    error: "worktree denied access to secret.txt",
    readModeViolation: "read-mode job modified files: secret.txt",
    timeoutS: 600,
    timeoutSource: "adaptive",
    sessionId: "sess-failed-1",
    parentJobId: "job-parent-001",
    turnDepth: 2,
    tokens: 4500,
    costUsd: 0.015,
    learningIds: ["learn-1", "learn-2"],
    createdAt: "2026-09-15T02:00:00.000Z",
    updatedAt: "2026-09-15T02:05:00.000Z",
  },
  {
    jobId: "job-succeeded-1",
    agent: "opencode",
    model: "opencode/mimo-v2.5-free",
    title: "succeeded-task",
    cwd: "/home/user/project",
    mode: "read",
    status: "succeeded",
    errorKind: null,
    error: null,
    timeoutS: 300,
    timeoutSource: "default",
    sessionId: "sess-succ-1",
    parentJobId: null,
    turnDepth: 0,
    tokens: 12000,
    costUsd: 0,
    createdAt: "2026-09-15T03:00:00.000Z",
    updatedAt: "2026-09-15T03:02:00.000Z",
  },
  {
    jobId: "job-canceled-1",
    agent: "copilot",
    model: "auto",
    title: "canceled-task",
    cwd: "/home/user/project",
    mode: "write",
    status: "canceled",
    errorKind: "canceled_by_user",
    error: null,
    timeoutS: null,
    sessionId: null,
    parentJobId: null,
    tokens: null,
    costUsd: null,
    createdAt: "2026-09-15T01:00:00.000Z",
    updatedAt: "2026-09-15T01:01:00.000Z",
  },
  {
    jobId: "job-running-1",
    agent: "agy",
    model: "gemini-3.8-flash-low",
    title: "running-non-terminal-task",
    cwd: "/home/user/project",
    mode: "read",
    status: "running",
    errorKind: null,
    error: null,
    timeoutS: 900,
    sessionId: null,
    parentJobId: null,
    tokens: null,
    costUsd: null,
    createdAt: "2026-09-15T04:00:00.000Z",
    updatedAt: "2026-09-15T04:01:00.000Z",
  },
]

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response)
}

function renderHistoryView(
  initialSearch: Partial<HistorySearchT> = {},
  jobs: Job[] = MOCK_JOBS
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })

  queryClient.setQueryData(qk.state, {
    agents: [],
    jobs,
    subagents: [],
    events: [],
  })

  const searchParams = new URLSearchParams()
  if (initialSearch.status) searchParams.set("status", initialSearch.status)
  if (initialSearch.agent) searchParams.set("agent", initialSearch.agent)
  if (initialSearch.q) searchParams.set("q", initialSearch.q)
  const qs = searchParams.toString()
  const initialEntry = `/history${qs ? `?${qs}` : ""}`

  const rootRoute = createRootRoute()
  const historyRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/history",
    validateSearch: HistorySearch,
    component: HistoryView,
  })

  const routeTree = rootRoute.addChildren([historyRoute])
  const history = createMemoryHistory({ initialEntries: [initialEntry] })
  const router = createRouter({
    routeTree,
    history,
  }) as any

  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )

  return {
    ...utils,
    router,
    queryClient,
  }
}

describe("HistoryView", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes("/api/state")) {
          return jsonResponse({ agents: [], jobs: MOCK_JOBS, subagents: [], events: [] })
        }
        if (url.includes("/api/jobs/job-failed-1/result")) {
          return jsonResponse({
            text: "Line 1\nLine 2\nLine 3",
            truncated: true,
            tail: "Tail 1\nTail 2",
            tailTruncated: true,
            totalLines: 15,
            fullPath: "/path/to/result",
            tokens: 4500,
            costUsd: 0.015,
            sessionId: "sess-failed-1",
            status: "failed",
            errorKind: "worktree_denied",
          })
        }
        return jsonResponse({})
      })
    )
  })

  describe("status=failed filter", () => {
    it("renders only failed jobs when status=failed", async () => {
      renderHistoryView({ status: "failed" })

      await waitFor(() => {
        expect(screen.getByText("failed-build-task")).toBeTruthy()
      })

      // Succeeded and canceled jobs must not be in the table
      expect(screen.queryByText("succeeded-task")).toBeNull()
      expect(screen.queryByText("canceled-task")).toBeNull()
      expect(screen.queryByText("running-non-terminal-task")).toBeNull()
    })

    it("displays empty state 'No failed jobs' when no failed jobs exist", async () => {
      const succeededOnly = MOCK_JOBS.filter((j) => j.status === "succeeded")
      renderHistoryView({ status: "failed" }, succeededOnly)

      await waitFor(() => {
        expect(screen.getByText("No failed jobs")).toBeTruthy()
      })
    })
  })

  describe("q filter", () => {
    it("filters jobs by title", async () => {
      renderHistoryView({ q: "succeeded-task" })

      await waitFor(() => {
        expect(screen.getByText("succeeded-task")).toBeTruthy()
      })
      expect(screen.queryByText("failed-build-task")).toBeNull()
    })

    it("filters jobs by jobId", async () => {
      renderHistoryView({ q: "job-failed-1" })

      await waitFor(() => {
        expect(screen.getByText("failed-build-task")).toBeTruthy()
      })
      expect(screen.queryByText("succeeded-task")).toBeNull()
    })

    it("filters jobs by model", async () => {
      renderHistoryView({ q: "mimo-v2.5" })

      await waitFor(() => {
        expect(screen.getByText("succeeded-task")).toBeTruthy()
      })
      expect(screen.queryByText("failed-build-task")).toBeNull()
    })

    it("filters jobs by error", async () => {
      renderHistoryView({ q: "secret.txt" })

      await waitFor(() => {
        expect(screen.getByText("failed-build-task")).toBeTruthy()
      })
      expect(screen.queryByText("succeeded-task")).toBeNull()
    })

    it("shows empty state 'No matching jobs' when no jobs match q", async () => {
      renderHistoryView({ q: "nonexistent-query-string" })

      await waitFor(() => {
        expect(screen.getByText("No matching jobs")).toBeTruthy()
      })
    })
  })

  describe("reply-of hint", () => {
    it("renders reply-of hint when parentJobId is present", async () => {
      renderHistoryView()

      await waitFor(() => {
        expect(screen.getByText("failed-build-task")).toBeTruthy()
      })

      expect(screen.getByText(/reply of …rent-001/)).toBeTruthy()
      expect(screen.getByTitle("Reply to job job-parent-001")).toBeTruthy()
    })
  })

  describe("readModeViolation alert and Sheet detail", () => {
    it("opens Sheet on row click, displays readModeViolation Alert and record fields", async () => {
      renderHistoryView()

      await waitFor(() => {
        expect(screen.getByText("failed-build-task")).toBeTruthy()
      })

      // Click the failed job row
      fireEvent.click(screen.getByText("failed-build-task"))

      // Sheet opens and displays readModeViolation Alert
      await waitFor(() => {
        expect(screen.getByText("Read-mode violation")).toBeTruthy()
        expect(screen.getByText("read-mode job modified files: secret.txt")).toBeTruthy()
      })

      // Check full record fields
      expect(screen.getByText("worktree denied access to secret.txt")).toBeTruthy()
      expect(screen.getByText("sess-failed-1")).toBeTruthy()
      expect(screen.getByText("job-parent-001")).toBeTruthy()
      expect(screen.getByText("learn-1, learn-2")).toBeTruthy()
      expect(screen.getByText("600s (adaptive)")).toBeTruthy()

      // Result section displays with lines omitted marker
      await waitFor(() => {
        // totalLines 15 - 3 head lines - 2 tail lines = 10 lines omitted
        expect(screen.getByText("… 10 lines omitted …")).toBeTruthy()
        expect(screen.getByText(/Line 1/)).toBeTruthy()
        expect(screen.getByText(/Tail 1/)).toBeTruthy()
      })
    })

    it("clicking parentJobId link in the Sheet updates search q", async () => {
      const { router } = renderHistoryView()

      await waitFor(() => {
        expect(screen.getByText("failed-build-task")).toBeTruthy()
      })

      fireEvent.click(screen.getByText("failed-build-task"))

      await waitFor(() => {
        expect(screen.getByText("job-parent-001")).toBeTruthy()
      })

      const parentBtn = screen.getByRole("button", { name: "job-parent-001" })
      fireEvent.click(parentBtn)

      await waitFor(() => {
        const search = router.state.location.search as HistorySearchT
        expect(search.q).toBe("job-parent-001")
      })
    })
  })
})
