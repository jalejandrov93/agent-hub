import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { MetricsView } from "./index"

const navigate = vi.fn()
const search = { taskType: "" }
const rows = [
  {
    agent: "agy",
    model: "gemini-3.8-flash-high",
    mode: "read",
    taskType: "call-chain-trace" as const,
    samples: 12,
    succeeded: 11,
    failed: 1,
    canceled: 0,
    successRate: 0.9167,
    p50Ms: 71000,
    p95Ms: 314000,
    errorKinds: { timeout: 1 },
    tokensTotal: 1320000,
    tokensAvg: 120000,
  },
  {
    agent: "opencode",
    model: "opencode/muse-spark-1.3-contributor-free",
    mode: "read",
    taskType: null,
    samples: 3,
    succeeded: 2,
    failed: 1,
    canceled: 0,
    successRate: 0.6667,
    p50Ms: 95000,
    p95Ms: null,
    errorKinds: { empty: 1 },
    tokensTotal: 180000,
    tokensAvg: 90000,
  },
]

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useSearch: () => search,
}))

vi.mock("@/lib/queries", () => ({
  useMetricsQuery: () => ({
    data: { generatedAt: "2026-09-15T04:00:00.000Z", groupBy: [], rows },
    isPending: false,
    isError: false,
  }),
}))

describe("MetricsView", () => {
  beforeEach(() => {
    navigate.mockReset()
    search.taskType = ""
  })

  it("offers task type filters and filters untagged rows", () => {
    render(<MetricsView />)

    fireEvent.click(screen.getByRole("combobox"))
    expect(screen.getAllByText("untagged").length).toBeGreaterThan(1)

    cleanup()
    search.taskType = "untagged"
    render(<MetricsView />)
    expect(screen.getAllByText("opencode").length).toBeGreaterThan(0)
    expect(screen.queryByText("agy")).toBeNull()
  })

  it("renders low-sample badges and an empty state after filtering", () => {
    render(<MetricsView />)
    expect(screen.getByText("low sample")).toBeTruthy()

    search.taskType = "research"
    render(<MetricsView />)
    expect(screen.getByText("No metrics yet")).toBeTruthy()
  })

  it("renders the chart without injecting a style element", () => {
    const stylesBefore = document.head.querySelectorAll("style").length
    const { container } = render(<MetricsView />)

    expect(container.querySelector("style")).toBeNull()
    expect(document.head.querySelectorAll("style").length).toBe(stylesBefore)
    expect(container.querySelector('[data-slot="chart"]')).toBeTruthy()
  })
})
