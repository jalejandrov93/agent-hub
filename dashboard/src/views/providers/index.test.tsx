import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import * as api from "@/lib/api"
import { ProvidersView, JobProfileBadge } from "./index"
import type { AgysSnapshotResponseT } from "@/lib/types"

vi.mock("@/lib/api")

function renderView() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ProvidersView />
    </QueryClientProvider>
  )
}

const MOCK_SNAPSHOT: AgysSnapshotResponseT = {
  available: true,
  mode: "auto",
  pinnedProfile: null,
  selected: { name: "work" },
  profiles: [
    {
      name: "work",
      email: "work@example.com",
      active: true,
      priority: 0,
      state: "selected",
      quota: {
        buckets: [
          {
            id: "flash-primary",
            label: "Primary Window",
            window: "10m",
            resetTime: "2099-01-01T00:00:00Z",
            usedPercent: 45,
            remainingPercent: 55,
            description: null,
          },
        ],
      },
    },
    {
      name: "backup",
      email: null,
      active: false,
      priority: 1,
      state: "fallback",
      quota: {
        buckets: [
          {
            id: "flash-backup",
            label: "Backup Window",
            window: "1d",
            resetTime: null,
            usedPercent: null,
            remainingPercent: null,
            description: "Quota window not metered",
          },
        ],
      },
    },
  ],
}

describe("ProvidersView", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(api.getProviders).mockResolvedValue(MOCK_SNAPSHOT)
  })

  it("renders profiles and quotas from a mocked query", async () => {
    renderView()

    expect(await screen.findByText("auto")).toBeTruthy()
    expect(screen.getByText("Providers")).toBeTruthy()
    expect(screen.getAllByText("work").length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText("work@example.com")).toBeTruthy()
    expect(screen.getByText("default")).toBeTruthy()
    expect(screen.getAllByText("selected").length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText("Primary Window")).toBeTruthy()
    expect(screen.getByText("45% used")).toBeTruthy()
    expect(screen.getByText("55% remaining")).toBeTruthy()

    // Backup profile with unmetered quota (percent is null, never invented)
    expect(screen.getByText("backup")).toBeTruthy()
    expect(screen.getByText("fallback")).toBeTruthy()
    expect(screen.getByText("Backup Window")).toBeTruthy()
    expect(screen.getByText("Quota window not metered")).toBeTruthy()
  })

  it("renders the degraded/empty state when available is false", async () => {
    vi.mocked(api.getProviders).mockResolvedValue({
      available: false,
      reason: "agys is not on this process PATH",
      mode: "off",
      pinnedProfile: null,
      selected: null,
      profiles: [],
    })

    renderView()

    expect(await screen.findByText("agys CLI unavailable")).toBeTruthy()
    expect(screen.getByText("agys is not on this process PATH")).toBeTruthy()
    expect(screen.getByText(/agys auth login/i)).toBeTruthy()
  })

  it("renders the job profile badge", () => {
    const { rerender } = render(<JobProfileBadge profile="work" status="selected" />)

    expect(screen.getByTestId("job-profile-badge")).toBeTruthy()
    expect(screen.getByText("work")).toBeTruthy()
    expect(screen.getByText("selected")).toBeTruthy()

    rerender(<JobProfileBadge profile={null} status={null} />)
    expect(screen.queryByTestId("job-profile-badge")).toBeNull()
  })

  it("renders the toggle with current mode and calls the mutation on change", async () => {
    vi.mocked(api.setProvidersMode).mockResolvedValue({
      ...MOCK_SNAPSHOT,
      mode: "off",
    })

    renderView()

    const toggle = await screen.findByRole("combobox", { name: /mode toggle/i })
    expect(toggle).toBeTruthy()

    fireEvent.click(toggle)
    const offOption = await screen.findByRole("option", { name: "off" })
    fireEvent.pointerDown(offOption)
    fireEvent.click(offOption)

    await waitFor(() => {
      expect(api.setProvidersMode).toHaveBeenCalledWith({ mode: "off", profile: null })
    })
  })

  it("disables the mode toggle and shows hint when source is env", async () => {
    vi.mocked(api.getProviders).mockResolvedValue({
      ...MOCK_SNAPSHOT,
      source: "env",
    })

    renderView()

    const toggle = await screen.findByRole("combobox", { name: /mode toggle/i })
    expect((toggle as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId("env-override-hint")).toBeTruthy()
  })

  it('allows selecting a specific profile when in profile mode', async () => {
    vi.mocked(api.getProviders).mockResolvedValue({
      ...MOCK_SNAPSHOT,
      mode: 'profile',
      pinnedProfile: 'work',
    })
    vi.mocked(api.setProvidersMode).mockResolvedValue({
      ...MOCK_SNAPSHOT,
      mode: 'profile',
      pinnedProfile: 'backup',
    })

    renderView()

    const profileToggle = await screen.findByRole('combobox', { name: /profile toggle/i })
    expect(profileToggle).toBeTruthy()

    fireEvent.click(profileToggle)
    const backupOption = await screen.findByRole('option', { name: 'backup' })
    fireEvent.pointerDown(backupOption)
    fireEvent.click(backupOption)

    await waitFor(() => {
      expect(api.setProvidersMode).toHaveBeenCalledWith({ mode: 'profile', profile: 'backup' })
    })
  })
})

