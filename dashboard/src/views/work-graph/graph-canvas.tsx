import * as React from "react"
import { cn } from "@/lib/utils"
import { statusBadge } from "@/lib/badges"
import { TONE_DOT_CLASS } from "@/lib/tone"
import { formatDuration, formatModel } from "@/lib/format"
import type { WorkGraphWorktreeNode } from "@/lib/types"
import { JOB_CARD_WIDTH, REMOVED_GROUP_MARKER_WIDTH, type LaidOutJob, type WorkGraphLayout } from "./layout"

const JOB_CARD_HEIGHT = 34
const COLLAPSED_MARKER_HEIGHT = 24
const LANE_LABEL_MAX_CHARS = 22
const LANE_SUBLABEL_MAX_CHARS = 28

/** Visual truncation only — layout.ts always carries the full name; the full string is always also in a <title> tooltip. */
function truncateLabel(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}

const SETTLED_STATUSES = new Set(["succeeded", "canceled"])

/**
 * One stroke color + label per edge kind, shared between the canvas paths and
 * the legend so the two never drift apart. Colors lean on the existing chart
 * tokens (structural edges stay neutral; waitsOn borrows --warning since it
 * represents a block).
 */
export const EDGE_KIND_STYLE: Record<
  WorkGraphLayout["edges"][number]["kind"],
  { stroke: string; dash?: string; label: string }
> = {
  branchesFrom: { stroke: "stroke-border", label: "Branches from" },
  runsIn: { stroke: "stroke-border/70", label: "Runs in" },
  remote: { stroke: "stroke-chart-5/70", label: "Remote (Jules)" },
  continues: { stroke: "stroke-chart-1/70", label: "Continues" },
  waitsOn: { stroke: "stroke-warning/70", dash: "6 4", label: "Waits on" },
}

const STATUS_LEGEND: Array<{ status: string; label: string }> = [
  { status: "running", label: "Running" },
  { status: "queued", label: "Queued" },
  { status: "succeeded", label: "Succeeded" },
  { status: "failed", label: "Failed" },
]

/** Compact legend for job status dots and edge-kind lines — kept out of pill/badge styling on purpose. */
export function GraphLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground" aria-label="Legend">
      {STATUS_LEGEND.map(({ status, label }) => {
        const tone = statusBadge(status).tone
        return (
          <span key={status} className="flex items-center gap-1.5">
            <span className={cn("size-1.5 rounded-full", TONE_DOT_CLASS[tone])} aria-hidden="true" />
            {label}
          </span>
        )
      })}
      <span className="mx-0.5 h-3 w-px bg-border" aria-hidden="true" />
      {(Object.keys(EDGE_KIND_STYLE) as Array<keyof typeof EDGE_KIND_STYLE>).map((kind) => {
        const meta = EDGE_KIND_STYLE[kind]
        return (
          <span key={kind} className="flex items-center gap-1.5">
            <svg width="16" height="6" aria-hidden="true">
              <line x1="0" y1="3" x2="16" y2="3" strokeWidth={1.5} strokeDasharray={meta.dash} className={meta.stroke} />
            </svg>
            {meta.label}
          </span>
        )
      })}
    </div>
  )
}

function edgeClassName(
  edge: WorkGraphLayout["edges"][number],
  isHighlighted: boolean,
  hoverActive: boolean,
  dashed: boolean
): string {
  const meta = EDGE_KIND_STYLE[edge.kind]
  return cn(
    "fill-none transition-[stroke,opacity] duration-200",
    meta.stroke,
    (edge.kind === "waitsOn" || dashed) && "wg-edge-dashed",
    edge.feedsRunningJobIds.length > 0 && "wg-edge-flow stroke-primary",
    isHighlighted && "stroke-primary opacity-100",
    !isHighlighted && hoverActive && "opacity-20",
    !isHighlighted && !hoverActive && edge.feedsRunningJobIds.length === 0 && "opacity-70"
  )
}

function JobCard({
  job,
  selected,
  highlighted,
  dimmed,
  onSelect,
  onHover,
}: {
  job: LaidOutJob
  selected: boolean
  highlighted: boolean
  dimmed: boolean
  onSelect: (jobId: string) => void
  onHover: (jobId: string | null) => void
}) {
  const node = job.node
  const tone = statusBadge(node.status).tone
  const settled = SETTLED_STATUSES.has(node.status)
  const opacityClass = dimmed ? "opacity-35" : settled ? "opacity-75" : "opacity-100"

  return (
    <div
      data-slot="job-card"
      data-job-id={node.jobId}
      data-status={node.status}
      data-running={job.isRunning ? "true" : undefined}
      data-dimmed={dimmed ? "true" : undefined}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      title={`${node.title || node.agent} · ${node.agent} · ${formatModel(node.model)}`}
      onClick={() => onSelect(node.jobId)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault()
          onSelect(node.jobId)
        }
      }}
      onMouseEnter={() => onHover(node.jobId)}
      onMouseLeave={() => onHover(null)}
      className={cn(
        "wg-reveal relative flex h-full w-full cursor-pointer flex-col justify-center gap-0.5 overflow-hidden rounded-md border bg-card px-2 py-1 text-left shadow-sm transition-all duration-200 ease-out hover:-translate-y-0.5 hover:shadow-md hover:border-primary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1",
        opacityClass,
        selected && "border-primary ring-1 ring-primary",
        highlighted && !selected && "border-primary/40",
        node.status === "failed" && "border-destructive/40 bg-destructive/5"
      )}
      style={{ "--step": job.step } as React.CSSProperties}
    >
      {job.isRunning ? (
        <span className="pointer-events-none absolute top-1.5 left-1.5 flex size-1.5">
          <span className={cn("wg-pulse-ring absolute inline-flex size-1.5 rounded-full", TONE_DOT_CLASS[tone])} />
          <span className={cn("relative inline-flex size-1.5 rounded-full", TONE_DOT_CLASS[tone])} />
        </span>
      ) : (
        <span
          className={cn(
            "absolute top-1.5 left-1.5 inline-flex size-1.5 rounded-full",
            TONE_DOT_CLASS[tone],
            node.status === "queued" && "wg-breathe"
          )}
        />
      )}
      <span className="truncate pl-3 text-[11px] font-medium leading-tight text-foreground">
        {node.title || node.agent}
      </span>
      <span className="truncate pl-3 font-mono text-[10px] tabular-nums text-muted-foreground">
        {node.agent} · {formatModel(node.model)} · {formatDuration(node.durationS)}
      </span>
    </div>
  )
}

/**
 * Hand-rolled SVG canvas for the work graph: lane labels + edges drawn as SVG
 * paths, job leaves as HTML cards inside <foreignObject> (so job text wraps
 * and truncates with ordinary CSS instead of manual SVG text layout).
 */
export function GraphCanvas({
  layout,
  selectedJobId,
  onSelectJob,
  onToggleLane,
}: {
  layout: WorkGraphLayout
  selectedJobId: string | null
  onSelectJob: (jobId: string) => void
  onToggleLane: (laneId: string) => void
}) {
  const [hoveredJobId, setHoveredJobId] = React.useState<string | null>(null)

  const highlightedEdgeIds = React.useMemo(() => {
    if (!hoveredJobId) return new Set<string>()
    return new Set(layout.pathToTrunkByJobId[hoveredJobId] ?? [])
  }, [hoveredJobId, layout.pathToTrunkByJobId])

  const removedLaneIds = React.useMemo(
    () =>
      new Set(
        layout.lanes
          .filter((l) => l.kind === "worktree" && Boolean((l.node as WorkGraphWorktreeNode).removed))
          .map((l) => l.id)
      ),
    [layout.lanes]
  )

  return (
    <div
      data-slot="work-graph-canvas"
      className="relative flex-1 min-h-0 min-w-0 overflow-auto rounded-lg border bg-card"
    >
      <svg
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-label="Agent work graph"
      >
        <g data-slot="edges">
          {layout.edges.map((edge) => (
            <path
              key={edge.id}
              data-slot="edge"
              data-kind={edge.kind}
              d={edge.path}
              className={edgeClassName(
                edge,
                highlightedEdgeIds.has(edge.id),
                hoveredJobId !== null,
                removedLaneIds.has(edge.from) || removedLaneIds.has(edge.to)
              )}
              strokeWidth={edge.kind === "branchesFrom" ? 2 : 1.5}
            />
          ))}
        </g>

        <g data-slot="group-headers">
          {layout.groupHeaders.map((header) => (
            <text
              key={header.id}
              data-slot="group-header"
              x={header.x}
              y={header.y}
              className="fill-muted-foreground text-[10px] font-semibold tracking-wide uppercase"
            >
              {header.id === "cloud" ? "☁ " : ""}
              {header.label}
            </text>
          ))}
        </g>

        <g data-slot="lanes">
          {layout.lanes.map((lane) => {
            const isRemoved = lane.kind === "worktree" && Boolean((lane.node as WorkGraphWorktreeNode).removed)
            return (
              // Positioning (the `transform` attribute) lives on this outer <g>, kept
              // separate from the reveal-animated inner <g>: a CSS `transform` on an
              // SVG element completely replaces its `transform` *attribute* rather than
              // composing with it, so combining both on one element collapsed every
              // lane to the same y once the reveal animation's own translateY ran.
              <g key={lane.id} data-slot="lane" data-lane-id={lane.id} transform={`translate(0, ${lane.y})`}>
                <g
                  className={cn("wg-reveal", isRemoved && "opacity-60")}
                  style={{ "--step": lane.step } as React.CSSProperties}
                >
                  <text
                    x={lane.x}
                    y={-2}
                    data-slot="lane-label"
                    className={cn(
                      "fill-foreground",
                      lane.kind === "repo"
                        ? "text-[12px] font-semibold tracking-tight"
                        : "font-mono text-[11px] font-medium",
                      isRemoved && "fill-muted-foreground"
                    )}
                  >
                    <title>{lane.label}</title>
                    {truncateLabel(lane.label, LANE_LABEL_MAX_CHARS)}
                  </text>
                  {lane.sublabel ? (
                    <text
                      x={lane.x}
                      y={10}
                      data-slot="lane-sublabel"
                      className="fill-muted-foreground font-mono text-[9px]"
                    >
                      <title>{lane.sublabel}</title>
                      {truncateLabel(lane.sublabel, LANE_SUBLABEL_MAX_CHARS)}
                    </text>
                  ) : null}
                </g>
              </g>
            )
          })}
        </g>

        <g data-slot="jobs">
          {layout.jobs.map((job) => (
            <foreignObject
              key={job.id}
              x={job.x}
              y={job.y - JOB_CARD_HEIGHT / 2}
              width={JOB_CARD_WIDTH}
              height={JOB_CARD_HEIGHT}
            >
              <JobCard
                job={job}
                selected={job.node.jobId === selectedJobId}
                highlighted={highlightedEdgeIds.size > 0 && job.node.jobId === hoveredJobId}
                dimmed={hoveredJobId !== null && job.node.jobId !== hoveredJobId}
                onSelect={onSelectJob}
                onHover={setHoveredJobId}
              />
            </foreignObject>
          ))}
        </g>

        <g data-slot="collapsed">
          {layout.collapsed.map((group) => (
            <foreignObject
              key={group.id}
              x={group.x}
              y={group.y - COLLAPSED_MARKER_HEIGHT / 2}
              width={COLLAPSED_MARKER_WIDTH_FOR(group.hiddenCount)}
              height={COLLAPSED_MARKER_HEIGHT}
            >
              <button
                type="button"
                data-slot="collapsed-marker"
                onClick={() => onToggleLane(group.laneId)}
                className="flex h-full items-center gap-1 rounded-md border border-dashed px-2 font-mono text-[10px] font-medium text-muted-foreground transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-solid hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                +{group.hiddenCount} finished
              </button>
            </foreignObject>
          ))}
        </g>

        <g data-slot="removed-groups">
          {layout.removedGroups.map((group) => (
            <foreignObject
              key={group.id}
              x={group.x}
              y={group.y - COLLAPSED_MARKER_HEIGHT / 2}
              width={REMOVED_GROUP_MARKER_WIDTH}
              height={COLLAPSED_MARKER_HEIGHT}
            >
              <button
                type="button"
                data-slot="removed-group-marker"
                onClick={() => onToggleLane(group.id)}
                className="flex h-full items-center gap-1 rounded-md border border-dashed px-2 font-mono text-[10px] font-medium text-muted-foreground transition-all duration-200 ease-out hover:-translate-y-0.5 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                {group.hiddenCount} removed worktree{group.hiddenCount === 1 ? "" : "s"}
              </button>
            </foreignObject>
          ))}
        </g>
      </svg>
    </div>
  )
}

function COLLAPSED_MARKER_WIDTH_FOR(hiddenCount: number): number {
  // Wide enough for "+99 finished" without measuring text in SVG.
  return hiddenCount >= 10 ? 96 : 84
}
