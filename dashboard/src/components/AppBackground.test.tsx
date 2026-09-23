import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { render, screen, waitFor, within } from "@testing-library/react"
import { AppBackground } from "./AppBackground"
import { ThemeProvider } from "./theme-provider"
import App from "../App"

class NoopEventSource {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 2
  readyState = NoopEventSource.CONNECTING
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  onerror: (() => void) | null = null
  close() {}
}

const CONFIG_RESPONSE = {
  delegationMap: {},
  discovery: {},
  timeouts: {},
  breaker: { windowMs: 60000, failureThreshold: 3, failureKinds: [], immediateKinds: [] },
  ttlMs: 60000,
  agentHubHome: "/home/test/.local/share/agent-hub",
  writeAllowlist: [],
  breakerState: [],
  overrides: {},
  process: { pid: 1, nodeVersion: "v22.0.0", platform: "linux", pathEntries: [], resolvedBins: {} },
}

const STATE_RESPONSE = { agents: [], jobs: [], subagents: [], events: [] }
const METRICS_RESPONSE = { generatedAt: "2024-01-01T00:00:00.000Z", groupBy: [], rows: [] }

function jsonResponse(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response)
}

function mockMatchMedia(options: { reduceMotion?: boolean; prefersDark?: boolean } = {}) {
  const { reduceMotion = false, prefersDark = false } = options
  return vi.fn().mockImplementation((query: string) => {
    let matches = false
    if (query.includes("prefers-reduced-motion: reduce")) {
      matches = reduceMotion
    } else if (query.includes("prefers-color-scheme: dark")) {
      matches = prefersDark
    }
    return {
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList
  })
}

describe("AppBackground", () => {
  beforeEach(() => {
    // @ts-expect-error test double
    globalThis.EventSource = NoopEventSource

    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes("/api/state")) return jsonResponse(STATE_RESPONSE)
        if (url.includes("/api/config")) return jsonResponse(CONFIG_RESPONSE)
        if (url.includes("/api/metrics")) return jsonResponse(METRICS_RESPONSE)
        if (url.includes("/api/proposals")) return jsonResponse({ proposals: [] })
        if (url.includes("/api/learnings")) return jsonResponse({ learnings: [] })
        if (url.includes("/api/providers")) return jsonResponse({ available: true, mode: "off", pinnedProfile: null, selected: null, profiles: [] })
        return jsonResponse({})
      })
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("renders the background layer with aria-hidden, -z-10 layer classes, and opacity in 0.05-0.1 range", () => {
    window.matchMedia = mockMatchMedia({ reduceMotion: false })

    const { container } = render(
      <ThemeProvider>
        <AppBackground />
      </ThemeProvider>
    )

    const bgLayer = container.querySelector('[aria-hidden="true"]') as HTMLElement
    expect(bgLayer).toBeTruthy()
    expect(bgLayer.getAttribute("aria-hidden")).toBe("true")
    expect(bgLayer.className).toContain("absolute")
    expect(bgLayer.className).toContain("inset-0")
    expect(bgLayer.className).toContain("-z-10")
    expect(bgLayer.className).toContain("pointer-events-none")

    const opacity = parseFloat(bgLayer.style.opacity)
    expect(opacity).toBeGreaterThanOrEqual(0.05)
    expect(opacity).toBeLessThanOrEqual(0.1)

    const canvas = bgLayer.querySelector("canvas")
    expect(canvas).toBeTruthy()
  })

  it("under prefers-reduced-motion it does not animate and renders static canvas without rAF loop", () => {
    window.matchMedia = mockMatchMedia({ reduceMotion: true })
    const rafSpy = vi.spyOn(window, "requestAnimationFrame")

    const { container } = render(
      <ThemeProvider>
        <AppBackground />
      </ThemeProvider>
    )

    const bgLayer = container.querySelector('[aria-hidden="true"]') as HTMLElement
    expect(bgLayer).toBeTruthy()

    // Does not initiate an infinite animation loop
    expect(rafSpy).not.toHaveBeenCalled()

    // Canvas element is still rendered (renders static frame)
    const canvas = bgLayer.querySelector("canvas")
    expect(canvas).toBeTruthy()
  })

  it("animates via requestAnimationFrame when prefers-reduced-motion is false", () => {
    window.matchMedia = mockMatchMedia({ reduceMotion: false })
    const rafSpy = vi.spyOn(window, "requestAnimationFrame")

    render(
      <ThemeProvider>
        <AppBackground />
      </ThemeProvider>
    )

    expect(rafSpy).toHaveBeenCalled()
  })

  it("mounts inside AppShell without adding any visible text nodes or accessible roles", async () => {
    window.matchMedia = mockMatchMedia({ reduceMotion: false })

    const { container } = render(<App />)

    await waitFor(() => expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy())

    const bgLayer = container.querySelector('[data-testid="app-background"]') as HTMLElement
    expect(bgLayer).toBeTruthy()
    expect(bgLayer.getAttribute("aria-hidden")).toBe("true")

    // Must not add visible text nodes
    expect(bgLayer.textContent).toBe("")

    // Must not add any accessibility roles
    expect(bgLayer.getAttribute("role")).toBeNull()
    expect(bgLayer.querySelectorAll("[role]").length).toBe(0)

    // Existing sidebar labels and Coming soon elements must continue passing without interference
    const sidebar = container.querySelector('[data-sidebar="content"]') as HTMLElement
    expect(sidebar).toBeTruthy()
    expect(within(sidebar).getByText("Overview")).toBeTruthy()
    expect(within(sidebar).getByText("Agents")).toBeTruthy()
    await waitFor(() => expect(screen.getAllByText("Coming soon").length).toBeGreaterThan(0))
  })
})
