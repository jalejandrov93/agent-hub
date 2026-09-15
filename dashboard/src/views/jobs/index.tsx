import * as React from "react"
import { Link } from "@tanstack/react-router"
import { PlayCircle } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { EmptyState } from "@/components/EmptyState"
import { DataTable, type DataTableColumn } from "@/components/DataTable"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { RelativeTime } from "@/components/RelativeTime"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Toaster, toast } from "@/components/ui/toast"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { runningJobs } from "@/lib/badges"
import { formatDuration, formatModel } from "@/lib/format"
import { useCancelJobMutation, useStateQuery } from "@/lib/queries"
import type { Job } from "@/lib/types"
import { ElapsedCell } from "./ElapsedCell"
import { JobDetailSheet } from "./JobDetailSheet"

const PAGE_HEADER = {
  title: "Running jobs",
  description: "Queued and in-progress jobs.",
} as const

function CwdCell({ cwd }: { cwd: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="block max-w-[16rem] truncate text-left" />}>
        {cwd}
      </TooltipTrigger>
      <TooltipContent className="max-w-md break-all">{cwd}</TooltipContent>
    </Tooltip>
  )
}

export function JobsView() {
  const stateQuery = useStateQuery()
  const cancelJob = useCancelJobMutation()
  const [selected, setSelected] = React.useState<Job | null>(null)
  const [pendingCancel, setPendingCancel] = React.useState<Job | null>(null)

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
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">{job.agent}</span>
          <span className="truncate text-xs text-muted-foreground" title={job.model}>
            {formatModel(job.model)}
          </span>
        </div>
      ),
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
      key: "cwd",
      header: "Working dir",
      cell: (job) => <CwdCell cwd={job.cwd} />,
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
      key: "actions",
      header: <span className="sr-only">Actions</span>,
      className: "text-right",
      cell: (job) => (
        <Button
          variant="destructive"
          size="xs"
          onClick={(event) => {
            event.stopPropagation()
            setPendingCancel(job)
          }}
        >
          Cancel
        </Button>
      ),
    },
  ]

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
      ) : jobs.length === 0 ? (
        <EmptyState
          icon={PlayCircle}
          title="No jobs running"
          description="Jobs you delegate show up here while they are queued or running."
        >
          <Button variant="outline" size="sm" render={<Link to="/history" />}>
            View job history
          </Button>
        </EmptyState>
      ) : (
        <DataTable columns={columns} rows={jobs} getRowId={(job) => job.jobId} onRowClick={setSelected} />
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
        <JobDetailSheet
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
