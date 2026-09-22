import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { DiffStatsTable } from "./DiffStatsTable"

describe("DiffStatsTable", () => {
  it("renders an empty state when there are no files", () => {
    render(<DiffStatsTable files={[]} truncated={false} />)
    expect(screen.getByText(/no file changes/i)).toBeTruthy()
  })

  it("renders one row per file with additions/deletions", () => {
    render(
      <DiffStatsTable
        files={[
          { path: "src/a.ts", additions: 4, deletions: 1, binary: false },
          { path: "assets/logo.png", additions: 0, deletions: 0, binary: true },
        ]}
        truncated={false}
      />
    )
    expect(screen.getByText("src/a.ts")).toBeTruthy()
    expect(screen.getByText("assets/logo.png")).toBeTruthy()
    expect(screen.getByText(/binary/i)).toBeTruthy()
  })

  it("shows a truncation notice when truncated is true", () => {
    render(<DiffStatsTable files={[{ path: "a.txt", additions: 1, deletions: 0, binary: false }]} truncated />)
    expect(screen.getByText(/truncated/i)).toBeTruthy()
  })
})
