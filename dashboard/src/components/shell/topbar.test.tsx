import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { Topbar } from "./topbar"
import { SidebarProvider } from "@/components/ui/sidebar"
import { ThemeProvider } from "@/components/theme-provider"
import { qk } from "@/lib/query-keys"

vi.mock("@/lib/sse", () => ({
  useConnection: vi.fn(() => ({ connection: "live", events: [] })),
}))

vi.mock("@/lib/api", () => ({
  getState: vi.fn().mockResolvedValue({ agents: [], jobs: [], subagents: [], events: [] }),
  getConfig: vi.fn().mockResolvedValue({}),
}))

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

function renderTopbar(queryClient?: QueryClient) {
  const qc =
    queryClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })

  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <SidebarProvider>
          <Topbar title="Overview" />
        </SidebarProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}

describe("Topbar micro-interactions", () => {
  beforeEach(() => {
    window.matchMedia = mockMatchMedia({ reduceMotion: false })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("asserts the Live badge renders its text and the BorderGlow wrapper does not add visible text", () => {
    renderTopbar()

    const badge = screen.getByText("Live")
    expect(badge).toBeTruthy()

    // BorderGlow wrapper exists and introduces no visible text or extra roles
    const glowWrapper = (badge.closest("[data-border-glow]") || badge.parentElement) as HTMLElement
    expect(glowWrapper).toBeTruthy()
    expect(glowWrapper.textContent).toBe("Live")
  })

  it("asserts the Refresh button keeps its accessible name and remains clickable", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries")

    renderTopbar(queryClient)

    const refreshBtn = screen.getByRole("button", { name: /refresh/i })
    expect(refreshBtn).toBeTruthy()
    expect(refreshBtn.id).toBe("btn-refresh")

    fireEvent.click(refreshBtn)
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.state })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: qk.config })
  })

  it("asserts under mocked prefers-reduced-motion the Magnet does not attach pointer tracking and renders inert", () => {
    window.matchMedia = mockMatchMedia({ reduceMotion: true })
    const addEventListenerSpy = vi.spyOn(window, "addEventListener")

    renderTopbar()

    // Mousemove tracking must not be attached on window
    const mouseMoveCalls = addEventListenerSpy.mock.calls.filter(([event]) => event === "mousemove")
    expect(mouseMoveCalls.length).toBe(0)

    // Button remains fully accessible and clickable
    const refreshBtn = screen.getByRole("button", { name: /refresh/i })
    expect(refreshBtn).toBeTruthy()
    fireEvent.click(refreshBtn)

    // Magnet inner container renders in resting position (inert)
    const magnetInner = refreshBtn.parentElement as HTMLElement
    expect(magnetInner.style.transform).toBe("translate3d(0px, 0px, 0)")
  })

  it("attaches window pointer tracking for Magnet when prefers-reduced-motion is false", () => {
    window.matchMedia = mockMatchMedia({ reduceMotion: false })
    const addEventListenerSpy = vi.spyOn(window, "addEventListener")

    renderTopbar()

    const mouseMoveCalls = addEventListenerSpy.mock.calls.filter(([event]) => event === "mousemove")
    expect(mouseMoveCalls.length).toBeGreaterThan(0)
  })
})
