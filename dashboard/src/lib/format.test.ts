import { describe, expect, it } from "vitest"
import {
  formatModel,
  formatNumber,
  elapsedSeconds,
  formatAge,
  formatLatency,
  formatDuration,
} from "./format"

describe("formatModel", () => {
  it("returns em dash for empty input", () => {
    expect(formatModel(null)).toBe("—")
    expect(formatModel(undefined)).toBe("—")
    expect(formatModel("")).toBe("—")
  })

  it("humanizes known model ids", () => {
    expect(formatModel("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5")
    expect(formatModel("gpt-4o-mini")).toBe("GPT-4o Mini")
  })

  it("falls back to the raw id for unknown models", () => {
    expect(formatModel("gemini-3.8-flash")).toBe("gemini-3.8-flash")
  })
})

describe("formatNumber", () => {
  it("returns em dash for null/NaN", () => {
    expect(formatNumber(null)).toBe("—")
    expect(formatNumber(undefined)).toBe("—")
    expect(formatNumber(Number.NaN)).toBe("—")
  })

  it("formats thousands and millions", () => {
    expect(formatNumber(1234)).toBe("1.2k")
    expect(formatNumber(2500000)).toBe("2.5M")
    expect(formatNumber(42)).toBe("42")
  })
})

describe("elapsedSeconds", () => {
  it("returns null for missing/invalid input", () => {
    expect(elapsedSeconds(null)).toBeNull()
    expect(elapsedSeconds("not-a-date")).toBeNull()
  })

  it("computes seconds elapsed against an injected now", () => {
    const now = new Date("2024-01-01T00:00:10.000Z").getTime()
    expect(elapsedSeconds("2024-01-01T00:00:00.000Z", now)).toBe(10)
  })
})

describe("formatAge", () => {
  const now = new Date("2024-01-02T00:00:00.000Z").getTime()

  it("returns em dash for missing or future timestamps", () => {
    expect(formatAge(null, now)).toBe("—")
    expect(formatAge("2024-01-03T00:00:00.000Z", now)).toBe("—")
  })

  it("formats seconds/minutes/hours/days", () => {
    expect(formatAge("2024-01-01T23:59:50.000Z", now)).toBe("10s ago")
    expect(formatAge("2024-01-01T23:55:00.000Z", now)).toBe("5m ago")
    expect(formatAge("2024-01-01T18:00:00.000Z", now)).toBe("6h ago")
    expect(formatAge("2023-12-30T00:00:00.000Z", now)).toBe("3d ago")
  })
})

describe("formatLatency", () => {
  it("returns em dash for null/NaN", () => {
    expect(formatLatency(null)).toBe("—")
  })

  it("formats sub-second latency in ms", () => {
    expect(formatLatency(250)).toBe("250 ms")
  })

  it("formats 1000+ ms as one-decimal seconds", () => {
    expect(formatLatency(3800)).toBe("3.8 s")
  })
})

describe("formatDuration", () => {
  it("returns em dash for null/NaN", () => {
    expect(formatDuration(null)).toBe("—")
  })

  it("formats seconds, minutes, and hours", () => {
    expect(formatDuration(42)).toBe("42s")
    expect(formatDuration(185)).toBe("3m 05s")
    expect(formatDuration(3720)).toBe("1h 02m")
  })
})
