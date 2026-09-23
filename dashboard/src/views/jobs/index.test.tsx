import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import * as api from "@/lib/api"
import type { Job } from "@/lib/types"
import { JobsView } from "."

vi.mock("@/lib/api")

const JOB_DEFAULTS: Job = {
  jobId: "job-1",
  agent: "agy",
  model: "gemini-3.8-flash-medium",
  title: "running-task",
  cwd: "/home/user/project",
  mode: "read",
  status: "running",
  createdAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-01T00:00:05.000Z",
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return { ...JOB_DEFAULTS, ...overrides }
}

function stateWith(jobs: Job[]) {
  return { agents: [], jobs, subagents: [], events: [] }
}

const RESULT_RESPONSE = {
  text: "head line",
  truncated: true,
  tail: "tail line",
  totalLines: 100,
  tailTruncated: true,
  fullPath: "/home/user/.local/share/agent-hub/jobs/job-1/response.txt",
  tokens: null,
  costUsd: null,
  sessionId: "session-1",
  status: "running",
  errorKind: null,
}

// The empty state renders <Button render={<Link to="/history" />}>, and a
// TanStack Link crashes outside a router ("useLinkPropsFor" reads null state).
// JobsView itself never reads search params, so a minimal tree (root =
// JobsView, plus the /history target) is enough — same pattern as
// overview.test.tsx's createTestRouter.
function createTestRouter() {
  const root = createRootRoute({ component: JobsView })
  const historyRoute = createRoute({
    getParentRoute: () => root,
    path: "/history",
    component: () => null,
  })
  return createRouter({
    routeTree: root.addChildren([historyRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  })
}

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={createTestRouter()} />
    </QueryClientProvider>
  )
}

describe("JobsView", () => {
  beforeEach(() => {
    vi.mocked(api.getState).mockResolvedValue(stateWith([makeJob()]))
    vi.mocked(api.cancelJob).mockResolvedValue({})
    vi.mocked(api.fetchJson).mockResolvedValue(RESULT_RESPONSE)
    vi.mocked(api.getJobDiffStats).mockResolvedValue({ diffStats: null })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("renders only queued and running jobs", async () => {
    vi.mocked(api.getState).mockResolvedValue(
      stateWith([
        makeJob({ jobId: "j-run", title: "running-task", status: "running" }),
        makeJob({ jobId: "j-queued", title: "queued-task", status: "queued" }),
        makeJob({ jobId: "j-ok", title: "succeeded-task", status: "succeeded" }),
        makeJob({ jobId: "j-fail", title: "failed-task", status: "failed" }),
      ])
    )

    renderView()

    expect(await screen.findByText("running-task")).toBeTruthy()
    expect(screen.getByText("queued-task")).toBeTruthy()
    expect(screen.queryByText("succeeded-task")).toBeNull()
    expect(screen.queryByText("failed-task")).toBeNull()
  })

  // A Jules job runs against a GitHub source and has no local checkout. Three
  // such jobs with no cwd used to fail the shared schema and blank the view.
  it("renders a remote job that has no local cwd, showing its repository instead", async () => {
    vi.mocked(api.getState).mockResolvedValue(
      stateWith([
        makeJob({
          jobId: "j-jules",
          agent: "jules",
          model: "jules",
          title: "cloud-task",
          cwd: undefined,
          remote: { provider: "jules", sessionId: "2644030964203516032", source: "sources/github/acme/widgets" },
        }),
      ])
    )

    renderView()

    expect(await screen.findByText("cloud-task")).toBeTruthy()

    // Working dir is hidden by default; show it to inspect the location cell
    fireEvent.click(screen.getByRole("button", { name: "Choose visible columns" }))
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "Working dir" }))

    expect(screen.getAllByText("acme/widgets").length).toBeGreaterThan(0)
  })

  it("requires confirmation before canceling a job", async () => {
    renderView()

    await screen.findByText("running-task")
    const cancelBtn = screen.getByRole("button", { name: "Cancel" })

    // 1) A quick click/tap on the row control does NOT open the dialog and does NOT call api.cancelJob
    fireEvent.pointerDown(cancelBtn, { button: 0, isPrimary: true, pointerId: 1 })
    fireEvent.pointerUp(cancelBtn, { pointerId: 1 })
    fireEvent.click(cancelBtn)
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.queryByText("Cancel this job?")).toBeNull()
    expect(api.cancelJob).not.toHaveBeenCalled()

    // 2) A sustained hold OPENS the ConfirmDialog
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"],
    })
    try {
      fireEvent.pointerDown(cancelBtn, { button: 0, isPrimary: true, pointerId: 1 })
      act(() => {
        vi.advanceTimersByTime(2150)
      })
      // Base UI's AlertDialog renders role="alertdialog" (not "dialog") and
      // mounts its portal asynchronously; restore real timers first so
      // findByRole's polling works, then await the element like the
      // original test did.
      vi.useRealTimers()
      fireEvent.pointerUp(cancelBtn, { pointerId: 1 })
      expect(await screen.findByRole("alertdialog")).toBeTruthy()
      expect(screen.getByText("Cancel this job?")).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }

    // 3) Confirming in the dialog still calls api.cancelJob with "job-1"
    fireEvent.click(screen.getByRole("button", { name: "Cancel job" }))
    // React Query v5 calls mutationFn(variables, context); only the first arg is ours.
    await waitFor(() => expect(vi.mocked(api.cancelJob).mock.calls[0]?.[0]).toBe("job-1"))
  })

  it("supports keyboard hold to open confirmation dialog via Space", async () => {
    renderView()

    await screen.findByText("running-task")
    const cancelBtn = screen.getByRole("button", { name: "Cancel" })

    // 4) Keyboard path: focusable and keydown Space starts hold and reaches dialog
    cancelBtn.focus()
    expect(document.activeElement).toBe(cancelBtn)

    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"],
    })
    try {
      fireEvent.keyDown(cancelBtn, { key: " " })
      act(() => {
        vi.advanceTimersByTime(2150)
      })
      // Restore real timers before querying (see the comment in the test
      // above): the AlertDialog portal needs real-timer polling to appear,
      // and its role is "alertdialog".
      vi.useRealTimers()
      fireEvent.keyUp(cancelBtn, { key: " " })
      expect(await screen.findByRole("alertdialog")).toBeTruthy()
      expect(screen.getByText("Cancel this job?")).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }

    fireEvent.click(screen.getByRole("button", { name: "Cancel job" }))
    await waitFor(() => expect(vi.mocked(api.cancelJob).mock.calls[0]?.[0]).toBe("job-1"))
  })

  it("shows reply-of lineage and the omitted-lines marker in the detail sheet", async () => {
    vi.mocked(api.getState).mockResolvedValue(
      stateWith([
        makeJob({
          jobId: "job-1",
          title: "running-task",
          parentJobId: "2026-09-15T03-40-56-523Z-ee989b6e",
        }),
      ])
    )

    renderView()

    fireEvent.click(await screen.findByText("running-task"))

    expect(await screen.findByText(/reply of/i)).toBeTruthy()
    expect(await screen.findByText(/lines omitted/)).toBeTruthy()
    expect(screen.getByText("tail line")).toBeTruthy()
  })

  it("shows diff stats and the per-file table in the detail dialog for a write-mode job", async () => {
    vi.mocked(api.getState).mockResolvedValue(
      stateWith([makeJob({ jobId: "job-1", title: "running-task", mode: "write" })])
    )
    vi.mocked(api.getJobDiffStats).mockResolvedValue({
      diffStats: {
        baseCommit: "abc123",
        additions: 4,
        deletions: 1,
        filesChanged: 1,
        files: [{ path: "src/a.ts", additions: 4, deletions: 1, binary: false }],
        truncated: false,
        computedAt: "2020-01-01T00:00:00.000Z",
        error: null,
      },
    })

    renderView()

    fireEvent.click(await screen.findByText("running-task"))

    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText("+4")).toBeTruthy()
    expect(within(dialog).getByText("src/a.ts")).toBeTruthy()
  })

  it("opens the job detail dialog on row click and closes it", async () => {
    renderView()

    fireEvent.click(await screen.findByText("running-task"))

    const dialog = await screen.findByRole("dialog")
    expect(dialog).toBeTruthy()
    expect(dialog.getAttribute("data-slot")).toBe("dialog-content")
    expect(within(dialog).getByText("running-task")).toBeTruthy()

    fireEvent.click(within(dialog).getByRole("button", { name: /close/i }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("renders the 'Awaiting feedback' badge when remote.state is AWAITING_USER_FEEDBACK", async () => {
    vi.mocked(api.getState).mockResolvedValue(
      stateWith([
        makeJob({
          jobId: "j-awaiting",
          title: "awaiting-task",
          status: "running",
          remote: { provider: "jules", sessionId: "sess-awaiting", state: "AWAITING_USER_FEEDBACK" },
        }),
      ])
    )

    renderView()

    expect(await screen.findByText("Awaiting feedback")).toBeTruthy()
  })

  it("does not render 'Awaiting feedback' for a running job without a remote waiting state", async () => {
    vi.mocked(api.getState).mockResolvedValue(
      stateWith([
        makeJob({
          jobId: "j-running",
          title: "running-task",
          status: "running",
          remote: { provider: "jules", sessionId: "sess-running", state: "IN_PROGRESS" },
        }),
      ])
    )

    renderView()

    await screen.findByText("running-task")
    expect(screen.queryByText("Awaiting feedback")).toBeNull()
  })

  it("shows live diff stats for a running write-mode job, and nothing for a read-mode job", async () => {
    vi.mocked(api.getState).mockResolvedValue(
      stateWith([
        makeJob({ jobId: "j-write", title: "write-task", mode: "write" }),
        makeJob({ jobId: "j-read", title: "read-task", mode: "read" }),
      ])
    )
    vi.mocked(api.getJobDiffStats).mockImplementation((jobId: string) =>
      Promise.resolve({
        diffStats:
          jobId === "j-write"
            ? {
                baseCommit: "abc123",
                additions: 7,
                deletions: 2,
                filesChanged: 3,
                files: [],
                truncated: false,
                computedAt: "2020-01-01T00:00:00.000Z",
                error: null,
              }
            : null,
      })
    )

    renderView()

    await screen.findByText("write-task")
    expect(await screen.findByText("+7")).toBeTruthy()
    expect(screen.getByText(/3 files$/)).toBeTruthy()

    // A read-mode job never even calls the diff-stats endpoint.
    expect(api.getJobDiffStats).not.toHaveBeenCalledWith("j-read")
  })

  it("renders the normal status badge for an ordinary job", async () => {
    vi.mocked(api.getState).mockResolvedValue(
      stateWith([
        makeJob({
          jobId: "j-ordinary",
          title: "ordinary-task",
          status: "running",
        }),
      ])
    )

    renderView()

    await screen.findByText("ordinary-task")
    expect(screen.getByText("Running")).toBeTruthy()
  })

  it("by default does not render headers for Timeout, Working dir and Profile, while Task, Status and Started are rendered", async () => {
    renderView()

    await screen.findByText("running-task")
    const table = screen.getByRole("table")

    expect(within(table).queryByRole("columnheader", { name: "Timeout" })).toBeNull()
    expect(within(table).queryByRole("columnheader", { name: "Working dir" })).toBeNull()
    expect(within(table).queryByRole("columnheader", { name: "Profile" })).toBeNull()

    expect(within(table).getByRole("columnheader", { name: "Task" })).toBeTruthy()
    expect(within(table).getByRole("columnheader", { name: "Status" })).toBeTruthy()
    expect(within(table).getByRole("columnheader", { name: "Started" })).toBeTruthy()
  })

  it("opening the column menu and toggling Timeout makes its header appear and toggling again hides it", async () => {
    renderView()

    await screen.findByText("running-task")
    const table = screen.getByRole("table")
    expect(within(table).queryByRole("columnheader", { name: "Timeout" })).toBeNull()

    const trigger = screen.getByRole("button", { name: "Choose visible columns" })
    fireEvent.click(trigger)

    const timeoutItem = await screen.findByRole("menuitemcheckbox", { name: "Timeout" })
    expect(timeoutItem.getAttribute("aria-checked")).toBe("false")

    // Toggle on -> Timeout column header appears
    fireEvent.click(timeoutItem)
    expect(within(table).getByRole("columnheader", { name: "Timeout" })).toBeTruthy()

    // Toggle off -> Timeout column header disappears again
    let timeoutToggle = screen.queryByRole("menuitemcheckbox", { name: "Timeout" })
    if (!timeoutToggle) {
      fireEvent.click(trigger)
      timeoutToggle = await screen.findByRole("menuitemcheckbox", { name: "Timeout" })
    }
    fireEvent.click(timeoutToggle)
    expect(within(table).queryByRole("columnheader", { name: "Timeout" })).toBeNull()
  })

  it("does not offer Actions as hideable and still renders HoldButton Cancel when other columns are hidden", async () => {
    renderView()

    await screen.findByText("running-task")

    const trigger = screen.getByRole("button", { name: "Choose visible columns" })
    fireEvent.click(trigger)

    await screen.findByRole("menu")
    expect(screen.queryByRole("menuitemcheckbox", { name: "Actions" })).toBeNull()

    // HoldButton "Cancel" renders under default hidden columns
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy()

    // Hide another column (e.g. Task)
    const taskItem = screen.getByRole("menuitemcheckbox", { name: "Task" })
    fireEvent.click(taskItem)

    // HoldButton "Cancel" still renders
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy()
  })

  it("renders empty-state correctly with hidden columns (the DataTable empty message row shows once)", async () => {
    vi.mocked(api.getState).mockResolvedValue(stateWith([]))

    renderView()

    expect(await screen.findByText("No jobs running")).toBeTruthy()
    expect(screen.getByText("Jobs you delegate show up here while they are queued or running.")).toBeTruthy()
    // Base UI's `render={<Link />}` swaps the button element for an <a>, so
    // the accessible role is "link", not "button".
    expect(screen.getByRole("link", { name: "View job history" })).toBeTruthy()

    const emptyCells = screen.getAllByRole("cell")
    expect(emptyCells).toHaveLength(1)
    expect(emptyCells[0].getAttribute("colspan")).toBe("9")
  })
})

