import * as React from "react"
import { Activity } from "lucide-react"
import { useNavigate, useSearch, Link } from "@tanstack/react-router"
import { PageHeader } from "@/components/PageHeader"
import { EmptyState } from "@/components/EmptyState"
import { RelativeTime } from "@/components/RelativeTime"
import { StatusBadge } from "@/components/StatusBadge"
import { Badge } from "@/components/ui/badge"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useStateQuery } from "@/lib/queries"
import { useConnection } from "@/lib/sse"
import { useTimelineSeen } from "@/lib/timeline-seen"
import { formatModel } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { HubEventT } from "@/lib/types"
import { mergeTimelineEvents, matchesFilters } from "./events"

function TimelineSummary({ summary }: { summary: string }) {
  const [expanded, setExpanded] = React.useState(false)
  const isLong = summary.length > 80

  if (!isLong) {
    return <div className="text-xs text-muted-foreground break-words">{summary}</div>
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <div
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "text-xs text-muted-foreground cursor-pointer hover:text-foreground transition-colors",
          expanded ? "whitespace-pre-wrap break-words" : "truncate max-w-full"
        )}
      >
        {summary}
      </div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="text-[11px] font-medium text-primary hover:underline cursor-pointer"
        aria-expanded={expanded}
      >
        {expanded ? "Show less" : "Show more"}
      </button>
    </div>
  )
}

function TimelineRow({ event }: { event: HubEventT }) {
  const modelDisplay = event.model ? formatModel(event.model) : null
  const agentModelText = [event.agent, modelDisplay].filter(Boolean).join(" / ")
  const kindLabel =
    event.kind === "preflight" && (event as any).phase
      ? `${event.kind}:${(event as any).phase}`
      : event.kind

  return (
    <div className="flex flex-col gap-1.5 p-3.5 hover:bg-muted/40 transition-colors">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Tooltip>
            <TooltipTrigger className="cursor-help font-mono text-xs text-muted-foreground hover:text-foreground">
              <RelativeTime iso={event.ts} />
            </TooltipTrigger>
            <TooltipContent>
              <span>{event.ts}</span>
            </TooltipContent>
          </Tooltip>

          <Badge variant="outline" className="font-mono text-[11px] font-normal">
            {kindLabel}
          </Badge>

          {event.errorKind ? <StatusBadge kind="errorKind" value={event.errorKind} /> : null}

          {agentModelText ? (
            <span
              className="text-xs text-muted-foreground"
              title={event.model ?? undefined}
            >
              {agentModelText}
            </span>
          ) : null}
        </div>

        {event.jobId ? (
          <Link
            to="/history"
            search={{ q: event.jobId, status: "all", agent: "" }}
            className="font-mono text-xs text-muted-foreground hover:text-foreground hover:underline shrink-0"
          >
            {event.jobId}
          </Link>
        ) : null}
      </div>

      {event.title ? (
        <div className="text-sm font-medium text-foreground">{event.title}</div>
      ) : null}

      {event.summary ? <TimelineSummary summary={event.summary} /> : null}
    </div>
  )
}

export function TimelineView() {
  const search = (useSearch({ strict: false }) ?? {}) as { source?: string; q?: string }
  const source = search.source ?? ""
  const q = search.q ?? ""
  const navigate = useNavigate()

  const [kind, setKind] = React.useState<string>("all")

  const stateQuery = useStateQuery()
  const { events: sseEvents } = useConnection()
  const [, markSeen] = useTimelineSeen()

  const allEvents = React.useMemo(() => {
    const serverEvents = stateQuery.data?.events ?? []
    return mergeTimelineEvents(serverEvents, sseEvents)
  }, [stateQuery.data?.events, sseEvents])

  // Mark seen on mount and when new events arrive while mounted
  const newestTs = allEvents[0]?.ts
  React.useEffect(() => {
    if (newestTs) {
      markSeen(newestTs)
    }
  }, [newestTs, markSeen])

  const filteredEvents = React.useMemo(() => {
    return allEvents.filter((event) => matchesFilters(event, { source, kind, q }))
  }, [allEvents, source, kind, q])

  const emptyTitle =
    q || (source && source !== "all") || (kind && kind !== "all")
      ? "No matching events found"
      : "No events in event log"
  const emptyDescription =
    q || (source && source !== "all") || (kind && kind !== "all")
      ? "Try clearing your filters or search query."
      : "System and hook events will stream here live."

  return (
    <TooltipProvider delay={200}>
      <div className="flex flex-1 flex-col min-h-0 gap-3">
        <PageHeader
          title="Timeline"
          description="Every hub and claude-hook event, newest first."
        />

        <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 bg-background/95 pb-2 backdrop-blur">
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              value={[source || "all"]}
              onValueChange={(val) => {
                const next = val[0] || "all"
                navigate({
                  to: "/timeline",
                  search: (prev: any) => ({
                    ...prev,
                    source: next === "all" ? "" : next,
                  }),
                  replace: true,
                })
              }}
              aria-label="Filter by source"
            >
              <ToggleGroupItem value="all">All</ToggleGroupItem>
              <ToggleGroupItem value="hub">hub</ToggleGroupItem>
              <ToggleGroupItem value="claude-hook">claude-hook</ToggleGroupItem>
            </ToggleGroup>

            <Select value={kind} onValueChange={(val) => setKind(val ?? "all")}>
              <SelectTrigger aria-label="Filter by kind" className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">All kinds</SelectItem>
                  <SelectItem value="job.*">job.*</SelectItem>
                  <SelectItem value="preflight">preflight</SelectItem>
                  <SelectItem value="subagent.*">subagent.*</SelectItem>
                  <SelectItem value="proposal.*">proposal.*</SelectItem>
                  <SelectItem value="learning.*">learning.*</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <Field className="w-full sm:w-64">
            <FieldLabel className="sr-only">Search timeline</FieldLabel>
            <Input
              type="search"
              placeholder="Search timeline..."
              aria-label="Search timeline"
              value={q}
              onChange={(e) => {
                navigate({
                  to: "/timeline",
                  search: (prev: any) => ({ ...prev, q: e.target.value }),
                  replace: true,
                })
              }}
            />
          </Field>
        </div>

        <ScrollArea className="flex-1 min-h-0 w-full rounded-lg border bg-card text-card-foreground">
          {filteredEvents.length === 0 ? (
            <div className="p-8">
              <EmptyState icon={Activity} title={emptyTitle} description={emptyDescription} />
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-border">
              {filteredEvents.map((event) => (
                <TimelineRow
                  key={`${event.ts}:${event.kind}:${event.jobId ?? ""}`}
                  event={event}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </div>
    </TooltipProvider>
  )
}
