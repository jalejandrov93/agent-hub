import { beforeEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { ApprovalsSearch } from "@/routes/search"
import { ApprovalsView } from "./index"

const api = vi.hoisted(() => ({
  getProposals: vi.fn(),
  getLearnings: vi.fn(),
  getConfig: vi.fn(),
  refreshProposals: vi.fn(),
  decideProposal: vi.fn(),
  decideLearning: vi.fn(),
  deleteLearning: vi.fn(),
  createLearning: vi.fn(),
}))

vi.mock("@/lib/api", () => api)

const CONFIG = {
  delegationMap: {},
  discovery: {
    agy: { agent: "agy", cmd: null, binPath: null, version: null, models: [], checkedAt: null, error: null },
    opencode: {
      agent: "opencode",
      cmd: null,
      binPath: null,
      version: null,
      models: [],
      checkedAt: null,
      error: null,
    },
  },
  timeouts: {},
  breaker: { windowMs: 60000, failureThreshold: 3, failureKinds: [], immediateKinds: [] },
  ttlMs: 60000,
  agentHubHome: "/tmp",
  writeAllowlist: [],
  breakerState: [],
  overrides: {},
  process: { pid: 1, nodeVersion: "v22", platform: "linux", pathEntries: [], resolvedBins: {} },
}

const PENDING_PROPOSAL = {
  id: "prop-1",
  taskType: "recon",
  chainHash: "abc",
  fromOrder: [
    { agent: "agy", model: "gemini-3.8-flash-low" },
    { agent: "opencode", model: "opencode/muse-spark" },
  ],
  toOrder: [
    { agent: "opencode", model: "opencode/muse-spark" },
    { agent: "agy", model: "gemini-3.8-flash-low" },
  ],
  evidence: {
    "agy:gemini-3.8-flash-low": {
      samples: 14,
      successRate: 0.57,
      wilsonLow: 0.33,
      wilsonHigh: 0.78,
      p50Ms: 36000,
    },
    "opencode:opencode/muse-spark": {
      samples: 18,
      successRate: 1,
      wilsonLow: 0.82,
      wilsonHigh: 1,
      p50Ms: 95000,
    },
  },
  reason: "PROPOSAL_REASON_PENDING",
  status: "pending",
  createdAt: "2026-09-15T04:00:00.000Z",
  decidedAt: null,
}

const REJECTED_PROPOSAL = {
  ...PENDING_PROPOSAL,
  id: "prop-2",
  reason: "PROPOSAL_REASON_REJECTED",
  status: "rejected",
  createdAt: "2026-09-01T04:00:00.000Z",
  decidedAt: "2026-09-02T04:00:00.000Z",
}

const PENDING_LEARNING = {
  id: "learn-pending",
  agent: "agy",
  model: null,
  taskType: "recon",
  text: "PENDING_MARKER",
  status: "pending",
  source: "dashboard",
  sourceJobId: null,
  createdAt: "2026-09-01T04:00:00.000Z",
  decidedAt: null,
}

const APPROVED_LEARNING = {
  id: "learn-approved",
  agent: "opencode",
  model: "opencode/muse-spark",
  taskType: null,
  text: "APPROVED_MARKER",
  status: "approved",
  source: "mcp",
  sourceJobId: null,
  createdAt: "2026-09-15T04:00:00.000Z",
  decidedAt: "2026-09-16T04:00:00.000Z",
}

function renderApprovals(initialEntry = "/approvals") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute()
  const approvalsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/approvals",
    validateSearch: ApprovalsSearch,
    component: ApprovalsView,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([approvalsRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return { ...utils, router, queryClient }
}

describe("ApprovalsView", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    api.getConfig.mockResolvedValue(CONFIG)
    api.getProposals.mockResolvedValue({ proposals: [PENDING_PROPOSAL, REJECTED_PROPOSAL] })
    api.getLearnings.mockResolvedValue({ learnings: [APPROVED_LEARNING, PENDING_LEARNING] })
    api.refreshProposals.mockResolvedValue({ proposals: [] })
    api.decideProposal.mockResolvedValue(PENDING_PROPOSAL)
    api.decideLearning.mockResolvedValue(PENDING_LEARNING)
    api.deleteLearning.mockResolvedValue({ deleted: true })
    api.createLearning.mockResolvedValue(PENDING_LEARNING)
  })

  it("reads the active tab from the search param", async () => {
    renderApprovals("/approvals?tab=learnings")

    expect(await screen.findByText("PENDING_MARKER")).toBeTruthy()
    expect(screen.queryByText("PROPOSAL_REASON_PENDING")).toBeNull()
    expect(screen.getByText("Propose a learning")).toBeTruthy()
  })

  it("shows proposals by default", async () => {
    renderApprovals("/approvals")

    expect(await screen.findByText("PROPOSAL_REASON_PENDING")).toBeTruthy()
    expect(screen.queryByText("Propose a learning")).toBeNull()
  })

  it("requires confirmation before accepting a proposal", async () => {
    renderApprovals("/approvals")
    await screen.findByText("PROPOSAL_REASON_PENDING")

    fireEvent.click(screen.getByRole("button", { name: "Accept" }))

    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText(/route\(\) will use this order/i)).toBeTruthy()
    expect(api.decideProposal).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole("button", { name: /accept/i }))

    await waitFor(() =>
      expect(api.decideProposal).toHaveBeenCalledWith("prop-1", "accept")
    )
  })

  it("renders proposal evidence with success rate, Wilson bounds and p50", async () => {
    renderApprovals("/approvals")
    await screen.findByText("PROPOSAL_REASON_PENDING")

    expect(screen.getByText("agy:gemini-3.8-flash-low")).toBeTruthy()
    expect(screen.getByText("57%")).toBeTruthy()
    expect(screen.getByText("33%–78%")).toBeTruthy()
    expect(screen.getByText("36s")).toBeTruthy()
  })

  it("disables the learning form until text is entered and counts characters live", async () => {
    renderApprovals("/approvals?tab=learnings")
    await screen.findByText("PENDING_MARKER")

    const textarea = await screen.findByLabelText("Text")
    const submit = screen.getByRole("button", { name: /propose learning/i })

    expect((submit as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText("0/300")).toBeTruthy()

    fireEvent.change(textarea, { target: { value: "abc" } })

    expect(screen.getByText("3/300")).toBeTruthy()
    expect((submit as HTMLButtonElement).disabled).toBe(false)

    fireEvent.change(textarea, { target: { value: "" } })
    expect((submit as HTMLButtonElement).disabled).toBe(true)
  })

  it("lists pending learnings before decided ones", async () => {
    renderApprovals("/approvals?tab=learnings")
    await screen.findByText("PENDING_MARKER")

    const rows = screen.getAllByRole("row")
    expect(within(rows[1]).getByText("PENDING_MARKER")).toBeTruthy()
  })
})
