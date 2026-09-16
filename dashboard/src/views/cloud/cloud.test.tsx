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

const ACCOUNT = {
  id: "acc-1",
  label: "My Account",
  keyMasked: "sk-***1234",
  enabled: true,
  usageToday: 15,
  dailyLimit: 100,
  runningCount: 2,
  concurrentLimit: 5,
  sourceCount: 3,
  sourceStatus: "ok",
  lastUsed: "2026-09-15T04:00:00.000Z",
}

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
    api.getAccounts.mockResolvedValue({ accounts: [ACCOUNT] })
    api.getSources.mockResolvedValue({ sources: [] })
    api.getSchedules.mockResolvedValue({ schedules: [] })
    api.getCloudSessions.mockResolvedValue({ sessions: [] })

    // Default resolves for mutations to prevent unhandled promise rejections
    api.createAccount.mockResolvedValue(ACCOUNT)
    api.updateAccount.mockResolvedValue(ACCOUNT)
    api.deleteAccount.mockResolvedValue({ deleted: true })
    api.setAccountPolicy.mockResolvedValue({ policy: "round_robin" })
    api.refreshAccountSources.mockResolvedValue({ success: true })
  })

  describe("Layout and Navigation", () => {
    it("renders the Accounts tab by default", async () => {
      renderCloud()
      expect(await screen.findByText("My Account")).toBeTruthy()
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
      await screen.findByText("My Account")
      expect(screen.getByText("sk-***1234")).toBeTruthy()
      expect(screen.getByText("15 / 100")).toBeTruthy()
      expect(screen.getByText("2 / 5")).toBeTruthy()
    })

    it("disables add account form until valid", async () => {
      renderCloud()
      await screen.findByText("My Account")

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
          key: "key-123"
        }))
      })
    })

    it("asks for confirmation before deleting", async () => {
      renderCloud()
      await screen.findByText("My Account")

      const deleteButton = screen.getByRole("button", { name: "Delete account" })
      fireEvent.click(deleteButton)

      const dialog = await screen.findByRole("alertdialog")
      expect(within(dialog).getByText(/Are you sure you want to delete My Account/)).toBeTruthy()

      expect(api.deleteAccount).not.toHaveBeenCalled()

      const confirmButton = within(dialog).getByRole("button", { name: /delete/i })
      fireEvent.click(confirmButton)

      await waitFor(() => {
        expect(api.deleteAccount).toHaveBeenCalledWith("acc-1")
      })
    })
  })

  describe("Sources Tab", () => {
    it("renders sources with default branch and list of branches", async () => {
      api.getSources.mockResolvedValueOnce({
        sources: [
          {
            id: "repo-1",
            repo: "org/repo1",
            accounts: ["acc-1"],
            defaultBranch: "main",
            branches: ["main", "dev"]
          }
        ]
      })
      renderCloud("/cloud?tab=sources")
      await screen.findByText("org/repo1")
      expect(screen.getByText("main")).toBeTruthy()
      expect(screen.getByText("main, dev")).toBeTruthy()
      expect(screen.getByText("My Account")).toBeTruthy()
    })

    it("displays an alert for accounts without source access", async () => {
      api.getAccounts.mockResolvedValueOnce({
        accounts: [{ ...ACCOUNT, id: "acc-no-access", label: "No Access Acc", sourceStatus: "no_source_access" }]
      })
      renderCloud("/cloud?tab=sources")
      await screen.findByText(/The following accounts are healthy but cannot list sources/)
      expect(screen.getByText(/No Access Acc/)).toBeTruthy()
    })
  })

  describe("Schedules Tab", () => {
    it("renders schedules and handles run now", async () => {
      api.getSchedules.mockResolvedValueOnce({
        schedules: [
          {
            id: "sched-1",
            label: "Daily Task",
            schedule: "daily at 10:00",
            source: "org/repo",
            nextRun: "2026-09-16T10:00:00.000Z",
            lastRun: null,
            lastResult: null,
            enabled: true
          }
        ]
      })
      renderCloud("/cloud?tab=schedules")
      await screen.findByText("Daily Task")
      expect(screen.getByText("daily at 10:00")).toBeTruthy()

      const runNowBtn = screen.getByRole("button", { name: "Run now" })
      fireEvent.click(runNowBtn)
      await waitFor(() => expect(api.runScheduleNow).toHaveBeenCalledWith("sched-1"))
    })
  })

  describe("Sessions Tab", () => {
    it("renders sessions and opens activity sheet on click", async () => {
      api.getCloudSessions.mockResolvedValueOnce({
        sessions: [
          {
            id: "sess-1",
            state: "running",
            title: "Task #1",
            branch: "feat-branch",
            pullRequestLink: "https://github.com/org/repo/pull/1",
            localJobId: null
          }
        ]
      })
      api.getCloudJobActivities.mockResolvedValueOnce({
        activities: [{ id: "act-1", ts: "2026-09-15T04:00:00.000Z", message: "Starting..." }]
      })

      renderCloud("/cloud?tab=sessions")
      await screen.findByText("Task #1")

      fireEvent.click(screen.getByText("Task #1"))

      await screen.findByText("Session Activities")
      await screen.findByText("Starting...")
    })
  })
})
