import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
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

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <JobsView />
    </QueryClientProvider>
  )
}

describe("JobsView", () => {
  beforeEach(() => {
    vi.mocked(api.getState).mockResolvedValue(stateWith([makeJob()]))
    vi.mocked(api.cancelJob).mockResolvedValue({})
    vi.mocked(api.fetchJson).mockResolvedValue(RESULT_RESPONSE)
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
    expect(screen.getAllByText("acme/widgets").length).toBeGreaterThan(0)
  })

  it("requires confirmation before canceling a job", async () => {
    renderView()

    await screen.findByText("running-task")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(api.cancelJob).not.toHaveBeenCalled()

    fireEvent.click(await screen.findByRole("button", { name: "Cancel job" }))
    // React Query v5 calls mutationFn(variables, context); only the first arg is ours.
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
})
