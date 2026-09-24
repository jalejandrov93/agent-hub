import * as React from "react"
import { Link } from "@tanstack/react-router"
import { AlertTriangle, Columns3, GitBranch, PlayCircle } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { ProviderMark } from "@/components/ProviderMark"
import { StatusBadge } from "@/components/StatusBadge"
import { EmptyState } from "@/components/EmptyState"
import { DataTable, type DataTableColumn } from "@/components/DataTable"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { HoldButton } from "@/components/reactbits/HoldButton"
import { DiffStatsSummary } from "@/components/DiffStatsSummary"
import { RelativeTime } from "@/components/RelativeTime"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Toaster, toast } from "@/components/ui/toast"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { runningJobs } from "@/lib/badges"
import { formatDuration, formatModel } from "@/lib/format"
import { useCancelJobMutation, useStateQuery } from "@/lib/queries"
import { TONE_BADGE_CLASS } from "@/lib/tone"
import type { Job } from "@/lib/types"
import { cn } from "@/lib/utils"
import { JobProfileBadge } from "@/views/providers"
import { ElapsedCell } from "./ElapsedCell"
import { JobDetailModal } from "./JobDetailModal"
import { useJobDiffStatsQuery } from "./useJobDiffStats"

/** Live "+X −Y · N files" cell for a job row. A read-mode job never even
 * queries the endpoint — DiffStatsSummary would render nothing for it anyway,
 * but skipping the fetch avoids a pointless poll loop for every read job. */
function DiffStatsCell({ job }: { job: Job }) {
  const diffStats = useJobDiffStatsQuery(job.jobId, job.mode === "write")
  if (job.mode !== "write") return null
  return <DiffStatsSummary stats={diffStats.data?.diffStats ?? null} />
}

function remoteWaitingState(job: Job): string | null {
  const state = job.remote?.state ?? job.remote_state
  if (typeof state === "string") {
    const s = state.toUpperCase()
    if (s.startsWith("AWAITING_") || s === "PAUSED") {
      return state
    }
  }
  return null
}

const PAGE_HEADER = {
  title: "Running jobs",
  description: "Queued and in-progress jobs.",
} as const

/**
 * Where a job runs. A remote (Jules) job has no local checkout — it works on a
 * GitHub source — so show that repository rather than an empty cell.
 */
function locationOf(job: Job): string {
  if (job.cwd) return job.cwd
  const source = job.remote?.source
  if (source) return source.replace(/^sources\/github\//, "")
  return "—"
}

function CwdCell({ location }: { location: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block max-w-[16rem] truncate text-left" />}>
        {location}
      </TooltipTrigger>
      <TooltipContent className="max-w-md break-all">{location}</TooltipContent>
    </Tooltip>
  )
}

/** name + branch for the "Project" column, plus a full-path tooltip. Preference
 * order: the job's own captured repo (any local-cwd mode) -> a remote (Jules)
 * job's GitHub source -> the cwd basename for a local job with no git repo. */
type ProjectInfo = { name: string; branch: string | null; tooltip: string }

function projectOf(job: Job): ProjectInfo | null {
  if (job.repo) {
    return { name: job.repo.name, branch: job.repo.branch, tooltip: job.repo.root }
  }
  const source = job.remote?.source
  if (source) {
    return {
      name: source.replace(/^sources\/github\//, ""),
      branch: job.remote?.branch ?? job.remote?.startingBranch ?? null,
      tooltip: source,
    }
  }
  if (job.cwd) {
    const name = job.cwd.split("/").filter(Boolean).pop() ?? job.cwd
    return { name, branch: null, tooltip: job.cwd }
  }
  return null
}

function ProjectCell({ job }: { job: Job }) {
  const info = projectOf(job)
  if (!info) return <span className="text-muted-foreground">—</span>
  return (
    <Tooltip>
      <TooltipTrigger render={<div className="flex max-w-[14rem] flex-col gap-0.5 text-left" />}>
        <span className="truncate font-medium">{info.name}</span>
        {info.branch ? (
          <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
            <GitBranch className="size-3 shrink-0" />
            {info.branch}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipContent className="max-w-md break-all">{info.tooltip}</TooltipContent>
    </Tooltip>
  )
}

const DEFAULT_HIDDEN_COLUMNS: ReadonlySet<string> = new Set(["timeout", "cwd", "profile"])
const MANDATORY_COLUMNS: readonly string[] = ["actions"]

export function JobsView() {
  const stateQuery = useStateQuery()
  const cancelJob = useCancelJobMutation()
  const [selected, setSelected] = React.useState<Job | null>(null)
  const [pendingCancel, setPendingCancel] = React.useState<Job | null>(null)
  const [hidden, setHidden] = React.useState<Set<string>>(() => new Set(DEFAULT_HIDDEN_COLUMNS))

  const jobs = React.useMemo(() => {
    const data = stateQuery.data
    if (!data) return []
    return runningJobs({ agents: data.agents, jobs: data.jobs, events: data.events, config: null })
  }, [stateQuery.data])

  const columns: DataTableColumn<Job>[] = [
    {
      key: "agent",
      header: "Agent & model",
      cell: (job) => (
        <div className="flex items-center gap-2">
          <ProviderMark agent={job.agent} size="sm" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium">{job.agent}</span>
            <span className="truncate text-xs text-muted-foreground" title={job.model}>
              {formatModel(job.model)}
            </span>
          </div>
        </div>
      ),
    },
    {
      key: "project",
      header: "Project",
      cell: (job) => <ProjectCell job={job} />,
    },
    {
      key: "title",
      header: "Task",
      cell: (job) => (
        <span className="block max-w-[18rem] truncate" title={job.title ?? undefined}>
          {job.title || "Untitled job"}
        </span>
      ),
    },
    {
      key: "mode",
      header: "Mode",
      cell: (job) => <Badge variant="secondary">{job.mode}</Badge>,
    },
    {
      key: "taskType",
      header: "Task type",
      cell: (job) => (job.taskType ? <Badge variant="outline">{job.taskType}</Badge> : "—"),
    },
    {
      key: "profile",
      header: "Profile",
      cell: (job) =>
        job.profile ? (
          <JobProfileBadge profile={job.profile} status={job.profileStatus} />
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      cell: (job) => {
        const waitingState = remoteWaitingState(job)
        if (waitingState) {
          return (
            <Badge
              variant="outline"
              title={waitingState}
              className={cn("border-transparent", TONE_BADGE_CLASS.warning)}
            >
              <AlertTriangle data-icon="inline-start" />
              Awaiting feedback
            </Badge>
          )
        }
        return <StatusBadge kind="status" value={job.status} />
      },
    },
    {
      key: "cwd",
      header: "Working dir",
      cell: (job) => <CwdCell location={locationOf(job)} />,
    },
    {
      key: "started",
      header: "Started",
      cell: (job) => <RelativeTime iso={job.createdAt} className="text-xs whitespace-nowrap" />,
    },
    {
      key: "elapsed",
      header: "Elapsed",
      cell: (job) => <ElapsedCell since={job.createdAt} />,
    },
    {
      key: "timeout",
      header: "Timeout",
      cell: (job) => (
        <div className="flex items-center gap-1.5 whitespace-nowrap">
          <span className="font-mono text-xs">{formatDuration(job.timeoutS)}</span>
          {job.timeoutSource ? <Badge variant="outline">{job.timeoutSource}</Badge> : null}
        </div>
      ),
    },
    {
      key: "changes",
      header: "Changes",
      cell: (job) => <DiffStatsCell job={job} />,
    },
    {
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "text-right",
      cell: (job) => (
        <HoldButton
          size="sm"
          holdTime={2000}
          onHold={() => setPendingCancel(job)}
          backgroundColor="var(--card)"
          fillColor="var(--destructive)"
          textColor="var(--destructive)"
          fillTextColor="var(--destructive-foreground)"
          className="text-xs"
        >
          Cancel
        </HoldButton>
      ),
    },
  ]

  const visibleColumns = React.useMemo(
    () => columns.filter((c) => !hidden.has(c.key) || MANDATORY_COLUMNS.includes(c.key)),
    [columns, hidden]
  )

  const hideableColumns = React.useMemo(
    () => columns.filter((c) => !MANDATORY_COLUMNS.includes(c.key)),
    [columns]
  )

  return (
    <TooltipProvider>
      <PageHeader title={PAGE_HEADER.title} description={PAGE_HEADER.description} />

      {stateQuery.isPending ? (
        <Skeleton className="h-48 w-full" />
      ) : stateQuery.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load jobs</AlertTitle>
          <AlertDescription>{stateQuery.error.message}</AlertDescription>
        </Alert>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label="Choose visible columns"
                  />
                }
              >
                <Columns3 data-icon="inline-start" />
                Columns
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuGroup>
                  {hideableColumns.map((col) => (
                    <DropdownMenuCheckboxItem
                      key={col.key}
                      checked={!hidden.has(col.key)}
                      onCheckedChange={(checked) => {
                        setHidden((prev) => {
                          const next = new Set(prev)
                          if (checked) {
                            next.delete(col.key)
                          } else {
                            next.add(col.key)
                          }
                          return next
                        })
                      }}
                    >
                      {typeof col.header === "string" ? col.header : col.key}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <DataTable
            columns={visibleColumns}
            rows={jobs}
            getRowId={(job) => job.jobId}
            onRowClick={setSelected}
            emptyMessage={
              <EmptyState
                icon={PlayCircle}
                title="No jobs running"
                description="Jobs you delegate show up here while they are queued or running."
              >
                <Button variant="outline" size="sm" render={<Link to="/history" />}>
                  View job history
                </Button>
              </EmptyState>
            }
          />
        </div>
      )}

      {pendingCancel ? (
        <ConfirmDialog
          open={Boolean(pendingCancel)}
          onOpenChange={(open) => {
            if (!open) setPendingCancel(null)
          }}
          title="Cancel this job?"
          description="This stops the running job and marks it canceled."
          confirmLabel="Cancel job"
          destructive
          onConfirm={() => {
            const jobId = pendingCancel.jobId
            cancelJob.mutate(jobId, {
              onSuccess: () => toast.add({ title: "Job canceled", type: "success" }),
              onError: (error) =>
                toast.add({
                  title: "Could not cancel job",
                  description: error instanceof Error ? error.message : String(error),
                  type: "error",
                }),
            })
          }}
        />
      ) : null}

      {selected ? (
        <JobDetailModal
          job={selected}
          open={Boolean(selected)}
          onOpenChange={(open) => {
            if (!open) setSelected(null)
          }}
        />
      ) : null}

      <Toaster />
    </TooltipProvider>
  )
}
