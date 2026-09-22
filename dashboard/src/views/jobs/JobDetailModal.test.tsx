import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import * as api from "@/lib/api"
import type { Job } from "@/lib/types"
import { JobDetailModal } from "./JobDetailModal"

// D2 (agy-hub-verification): the job detail modal surfaces the hub-run
// `verification` result (docs/verification.md) — present only when the job
// was given a `verify` array. Mirrors PR #102's DiffStats section pattern.

vi.mock("@/lib/api")

const JOB_DEFAULTS: Job = {
  jobId: "job-1",
  agent: "agy",
  model: "gemini-3.8-flash-medium",
  title: "implement feature",
  cwd: "/home/user/project",
  mode: "write",
  status: "succeeded",
  createdAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-01T00:00:05.000Z",
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return { ...JOB_DEFAULTS, ...overrides }
}

const RESULT_RESPONSE = {
  text: "",
  truncated: false,
  tail: "",
  totalLines: 0,
  tailTruncated: false,
  fullPath: "/tmp/response.txt",
  tokens: null,
  costUsd: null,
  sessionId: null,
  status: "succeeded",
  errorKind: null,
}

function renderModal(job: Job) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <JobDetailModal job={job} open onOpenChange={() => {}} />
    </QueryClientProvider>
  )
}

describe("JobDetailModal verification section", () => {
  beforeEach(() => {
    vi.mocked(api.fetchJson).mockResolvedValue(RESULT_RESPONSE)
    vi.mocked(api.getJobDiffStats).mockResolvedValue({ diffStats: null })
  })

  it("renders nothing when the job has no verification field", () => {
    renderModal(makeJob({ verification: null }))
    expect(screen.queryByText(/verification/i)).toBeNull()
  })

  it("shows a passed badge and each check when verification.ok is true", () => {
    renderModal(
      makeJob({
        verification: {
          ok: true,
          checks: [{ name: "tests", ok: true, exitCode: 0, durationMs: 1200, outputTail: "all green" }],
        },
      })
    )
    expect(screen.getByText("Verification")).toBeTruthy()
    expect(screen.getByText("Passed")).toBeTruthy()
    expect(screen.getByText("tests")).toBeTruthy()
  })

  it("shows a failed badge and the failing check's output tail when verification.ok is false", () => {
    renderModal(
      makeJob({
        verification: {
          ok: false,
          checks: [{ name: "tests", ok: false, exitCode: 1, durationMs: 800, outputTail: "FAIL: 1 test failed" }],
        },
      })
    )
    expect(screen.getByText("Failed")).toBeTruthy()
    expect(screen.getByText(/FAIL: 1 test failed/)).toBeTruthy()
  })

  it("shows a skipped state with the reason when the job never ran verification", () => {
    renderModal(
      makeJob({
        status: "failed",
        errorKind: "incomplete",
        verification: { ok: null, checks: [], skipped: true, reason: "job ended failed (errorKind=incomplete); verification skipped" },
      })
    )
    expect(screen.getByText("Skipped")).toBeTruthy()
    expect(screen.getByText(/verification skipped/)).toBeTruthy()
  })
})
