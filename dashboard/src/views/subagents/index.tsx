import * as React from "react"
import { Users } from "lucide-react"
import type { HubEventT } from "@/lib/types"
import { PageHeader } from "@/components/PageHeader"
import { EmptyState } from "@/components/EmptyState"
import { DataTable, type DataTableColumn } from "@/components/DataTable"
import { StatusBadge } from "@/components/StatusBadge"
import { RelativeTime } from "@/components/RelativeTime"
import { ProviderMark } from "@/components/ProviderMark"
import { Card, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "@/components/ui/tooltip"
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { formatDuration, formatNumber, formatModel } from "@/lib/format"
import { useStateQuery } from "@/lib/queries"
import PixelCard from "@/components/reactbits/PixelCard"
import { CountUpValue } from "@/components/CountUpValue"

export type SubagentRun = {
  agentId: string
  agent: string
  title: string
  cwd: string
  sessionId: string | null
  startedAt: string | null
  stoppedAt: string | null
  tokens: number | null
  durationSeconds: number | null
  isRunning: boolean
  model: string | null
  summary: string | null
  source?: string | null
}

export type SubagentSummary = {
  runningNow: number
  finished24h: number
  totalTokens24h: number
}

export type SubagentProviderFilter = "all" | "claude" | "opencode" | "other"

const PROVIDER_FILTERS: { value: SubagentProviderFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "claude", label: "Claude" },
  { value: "opencode", label: "OpenCode" },
  { value: "other", label: "Other" },
]

export function classifyProvider(run: SubagentRun): "claude" | "opencode" | "other" {
  const agent = (run.agent || "").toLowerCase()
  const source = (run.source || "").toLowerCase()
  if (agent.includes("claude") || source.includes("claude")) return "claude"
  if (agent.includes("opencode") || source.includes("opencode")) return "opencode"
  return "other"
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000

export function pairSubagentEvents(events: HubEventT[] = []): SubagentRun[] {
  const map = new Map<string, SubagentRun>()

  for (const event of events) {
    if (event.kind !== "subagent.start" && event.kind !== "subagent.stop") {
      continue
    }

    const raw = event as HubEventT & { agentId?: string }
    const id = raw.agentId || event.jobId || event.ts
    if (!id) continue

    let run = map.get(id)
    if (!run) {
      run = {
        agentId: id,
        agent: event.agent || "subagent",
        title: event.title || "subagent",
        cwd: event.cwd || "",
        sessionId: (event as { sessionId?: string | null }).sessionId ?? null,
        startedAt: null,
        stoppedAt: null,
        tokens: null,
        durationSeconds: null,
        isRunning: false,
        model: event.model ?? null,
        summary: event.summary ?? null,
        source: event.source ?? null,
      }
      map.set(id, run)
    }

    if (event.source && !run.source) {
      run.source = event.source
    }

    if (event.kind === "subagent.start") {
      run.startedAt = event.ts || run.startedAt
      if (event.agent) run.agent = event.agent
      if (event.title) run.title = event.title
      if (event.cwd) run.cwd = event.cwd
      if ((event as { sessionId?: string | null }).sessionId) {
        run.sessionId = (event as { sessionId?: string | null }).sessionId ?? null
      }
      if (event.model) run.model = event.model
    } else if (event.kind === "subagent.stop") {
      run.stoppedAt = event.ts || run.stoppedAt
      if (event.agent && run.agent === "subagent") run.agent = event.agent
      if (event.title && run.title === "subagent") run.title = event.title
      if (event.cwd && !run.cwd) run.cwd = event.cwd
      if ((event as { sessionId?: string | null }).sessionId && !run.sessionId) {
        run.sessionId = (event as { sessionId?: string | null }).sessionId ?? null
      }
      if (typeof event.tokens === "number") run.tokens = event.tokens
      if (event.model) run.model = event.model
      if (event.summary) run.summary = event.summary
    }
  }

  const runs: SubagentRun[] = []
  for (const run of map.values()) {
    run.isRunning = Boolean(run.startedAt && !run.stoppedAt)

    if (run.startedAt && run.stoppedAt) {
      const startMs = new Date(run.startedAt).getTime()
      const stopMs = new Date(run.stoppedAt).getTime()
      if (!Number.isNaN(startMs) && !Number.isNaN(stopMs)) {
        run.durationSeconds = Math.max(0, Math.floor((stopMs - startMs) / 1000))
      }
    }

    runs.push(run)
  }

  runs.sort((a, b) => {
    const timeA = new Date(a.startedAt || a.stoppedAt || 0).getTime()
    const timeB = new Date(b.startedAt || b.stoppedAt || 0).getTime()
    return timeB - timeA
  })

  return runs
}

export function getSubagentSummary(runs: SubagentRun[], now: number = Date.now()): SubagentSummary {
  let runningNow = 0
  let finished24h = 0
  let totalTokens24h = 0

  for (const run of runs) {
    if (run.isRunning) {
      runningNow += 1
      continue
    }

    if (run.stoppedAt) {
      const stopMs = new Date(run.stoppedAt).getTime()
      if (!Number.isNaN(stopMs)) {
        const age = now - stopMs
        if (age >= 0 && age <= TWENTY_FOUR_HOURS_MS) {
          finished24h += 1
          if (run.tokens != null) {
            totalTokens24h += run.tokens
          }
        }
      }
    }
  }

  return { runningNow, finished24h, totalTokens24h }
}

export function SubagentsView() {
  const { data } = useStateQuery()
  const [selectedRun, setSelectedRun] = React.useState<SubagentRun | null>(null)
  const [filter, setFilter] = React.useState<SubagentProviderFilter>("all")

  // Ingest subagent events from both data.events and data.subagents regardless of source
  const allEvents = React.useMemo(() => {
    const rawEvents: HubEventT[] = [
      ...(data?.events ?? []),
      ...(data?.subagents ?? []),
    ]
    const subagentEvents = rawEvents.filter(
      (e) => e.kind === "subagent.start" || e.kind === "subagent.stop"
    )
    const seen = new Set<string>()
    const deduped: HubEventT[] = []
    for (const e of subagentEvents) {
      const raw = e as HubEventT & { agentId?: string }
      const key = `${e.ts}_${e.kind}_${raw.agentId ?? e.jobId ?? ""}`
      if (!seen.has(key)) {
        seen.add(key)
        deduped.push(e)
      }
    }
    return deduped
  }, [data?.events, data?.subagents])

  const runs = React.useMemo(() => pairSubagentEvents(allEvents), [allEvents])
  const summary = React.useMemo(() => getSubagentSummary(runs), [runs])

  const filteredRuns = React.useMemo(() => {
    if (filter === "all") return runs
    return runs.filter((r) => classifyProvider(r) === filter)
  }, [runs, filter])

  const handleFilterChange = (val: string[]) => {
    const next = val.find(Boolean) as SubagentProviderFilter | undefined
    if (next) setFilter(next)
  }

  const columns: DataTableColumn<SubagentRun>[] = React.useMemo(
    () => [
      {
        key: "agent",
        header: "Type",
        cell: (run) => (
          <div className="flex items-center gap-2">
            <ProviderMark agent={run.agent} size="sm" />
            <span className="font-medium text-foreground">{run.agent}</span>
          </div>
        ),
      },
      {
        key: "title",
        header: "Title",
        cell: (run) => <span className="font-medium">{run.title}</span>,
      },
      {
        key: "started",
        header: "Started",
        cell: (run) => <RelativeTime iso={run.startedAt} className="text-muted-foreground" />,
      },
      {
        key: "duration",
        header: "Duration",
        cell: (run) =>
          run.isRunning ? (
            <StatusBadge kind="status" value="running" />
          ) : (
            <span className="tabular-nums text-muted-foreground">{formatDuration(run.durationSeconds)}</span>
          ),
      },
      {
        key: "tokens",
        header: "Tokens",
        cell: (run) => (
          <span className="tabular-nums">{run.tokens != null ? formatNumber(run.tokens) : "—"}</span>
        ),
      },
      {
        key: "cwd",
        header: "CWD",
        cell: (run) =>
          run.cwd ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="inline-block max-w-[200px] truncate font-mono text-xs text-muted-foreground">
                    {run.cwd}
                  </span>
                }
              />
              <TooltipContent>{run.cwd}</TooltipContent>
            </Tooltip>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
    ],
    []
  )

  return (
    <TooltipProvider>
      <div className="flex flex-col gap-6">
        <PageHeader
          title="Subagents"
          description="subagent.start / subagent.stop lifecycle events across providers."
        />

        {runs.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No subagent activity recorded"
            description="Subagent hooks (such as the Claude Code hook) stream lifecycle events here when active."
          />
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <PixelCard noFocus className="rounded-xl">
                <Card size="sm" className="h-full bg-transparent border-0 ring-0 shadow-none">
                  <CardHeader>
                    <CardDescription>Running now</CardDescription>
                    <CardTitle className="text-2xl font-semibold">
                      <CountUpValue value={summary.runningNow} />
                    </CardTitle>
                  </CardHeader>
                </Card>
              </PixelCard>
              <PixelCard noFocus className="rounded-xl">
                <Card size="sm" className="h-full bg-transparent border-0 ring-0 shadow-none">
                  <CardHeader>
                    <CardDescription>Finished (last 24h)</CardDescription>
                    <CardTitle className="text-2xl font-semibold">
                      <CountUpValue value={summary.finished24h} />
                    </CardTitle>
                  </CardHeader>
                </Card>
              </PixelCard>
              <PixelCard noFocus className="rounded-xl">
                <Card size="sm" className="h-full bg-transparent border-0 ring-0 shadow-none">
                  <CardHeader>
                    <CardDescription>Total tokens (last 24h)</CardDescription>
                    <CardTitle className="text-2xl font-semibold">
                      <CountUpValue
                        value={summary.totalTokens24h}
                        format={(v) => formatNumber(Math.round(v))}
                      />
                    </CardTitle>
                  </CardHeader>
                </Card>
              </PixelCard>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <span id="provider-filter-label" className="text-sm font-medium text-muted-foreground">
                Provider:
              </span>
              <ToggleGroup
                value={[filter]}
                onValueChange={handleFilterChange}
                aria-labelledby="provider-filter-label"
              >
                {PROVIDER_FILTERS.map((item) => (
                  <ToggleGroupItem key={item.value} value={item.value}>
                    {item.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>

            <DataTable
              columns={columns}
              rows={filteredRuns}
              getRowId={(run) => run.agentId}
              onRowClick={(run) => setSelectedRun(run)}
              emptyMessage="No matching subagent activity recorded."
            />
          </>
        )}

        <Sheet open={Boolean(selectedRun)} onOpenChange={(open) => !open && setSelectedRun(null)}>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>{selectedRun?.title || "Subagent run"}</SheetTitle>
              <SheetDescription>Agent ID: {selectedRun?.agentId}</SheetDescription>
            </SheetHeader>
            <div className="flex flex-col gap-4 p-4 text-sm">
              <div className="flex items-center justify-between border-b pb-2">
                <span className="text-muted-foreground">Status</span>
                <span>
                  {selectedRun?.isRunning ? (
                    <StatusBadge kind="status" value="running" />
                  ) : (
                    <StatusBadge kind="status" value="succeeded" />
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between border-b pb-2">
                <span className="text-muted-foreground">Type</span>
                <span className="font-mono">{selectedRun?.agent}</span>
              </div>
              {selectedRun?.model && (
                <div className="flex items-center justify-between border-b pb-2">
                  <span className="text-muted-foreground">Model</span>
                  <span>{formatModel(selectedRun.model)}</span>
                </div>
              )}
              <div className="flex items-center justify-between border-b pb-2">
                <span className="text-muted-foreground">Started</span>
                <span>
                  {selectedRun?.startedAt ? new Date(selectedRun.startedAt).toLocaleString() : "—"}
                </span>
              </div>
              {selectedRun?.stoppedAt && (
                <div className="flex items-center justify-between border-b pb-2">
                  <span className="text-muted-foreground">Finished</span>
                  <span>{new Date(selectedRun.stoppedAt).toLocaleString()}</span>
                </div>
              )}
              <div className="flex items-center justify-between border-b pb-2">
                <span className="text-muted-foreground">Duration</span>
                <span>{formatDuration(selectedRun?.durationSeconds)}</span>
              </div>
              <div className="flex items-center justify-between border-b pb-2">
                <span className="text-muted-foreground">Tokens</span>
                <span>
                  {selectedRun?.tokens != null ? formatNumber(selectedRun.tokens) : "—"}
                </span>
              </div>
              {selectedRun?.sessionId && (
                <div className="flex items-center justify-between border-b pb-2">
                  <span className="text-muted-foreground">Session ID</span>
                  <span className="font-mono text-xs">{selectedRun.sessionId}</span>
                </div>
              )}
              <div className="flex flex-col gap-1 border-b pb-2">
                <span className="text-muted-foreground">Working directory</span>
                <span className="font-mono text-xs break-all">{selectedRun?.cwd || "—"}</span>
              </div>
              {selectedRun?.summary && (
                <div className="flex flex-col gap-1">
                  <span className="text-muted-foreground">Summary</span>
                  <p className="text-sm">{selectedRun.summary}</p>
                </div>
              )}
            </div>
          </SheetContent>
        </Sheet>
      </div>
    </TooltipProvider>
  )
}
