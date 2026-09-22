import * as React from "react"
import { DiffStatsSummary } from "@/components/DiffStatsSummary"
import { DiffStatsTable } from "@/components/DiffStatsTable"
import { StatusBadge } from "@/components/StatusBadge"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { formatModel } from "@/lib/format"
import type { Job } from "@/lib/types"
import { JobResultPanel } from "./JobResultPanel"
import { useJobDiffStatsQuery } from "./useJobDiffStats"

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-mono text-xs">{children}</span>
    </div>
  )
}

/**
 * D2 (agy-hub-verification): the hub-run `verify` result once a job
 * succeeds (docs/verification.md) — never rendered for a job that was never
 * given a `verify` array. Status is text + Badge, never color-only.
 */
function VerificationSection({ verification }: { verification: Job["verification"] }) {
  if (!verification) return null

  const overallLabel = verification.skipped ? "Skipped" : verification.ok ? "Passed" : "Failed"
  const overallVariant = verification.skipped ? "secondary" : verification.ok ? "outline" : "destructive"

  return (
    <>
      <Separator />
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Verification</h3>
          <Badge variant={overallVariant}>{overallLabel}</Badge>
        </div>
        {verification.skipped ? (
          <p className="text-xs text-muted-foreground">{verification.reason ?? "Verification was skipped."}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {verification.checks.map((check) => (
              <div key={check.name} className="flex flex-col gap-1 rounded-md border p-2 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono">{check.name}</span>
                  <Badge variant={check.ok ? "outline" : "destructive"}>{check.ok ? "ok" : "failed"}</Badge>
                </div>
                {!check.ok && check.outputTail ? (
                  <pre className="max-h-32 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
                    {check.outputTail}
                  </pre>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

export function JobDetailModal({
  job,
  open,
  onOpenChange,
}: {
  job: Job
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const isWrite = job.mode === "write"
  const diffStatsQuery = useJobDiffStatsQuery(job.jobId, isWrite && open)
  const diffStats = diffStatsQuery.data?.diffStats ?? null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="truncate pr-8">{job.title || "Untitled job"}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            <StatusBadge kind="status" value={job.status} />
            <span>{job.agent}</span>
            <span className="text-muted-foreground">{formatModel(job.model)}</span>
            {job.mode ? <Badge variant="secondary">{job.mode}</Badge> : null}
            {job.taskType ? <Badge variant="outline">{job.taskType}</Badge> : null}
          </DialogDescription>
        </DialogHeader>

        <Separator />

        <div className="flex flex-col gap-2">
          <DetailRow label="Job id">{job.jobId}</DetailRow>
          <DetailRow label="Session id">{job.sessionId ?? "—"}</DetailRow>
          {job.parentJobId ? <DetailRow label="Reply of">{job.parentJobId}</DetailRow> : null}
          <DetailRow label="Turn depth">{job.turnDepth ?? "—"}</DetailRow>
          <DetailRow label="Learnings">{job.learningIds?.length ?? 0}</DetailRow>
          <DetailRow label="PID">{job.pid ?? "—"}</DetailRow>
        </div>

        {isWrite && diffStats ? (
          <>
            <Separator />
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium">Changes</h3>
                <DiffStatsSummary stats={diffStats} />
              </div>
              <DiffStatsTable files={diffStats.files} truncated={diffStats.truncated} />
            </div>
          </>
        ) : null}

        <VerificationSection verification={job.verification} />

        <Separator />

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Partial output</h3>
          <JobResultPanel jobId={job.jobId} open={open} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
