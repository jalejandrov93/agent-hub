import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { DiffStatsSummary } from "./DiffStatsSummary"

describe("DiffStatsSummary", () => {
  it("renders nothing for null stats (read-mode job, or no baseline)", () => {
    const { container } = render(<DiffStatsSummary stats={null} />)
    expect(container.firstChild).toBeNull()
  })

  it("renders +additions, -deletions and the file count, GitHub-style", () => {
    render(<DiffStatsSummary stats={{ additions: 12, deletions: 3, filesChanged: 2 }} />)
    expect(screen.getByText("+12")).toBeTruthy()
    expect(screen.getByText(/^.3$/)).toBeTruthy()
    expect(screen.getByText(/2 files$/)).toBeTruthy()
  })

  it("uses singular 'file' for exactly one changed file", () => {
    render(<DiffStatsSummary stats={{ additions: 1, deletions: 0, filesChanged: 1 }} />)
    expect(screen.getByText(/1 file$/)).toBeTruthy()
  })

  it("renders a degraded/error state as an em dash rather than 0s", () => {
    render(<DiffStatsSummary stats={{ additions: null, deletions: null, filesChanged: null, error: "git diff failed" }} />)
    expect(screen.getByText("—")).toBeTruthy()
  })

  it("applies the success tone to additions and the destructive tone to deletions", () => {
    render(<DiffStatsSummary stats={{ additions: 5, deletions: 2, filesChanged: 1 }} />)
    const additionsEl = screen.getByText(/^\+5$/)
    expect(additionsEl.className).toContain("text-success")
    const deletionsEl = screen.getByText(/^.2$/)
    expect(deletionsEl.className).toContain("text-destructive")
  })
})
