import * as React from "react"
import { GitFork } from "lucide-react"
import { cn } from "@/lib/utils"
import { PageHeader } from "@/components/PageHeader"
import { EmptyState } from "@/components/EmptyState"
import { RelativeTime } from "@/components/RelativeTime"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Skeleton } from "@/components/ui/skeleton"
import { Toggle } from "@/components/ui/toggle"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { statusBadge } from "@/lib/badges"
import { TONE_DOT_CLASS } from "@/lib/tone"
import { useWorkGraphQuery } from "@/lib/queries"
import type { WorkGraphResponseT } from "@/lib/types"
import { layoutWorkGraph, selectRepoGraph, summarizeJobs } from "./layout"
import { GraphCanvas, GraphLegend } from "./graph-canvas"
import { JobDetailPanel } from "./job-detail-panel"
import "./styles.css"

function lastPathSegment(value: string): string {
  const parts = value.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? value
}

/** Compact running/queued/failed counts + last-refresh time, derived from the (repo-scoped) graph. */
function SummaryStrip({ graph }: { graph: WorkGraphResponseT | null }) {
  const summary = React.useMemo(() => summarizeJobs(graph), [graph])
  const items: Array<{ key: keyof typeof summary; label: string }> = [
    { key: "running", label: "running" },
    { key: "queued", label: "queued" },
    { key: "failed", label: "failed" },
  ]

  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground" aria-label="Live summary">
      {items.map(({ key, label }) => {
        const tone = statusBadge(key).tone
        return (
          <span key={key} className="flex items-center gap-1.5">
            <span className={cn("size-1.5 rounded-full", TONE_DOT_CLASS[tone])} aria-hidden="true" />
            <span className="font-mono tabular-nums">{summary[key]}</span> {label}
          </span>
        )
      })}
      {graph ? (
        <span className="flex items-center gap-1">
          Updated <RelativeTime iso={graph.generatedAt} className="font-mono" />
        </span>
      ) : null}
    </div>
  )
}

export function WorkGraphView() {
  const workGraphQuery = useWorkGraphQuery()
  const [repoFilter, setRepoFilter] = React.useState<string>("all")
  const [activeOnly, setActiveOnly] = React.useState(false)
  const [expandedLaneIds, setExpandedLaneIds] = React.useState<ReadonlySet<string>>(new Set())
  const [selectedJobId, setSelectedJobId] = React.useState<string | null>(null)

  const graph = workGraphQuery.data ?? null

  const scopedGraph = React.useMemo(() => {
    if (!graph) return null
    return selectRepoGraph(graph, repoFilter as string | "all")
  }, [graph, repoFilter])

  const layout = React.useMemo(
    () => layoutWorkGraph(scopedGraph, { activeOnly, expandedLaneIds }),
    [scopedGraph, activeOnly, expandedLaneIds]
  )

  const selectedLaidJob = React.useMemo(
    () => layout.jobs.find((j) => j.node.jobId === selectedJobId) ?? null,
    [layout.jobs, selectedJobId]
  )
  const selectedJob = selectedLaidJob?.node ?? null
  const selectedLane = React.useMemo(
    () => (selectedLaidJob ? layout.lanes.find((l) => l.id === selectedLaidJob.laneId) ?? null : null),
    [layout.lanes, selectedLaidJob]
  )

  const toggleLane = React.useCallback((laneId: string) => {
    setExpandedLaneIds((prev) => {
      const next = new Set(prev)
      if (next.has(laneId)) next.delete(laneId)
      else next.add(laneId)
      return next
    })
  }, [])

  const repoOptions = graph?.repos.map((r) => r.root) ?? []
  const isEmpty = !workGraphQuery.isLoading && !workGraphQuery.isError && layout.lanes.length === 0

  return (
    <div className="flex flex-1 flex-col min-h-0 min-w-0 gap-3">
      <PageHeader
        title="Work graph"
        description="Where each agent is working: repo trunk, nested worktrees, and the jobs running in them."
      />

      <div className="sticky top-0 z-10 flex flex-col gap-2 bg-background/95 pb-2 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={repoFilter} onValueChange={(val) => setRepoFilter(val ?? "all")}>
              <SelectTrigger aria-label="Filter by repo" className="w-[220px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">All repos</SelectItem>
                  {repoOptions.map((root) => (
                    <SelectItem key={root} value={root} title={root}>
                      {lastPathSegment(root)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>

            <Toggle
              pressed={activeOnly}
              onPressedChange={setActiveOnly}
              aria-label="Active only"
              variant="outline"
              size="sm"
            >
              Active only
            </Toggle>
          </div>

          <SummaryStrip graph={scopedGraph} />
        </div>

        <GraphLegend />
      </div>

      {workGraphQuery.isLoading ? (
        <div className="flex flex-col gap-2">
          <span className="text-sm text-muted-foreground">Loading work graph…</span>
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </div>
      ) : workGraphQuery.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn't load the work graph</AlertTitle>
          <AlertDescription>
            {workGraphQuery.error instanceof Error ? workGraphQuery.error.message : "Unknown error."}
          </AlertDescription>
        </Alert>
      ) : isEmpty ? (
        <div className="flex flex-1 items-center justify-center rounded-lg border bg-card p-8">
          <EmptyState
            icon={GitFork}
            title="No active work"
            description="No repos, worktrees, or jobs found yet. Delegate a job to see it appear here."
          />
        </div>
      ) : (
        <GraphCanvas
          layout={layout}
          selectedJobId={selectedJobId}
          onSelectJob={setSelectedJobId}
          onToggleLane={toggleLane}
        />
      )}

      <JobDetailPanel job={selectedJob} lane={selectedLane} onOpenChange={(open) => !open && setSelectedJobId(null)} />
    </div>
  )
}
