import * as React from "react"
import { Link } from "@tanstack/react-router"
import { Copy, Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { StatusBadge } from "@/components/StatusBadge"
import { formatAge, formatDuration, formatModel } from "@/lib/format"
import type { WorkGraphJobNode } from "@/lib/types"
import type { LaidOutLane } from "./layout"

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children ?? "—"}</dd>
    </div>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{children}</h3>
}

/** Small copy-to-clipboard affordance for a monospace token (jobId, branch). */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = React.useState(false)

  return (
    <button
      type="button"
      aria-label={`Copy ${label}`}
      onClick={(e) => {
        e.stopPropagation()
        navigator.clipboard?.writeText(value).catch(() => {})
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      }}
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground",
        "transition-colors duration-150 hover:bg-muted hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      )}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  )
}

function CopyableToken({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex items-center gap-1 font-mono text-xs break-all">
      {value}
      <CopyButton value={value} label={label} />
    </span>
  )
}

/** Side panel for one work-graph job leaf: identity, timing, git location, and links (Job history / PR). */
export function JobDetailPanel({
  job,
  lane,
  onOpenChange,
}: {
  job: WorkGraphJobNode | null
  lane: LaidOutLane | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Sheet open={job !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        {job ? (
          <>
            <SheetHeader>
              <SheetTitle>{job.title || "Untitled job"}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <StatusBadge kind="status" value={job.status} />
                <CopyableToken value={job.jobId} label="job ID" />
              </SheetDescription>
            </SheetHeader>
            <Separator />
            <div className="flex flex-col gap-5 px-4 py-4">
              <section className="flex flex-col gap-2">
                <SectionHeading>Identity</SectionHeading>
                <dl className="grid grid-cols-2 gap-4">
                  <DetailRow label="Agent">{job.agent}</DetailRow>
                  <DetailRow label="Model">
                    <span title={job.model}>{formatModel(job.model)}</span>
                  </DetailRow>
                  <DetailRow label="Mode">{job.mode}</DetailRow>
                  <DetailRow label="Task type">{job.taskType ?? "—"}</DetailRow>
                </dl>
              </section>

              <section className="flex flex-col gap-2">
                <SectionHeading>Timing</SectionHeading>
                <dl className="grid grid-cols-2 gap-4">
                  <DetailRow label="Created">{formatAge(job.createdAt)}</DetailRow>
                  <DetailRow label="Updated">{formatAge(job.updatedAt)}</DetailRow>
                  <DetailRow label="Duration">{formatDuration(job.durationS)}</DetailRow>
                </dl>
              </section>

              {lane ? (
                <section className="flex flex-col gap-2">
                  <SectionHeading>Git location</SectionHeading>
                  <dl className="grid grid-cols-2 gap-4">
                    <DetailRow label="Branch">
                      <CopyableToken value={lane.label} label="branch" />
                    </DetailRow>
                    {lane.sublabel ? <DetailRow label="Location">{lane.sublabel}</DetailRow> : null}
                  </dl>
                </section>
              ) : null}

              <section className="flex flex-wrap gap-2 border-t pt-4">
                <Button
                  variant="outline"
                  size="sm"
                  render={<Link to="/history" search={{ q: job.jobId, status: "all", agent: "" }} />}
                >
                  View in Job history
                </Button>
                {job.prUrl ? (
                  <Button variant="outline" size="sm" render={<a href={job.prUrl} target="_blank" rel="noreferrer" />}>
                    Open PR
                  </Button>
                ) : null}
              </section>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
