import * as React from "react"
import { StatusBadge } from "@/components/StatusBadge"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { formatModel } from "@/lib/format"
import type { Job } from "@/lib/types"
import { JobResultPanel } from "./JobResultPanel"

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-mono text-xs">{children}</span>
    </div>
  )
}

export function JobDetailSheet({
  job,
  open,
  onOpenChange,
}: {
  job: Job
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-4 overflow-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="truncate pr-8">{job.title || "Untitled job"}</SheetTitle>
          <SheetDescription className="flex flex-wrap items-center gap-2">
            <StatusBadge kind="status" value={job.status} />
            <span>{job.agent}</span>
            <span className="text-muted-foreground">{formatModel(job.model)}</span>
            {job.mode ? <Badge variant="secondary">{job.mode}</Badge> : null}
            {job.taskType ? <Badge variant="outline">{job.taskType}</Badge> : null}
          </SheetDescription>
        </SheetHeader>

        <Separator />

        <div className="flex flex-col gap-2">
          <DetailRow label="Job id">{job.jobId}</DetailRow>
          <DetailRow label="Session id">{job.sessionId ?? "—"}</DetailRow>
          {job.parentJobId ? <DetailRow label="Reply of">{job.parentJobId}</DetailRow> : null}
          <DetailRow label="Turn depth">{job.turnDepth ?? "—"}</DetailRow>
          <DetailRow label="Learnings">{job.learningIds?.length ?? 0}</DetailRow>
          <DetailRow label="PID">{job.pid ?? "—"}</DetailRow>
        </div>

        <Separator />

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Partial output</h3>
          <JobResultPanel jobId={job.jobId} open={open} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
