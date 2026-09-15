import { describe, expect, it, vi, beforeEach } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router"
import type { ConfigResponseT, ProposalT } from "@/lib/types"
import { ConfigSearch } from "@/routes/search"
import * as api from "@/lib/api"
import { ConfigView } from "./index"

const BASE_CONFIG: ConfigResponseT = {
  delegationMap: {
    recon: {
      why: "proven context compression, cheap refreshable quota",
      chain: [
        { agent: "agy", model: "gemini-3.8-flash-low", mode: "read" },
        { agent: "claude", model: "haiku" },
      ],
    },
    "adversarial-review": {
      why: "dual blind review off the Claude Code quota",
      chain: [
        {
          agent: "agy",
          model: "claude-sonnet-4-6",
          mode: "read",
          parallelWith: {
            agent: "copilot",
            model: "auto",
            mode: "read",
          },
        },
      ],
    },
  },
  discovery: {},
  timeouts: {
    agy: {
      "gemini-3.8-flash-low": 300,
    },
  },
  breaker: {
    windowMs: 1800000,
    failureThreshold: 2,
    failureKinds: ["quota", "canceled", "billing"],
    immediateKinds: ["billing"],
  },
  ttlMs: 900000,
  agentHubHome: "/home/user/.local/share/agent-hub",
  writeAllowlist: ["/worktree/one"],
  breakerState: [
    {
      agent: "agy",
      model: "gemini-3.8-flash-low",
      open: false,
      failureCount: 0,
      lastFailureAt: null,
    },
  ],
  overrides: {},
  process: {
    pid: 4242,
    nodeVersion: "v22.23.1",
    platform: "linux",
    pathEntries: ["/usr/local/bin", "/usr/bin"],
    resolvedBins: {
      agy: "/usr/local/bin/agy",
      copilot: "/usr/local/bin/copilot",
    },
  },
}

async function renderConfigView({
  initialSection = "delegation",
  config = BASE_CONFIG,
  proposals = [] as ProposalT[],
}: {
  initialSection?: string
  config?: ConfigResponseT
  proposals?: ProposalT[]
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: Infinity },
      mutations: { retry: false },
    },
  })

  queryClient.setQueryData(["config"], config)
  queryClient.setQueryData(["proposals"], { proposals })

  const rootRoute = createRootRoute()
  const configRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/config",
    validateSearch: ConfigSearch,
    component: ConfigView,
  })
  const approvalsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/approvals",
    component: () => <div>Approvals Page</div>,
  })

  const routeTree = rootRoute.addChildren([configRoute, approvalsRoute])
  const history = createMemoryHistory({
    initialEntries: [`/config?section=${initialSection}`],
  })

  const router = createRouter({
    routeTree,
    history,
  })

  await router.load()

  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    ),
    router,
    queryClient,
  }
}

describe("ConfigView", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify({})),
        } as Response)
      )
    )
  })

  it("tab from search param activates the specified section", async () => {
    await renderConfigView({ initialSection: "process" })

    // Process tab should be active and display process details
    expect(screen.getByText("4242")).toBeTruthy()
    expect(screen.getByText("v22.23.1")).toBeTruthy()
    expect(screen.getByText("linux")).toBeTruthy()
    expect(screen.getByText("Rediscover CLIs")).toBeTruthy()
  })

  it("unresolved CLI alert displays warning when CLI is resolved to null", async () => {
    const configWithUnresolved: ConfigResponseT = {
      ...BASE_CONFIG,
      process: {
        ...BASE_CONFIG.process,
        resolvedBins: {
          agy: "/usr/local/bin/agy",
          missingAgent: null,
        },
      },
    }

    await renderConfigView({ initialSection: "process", config: configWithUnresolved })

    // Warning alert should be shown
    const alert = screen.getByRole("alert")
    expect(alert).toBeTruthy()
    expect(alert.textContent).toMatch(/missingAgent/)
  })

  it("overrides empty state and clear confirm work as expected", async () => {
    // 1. Empty state when overrides is empty
    const { unmount } = await renderConfigView({
      initialSection: "overrides",
      config: { ...BASE_CONFIG, overrides: {} },
    })

    expect(screen.getByText(/No overrides set/i)).toBeTruthy()
    unmount()

    // 2. Table with clear button and ConfirmDialog when an override exists
    const clearSpy = vi.spyOn(api, "clearOverride").mockResolvedValue({ cleared: true })

    const configWithOverride: ConfigResponseT = {
      ...BASE_CONFIG,
      overrides: {
        "agy:gemini-3.8-flash-low": {
          hold: true,
          reason: "Manual hold test",
          setAt: "2026-09-15T00:00:00.000Z",
        },
      },
    }

    await renderConfigView({ initialSection: "overrides", config: configWithOverride })

    expect(screen.getByText("agy:gemini-3.8-flash-low")).toBeTruthy()
    expect(screen.getByText("Manual hold test")).toBeTruthy()

    const clearButton = screen.getByRole("button", { name: /clear/i })
    expect(clearButton).toBeTruthy()

    // Click Clear button to open ConfirmDialog
    fireEvent.click(clearButton)

    // ConfirmDialog should be visible
    expect(screen.getByRole("alertdialog")).toBeTruthy()
    expect(screen.getByText(/Clear override/i)).toBeTruthy()

    // Click confirm in dialog
    const confirmButton = screen.getByRole("button", { name: /^Clear$/i })
    fireEvent.click(confirmButton)

    await waitFor(() => {
      expect(clearSpy).toHaveBeenCalledWith("agy", "gemini-3.8-flash-low")
    })
  })

  it("delegation parallelWith rendering displays parallel agent and note", async () => {
    const acceptedProposal: ProposalT = {
      id: "prop-1",
      taskType: "recon",
      chainHash: "abc",
      fromOrder: [],
      toOrder: [],
      evidence: {},
      reason: "Performance improvement",
      status: "accepted",
      createdAt: "2026-09-14T00:00:00.000Z",
      decidedAt: "2026-09-14T01:00:00.000Z",
    }

    await renderConfigView({
      initialSection: "delegation",
      config: BASE_CONFIG,
      proposals: [acceptedProposal],
    })

    // Parallel with rendering check
    expect(screen.getByText(/parallel with/i)).toBeTruthy()
    expect(screen.getByText(/copilot/i)).toBeTruthy()

    // Claude Agent tool note check
    expect(screen.getByText(/Claude Agent tool/i)).toBeTruthy()

    // Reordered by proposal badge check
    const proposalBadge = screen.getByText(/reordered by proposal/i)
    expect(proposalBadge).toBeTruthy()
    const link = proposalBadge.closest("a")
    expect(link?.getAttribute("href")).toContain("/approvals?tab=proposals")
  })
})
