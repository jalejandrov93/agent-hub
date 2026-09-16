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
import {
  CloudAccountsResponse,
  CloudAccountRow,
  CloudSourcesResponse,
  CloudSchedulesResponse,
  CloudScheduleRow,
  CloudSessionsResponse,
  CloudActivitiesResponse,
} from "@shared"
import { CloudSearch } from "@/routes/search"
import { CloudView } from "./index"

const api = vi.hoisted(() => ({
  getAccounts: vi.fn(),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteAccount: vi.fn(),
  setAccountPolicy: vi.fn(),
  refreshAccountSources: vi.fn(),
  getSources: vi.fn(),
  getSchedules: vi.fn(),
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  deleteSchedule: vi.fn(),
  runScheduleNow: vi.fn(),
  getCloudSessions: vi.fn(),
  checkCloudJob: vi.fn(),
  getCloudJobActivities: vi.fn(),
}))

vi.mock("@/lib/api", () => api)

// Every fixture below is the REAL server shape (see src/dashboard.mjs and the
// GET /api/accounts, /api/sources, /api/schedules, /api/cloud/sessions
// samples in the task that produced this fix), and is parsed with the same
// shared zod schema the frontend imports from @shared before it is used as a
// mock response. A fixture that drifted from the server contract would throw
// here, in this test file, instead of only failing silently against the real
// server.
const ACCOUNT = CloudAccountRow.parse({
  id: "acct-f133f644",
  label: "pro-1",
  enabled: true,
  priority: 0,
  dailyLimit: 100,
  concurrentLimit: 15,
  lastUsedAt: null,
  createdAt: "2026-09-16T12:58:52.210Z",
  updatedAt: "2026-09-16T12:58:52.210Z",
  keyPresent: true,
  keyLast4: "1111",
  usage: { running: 1, last24h: 1 },
  sourcesStatus: "ok",
  sourcesFetchedAt: "2026-09-16T12:00:00Z",
})

const ACCOUNTS_RESPONSE = CloudAccountsResponse.parse({ policy: "round_robin", accounts: [ACCOUNT] })

const SOURCES_RESPONSE = CloudSourcesResponse.parse({
  sources: [
    {
      name: "sources/github/org/repo1",
      owner: "org",
      repo: "repo1",
      defaultBranch: "main",
      branches: ["main", "dev"],
      accounts: [{ accountId: ACCOUNT.id, status: "ok" }],
    },
  ],
  accounts: [{ accountId: ACCOUNT.id, label: ACCOUNT.label, status: "ok", fetchedAt: "2026-09-16T12:00:00Z" }],
})

const SCHEDULE = CloudScheduleRow.parse({
  id: "sched-233a1e0b",
  label: "nightly",
  enabled: true,
  schedule: { kind: "daily", at: "02:00", weekdays: [1, 2, 3, 4, 5] },
  prompt: "p",
  source: "sources/github/acme/widgets",
  startingBranch: null,
  automationMode: "AUTO_CREATE_PR",
  requirePlanApproval: false,
  accountId: null,
  lastRunAt: null,
  lastJobId: null,
  lastStatus: null,
  nextRunAt: "2026-09-17T07:00:00.000Z",
  createdAt: "2026-09-16T12:00:00.000Z",
  updatedAt: "2026-09-16T12:00:00.000Z",
  lastResult: null,
})

const SCHEDULES_RESPONSE = CloudSchedulesResponse.parse({ schedules: [SCHEDULE] })

const SESSIONS_RESPONSE = CloudSessionsResponse.parse({
  sessions: [
    {
      sessionId: "s-1",
      title: "Fix the thing",
      state: "IN_PROGRESS",
      prUrl: null,
      branch: null,
      sessionUrl: "https://jules.google.com/session/s-1",
      createTime: "2026-09-16T11:00:00Z",
      jobId: "2026-09-16T12-58-52-216Z-c5c08d3d",
      accountId: ACCOUNT.id,
    },
  ],
  accountErrors: [],
})

const ACTIVITIES_RESPONSE = CloudActivitiesResponse.parse({ activities: ["[jules] started", "[jules] planning"] })

function renderCloud(initialEntry = "/cloud") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute()
  const cloudRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/cloud",
    validateSearch: CloudSearch,
    component: CloudView,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([cloudRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  )
  return { ...utils, router, queryClient }
}

describe("CloudView", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset()
    api.getAccounts.mockResolvedValue(ACCOUNTS_RESPONSE)
    api.getSources.mockResolvedValue({ sources: [], accounts: [] })
    api.getSchedules.mockResolvedValue({ schedules: [] })
    api.getCloudSessions.mockResolvedValue({ sessions: [] })

    // Default resolves for mutations to prevent unhandled promise rejections
    api.createAccount.mockResolvedValue(ACCOUNT)
    api.updateAccount.mockResolvedValue(ACCOUNT)
    api.deleteAccount.mockResolvedValue({ deleted: true })
    api.setAccountPolicy.mockResolvedValue({ policy: "round_robin" })
    api.refreshAccountSources.mockResolvedValue({ fetchedAt: "2026-09-16T12:00:00Z", status: "ok", sources: [] })
  })

  describe("Layout and Navigation", () => {
    it("renders the Accounts tab by default", async () => {
      renderCloud()
      expect(await screen.findByText("pro-1")).toBeTruthy()
      expect(screen.getByText("Add account")).toBeTruthy()
    })

    it("can navigate to Sources tab via search params", async () => {
      renderCloud("/cloud?tab=sources")
      expect(await screen.findByText(/Repositories are connected/)).toBeTruthy()
    })
  })

  describe("Accounts Tab", () => {
    it("renders account rows correctly", async () => {
      renderCloud()
      await screen.findByText("pro-1")
      expect(screen.getByText("••••1111")).toBeTruthy()
      expect(screen.getByText("1 / 100")).toBeTruthy()
      expect(screen.getByText("1 / 15")).toBeTruthy()
    })

    it("disables add account form until valid", async () => {
      renderCloud()
      await screen.findByText("pro-1")

      fireEvent.click(screen.getByRole("button", { name: "Add account" }))
      const dialog = await screen.findByRole("dialog")

      const submit = within(dialog).getByRole("button", { name: "Add" })
      expect((submit as HTMLButtonElement).disabled).toBe(true)

      const labelInput = await screen.findByLabelText("Label")
      const keyInput = await screen.findByLabelText("API Key")

      fireEvent.change(labelInput, { target: { value: "New Acc" } })
      expect((submit as HTMLButtonElement).disabled).toBe(true)

      fireEvent.change(keyInput, { target: { value: "key-123" } })
      expect((submit as HTMLButtonElement).disabled).toBe(false)

      fireEvent.click(submit)
      await waitFor(() => {
        expect(api.createAccount).toHaveBeenCalledWith(expect.objectContaining({
          label: "New Acc",
          apiKey: "key-123"
        }))
      })
    })

    it("asks for confirmation before deleting", async () => {
      renderCloud()
      await screen.findByText("pro-1")

      const deleteButton = screen.getByRole("button", { name: "Delete account" })
      fireEvent.click(deleteButton)

      const dialog = await screen.findByRole("alertdialog")
      expect(within(dialog).getByText(/Are you sure you want to delete pro-1/)).toBeTruthy()

      expect(api.deleteAccount).not.toHaveBeenCalled()

      const confirmButton = within(dialog).getByRole("button", { name: /delete/i })
      fireEvent.click(confirmButton)

      await waitFor(() => {
        expect(api.deleteAccount).toHaveBeenCalledWith(ACCOUNT.id)
      })
    })
  })

  describe("Sources Tab", () => {
    it("renders sources with default branch and list of branches", async () => {
      api.getSources.mockResolvedValueOnce(SOURCES_RESPONSE)
      renderCloud("/cloud?tab=sources")
      await screen.findByText("org/repo1")
      expect(screen.getByText("main")).toBeTruthy()
      expect(screen.getByText("main, dev")).toBeTruthy()
      expect(screen.getByText("pro-1")).toBeTruthy()
    })

    it("displays an alert for accounts without source access", async () => {
      api.getAccounts.mockResolvedValueOnce(
        CloudAccountsResponse.parse({
          policy: "round_robin",
          accounts: [{ ...ACCOUNT, id: "acct-no-access", label: "No Access Acc", sourcesStatus: "no_source_access" }],
        })
      )
      renderCloud("/cloud?tab=sources")
      await screen.findByText(/The following accounts are healthy but cannot list sources/)
      expect(screen.getByText(/No Access Acc/)).toBeTruthy()
    })
  })

  describe("Schedules Tab", () => {
    it("renders schedules and handles run now", async () => {
      api.getSchedules.mockResolvedValueOnce(SCHEDULES_RESPONSE)
      renderCloud("/cloud?tab=schedules")
      await screen.findByText("nightly")
      expect(screen.getByText("Daily at 02:00 on Mon–Fri")).toBeTruthy()

      const runNowBtn = screen.getByRole("button", { name: "Run now" })
      fireEvent.click(runNowBtn)
      await waitFor(() => expect(api.runScheduleNow).toHaveBeenCalledWith("sched-233a1e0b"))
    })
  })

  describe("Sessions Tab", () => {
    it("renders sessions and opens activity sheet on click", async () => {
      api.getCloudSessions.mockResolvedValueOnce(SESSIONS_RESPONSE)
      api.getCloudJobActivities.mockResolvedValueOnce(ACTIVITIES_RESPONSE)

      renderCloud("/cloud?tab=sessions")
      await screen.findByText("Fix the thing")

      fireEvent.click(screen.getByText("Fix the thing"))

      await screen.findByText("Session Activities")
      await screen.findByText("[jules] started")
    })
  })
})
