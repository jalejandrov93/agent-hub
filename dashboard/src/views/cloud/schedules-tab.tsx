import * as React from "react"
import { useSchedulesQuery, useCreateScheduleMutation, useUpdateScheduleMutation, useDeleteScheduleMutation, useRunScheduleNowMutation } from "@/lib/queries"
import { DataTable, type DataTableColumn } from "@/components/DataTable"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldLabel } from "@/components/ui/field"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Trash, Pencil, Play } from "lucide-react"
import { RelativeTime } from "@/components/RelativeTime"
import { StatusBadge } from "@/components/StatusBadge"
import type { CloudSchedule, CloudScheduleSpec } from "@/lib/types"

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const MIN_INTERVAL_MINUTES = 5
const DAILY_AT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function formatWeekdays(weekdays: number[]): string {
  if (weekdays.length === 0) return "every day"
  const sorted = [...weekdays].sort((a, b) => a - b)
  const isRange = sorted.length > 1 && sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1)
  if (isRange) return `${WEEKDAY_LABELS[sorted[0]]}–${WEEKDAY_LABELS[sorted[sorted.length - 1]]}`
  return sorted.map((d) => WEEKDAY_LABELS[d]).join(", ")
}

/** `schedule` is a permissive passthrough object on the wire (src/schemas.mjs); format it defensively. */
function formatSchedule(schedule: CloudSchedule["schedule"]): string {
  const kind = (schedule as { kind?: unknown })?.kind
  if (kind === "interval") {
    const everyMinutes = (schedule as { everyMinutes?: unknown }).everyMinutes
    return typeof everyMinutes === "number" ? `Every ${everyMinutes} min` : "Interval"
  }
  if (kind === "daily") {
    const at = (schedule as { at?: unknown }).at
    const weekdays = (schedule as { weekdays?: unknown }).weekdays
    const weekdayList = Array.isArray(weekdays) ? weekdays.filter((d): d is number => typeof d === "number") : []
    return typeof at === "string" ? `Daily at ${at} on ${formatWeekdays(weekdayList)}` : "Daily"
  }
  return "Unknown schedule"
}

function parseWeekdays(text: string): number[] {
  return text
    .split(",")
    .map((part) => parseInt(part.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
}

function ScheduleFormDialog({
  schedule,
  onClose,
  isOpen,
  onOpenChange
}: {
  schedule?: CloudSchedule
  onClose: () => void
  isOpen: boolean
  onOpenChange: (open: boolean) => void
}) {
  const existingSpec = schedule?.schedule as { kind?: string; everyMinutes?: number; at?: string; weekdays?: number[] } | undefined

  const [label, setLabel] = React.useState(schedule?.label ?? "")
  const [source, setSource] = React.useState(schedule?.source ?? "")
  const [prompt, setPrompt] = React.useState(schedule?.prompt ?? "")
  const [kind, setKind] = React.useState<"interval" | "daily">(existingSpec?.kind === "daily" ? "daily" : "interval")
  const [everyMinutes, setEveryMinutes] = React.useState(existingSpec?.everyMinutes?.toString() ?? "30")
  const [at, setAt] = React.useState(existingSpec?.at ?? "02:00")
  const [weekdaysText, setWeekdaysText] = React.useState(existingSpec?.weekdays?.join(", ") ?? "")

  React.useEffect(() => {
    if (isOpen) {
      setLabel(schedule?.label ?? "")
      setSource(schedule?.source ?? "")
      setPrompt(schedule?.prompt ?? "")
      setKind(existingSpec?.kind === "daily" ? "daily" : "interval")
      setEveryMinutes(existingSpec?.everyMinutes?.toString() ?? "30")
      setAt(existingSpec?.at ?? "02:00")
      setWeekdaysText(existingSpec?.weekdays?.join(", ") ?? "")
    }
  }, [isOpen, schedule, existingSpec])

  const createMut = useCreateScheduleMutation()
  const updateMut = useUpdateScheduleMutation()

  const isPending = createMut.isPending || updateMut.isPending

  const everyMinutesValid = Number.isInteger(parseInt(everyMinutes, 10)) && parseInt(everyMinutes, 10) >= MIN_INTERVAL_MINUTES
  const atValid = DAILY_AT_RE.test(at)
  const specValid = kind === "interval" ? everyMinutesValid : atValid

  const isValid = source.trim().length > 0 && prompt.trim().length > 0 && specValid

  const buildSpec = (): CloudScheduleSpec =>
    kind === "interval"
      ? { kind: "interval", everyMinutes: parseInt(everyMinutes, 10) }
      : { kind: "daily", at, weekdays: parseWeekdays(weekdaysText) }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValid) return

    const spec = buildSpec()

    if (schedule) {
      updateMut.mutate(
        { id: schedule.id, data: { label, schedule: spec, source, prompt } },
        { onSuccess: onClose }
      )
    } else {
      createMut.mutate(
        { label, schedule: spec, source, prompt, enabled: true },
        { onSuccess: onClose }
      )
    }
  }

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{schedule ? "Edit schedule" : "Add schedule"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="schedule-label">Label</FieldLabel>
            <Input id="schedule-label" value={label ?? ""} onChange={(e) => setLabel(e.target.value)} disabled={isPending} />
          </Field>
          <Field>
            <FieldLabel htmlFor="schedule-source">Source (sources/github/owner/repo)</FieldLabel>
            <Input id="schedule-source" value={source} onChange={(e) => setSource(e.target.value)} disabled={isPending} />
          </Field>
          <Field>
            <FieldLabel htmlFor="schedule-prompt">Prompt</FieldLabel>
            <Input id="schedule-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={isPending} />
          </Field>
          <Field>
            <FieldLabel htmlFor="schedule-kind">Recurrence</FieldLabel>
            <Select value={kind} onValueChange={(v) => setKind(v as "interval" | "daily")}>
              <SelectTrigger id="schedule-kind">
                <SelectValue placeholder="Select recurrence" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="interval">Interval</SelectItem>
                  <SelectItem value="daily">Daily</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </Field>
          {kind === "interval" ? (
            <Field>
              <FieldLabel htmlFor="schedule-every-minutes">Every N minutes (min {MIN_INTERVAL_MINUTES})</FieldLabel>
              <Input
                id="schedule-every-minutes"
                type="number"
                value={everyMinutes}
                onChange={(e) => setEveryMinutes(e.target.value)}
                disabled={isPending}
              />
            </Field>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor="schedule-at">Time (local, HH:MM)</FieldLabel>
                <Input id="schedule-at" type="time" value={at} onChange={(e) => setAt(e.target.value)} disabled={isPending} />
              </Field>
              <Field>
                <FieldLabel htmlFor="schedule-weekdays">Weekdays (0=Sun..6=Sat, blank = every day)</FieldLabel>
                <Input
                  id="schedule-weekdays"
                  value={weekdaysText}
                  onChange={(e) => setWeekdaysText(e.target.value)}
                  disabled={isPending}
                  placeholder="1, 2, 3, 4, 5"
                />
              </Field>
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
            <Button type="submit" disabled={!isValid || isPending}>{schedule ? "Save" : "Add"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ScheduleActions({ schedule }: { schedule: CloudSchedule }) {
  const [isEditOpen, setIsEditOpen] = React.useState(false)
  const [isDeleteOpen, setIsDeleteOpen] = React.useState(false)
  const deleteMut = useDeleteScheduleMutation()
  const runNowMut = useRunScheduleNowMutation()

  return (
    <div className="flex gap-2 justify-end">
      <Button variant="ghost" size="icon" aria-label="Run now" onClick={() => runNowMut.mutate(schedule.id)} disabled={runNowMut.isPending}>
        <Play className="size-4" />
      </Button>

      <Button variant="ghost" size="icon" aria-label="Edit schedule" onClick={() => setIsEditOpen(true)}>
        <Pencil className="size-4" />
      </Button>
      <ScheduleFormDialog schedule={schedule} isOpen={isEditOpen} onOpenChange={setIsEditOpen} onClose={() => setIsEditOpen(false)} />

      <Button variant="ghost" size="icon" aria-label="Delete schedule" className="text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={() => setIsDeleteOpen(true)}>
        <Trash className="size-4" />
      </Button>

      <ConfirmDialog
        open={isDeleteOpen}
        onOpenChange={setIsDeleteOpen}
        title="Delete schedule"
        description={`Are you sure you want to delete ${schedule.label ?? schedule.id}?`}
        onConfirm={() => deleteMut.mutate(schedule.id)}
        confirmLabel="Delete"
        destructive={true}
      />
    </div>
  )
}

export function SchedulesTab() {
  const { data, isLoading } = useSchedulesQuery()
  const [isAddOpen, setIsAddOpen] = React.useState(false)
  const updateMut = useUpdateScheduleMutation()

  if (isLoading || !data) {
    return <Skeleton className="h-64 w-full" />
  }

  const columns: DataTableColumn<CloudSchedule>[] = [
    {
      key: "label",
      header: "Label",
      cell: (row) => <div className="font-medium">{row.label ?? row.id}</div>,
    },
    {
      key: "schedule",
      header: "Schedule",
      cell: (row) => <div>{formatSchedule(row.schedule)}</div>,
    },
    {
      key: "source",
      header: "Source",
      cell: (row) => <div className="truncate max-w-xs" title={row.source}>{row.source}</div>,
    },
    {
      key: "enabled",
      header: "Enabled",
      cell: (row) => (
        <Button
          variant="outline"
          size="sm"
          onClick={() => updateMut.mutate({ id: row.id, data: { enabled: !row.enabled } })}
          disabled={updateMut.isPending}
        >
          {row.enabled ? "Enabled" : "Disabled"}
        </Button>
      ),
    },
    {
      key: "nextRun",
      header: "Next Run",
      cell: (row) => row.nextRunAt ? <RelativeTime iso={row.nextRunAt} /> : <span className="text-muted-foreground">-</span>,
    },
    {
      key: "lastRun",
      header: "Last Run",
      cell: (row) => row.lastRunAt ? <RelativeTime iso={row.lastRunAt} /> : <span className="text-muted-foreground">-</span>,
    },
    {
      key: "lastStatus",
      header: "Last Status",
      cell: (row) => row.lastStatus ? <StatusBadge kind="status" value={row.lastStatus} /> : <span className="text-muted-foreground">-</span>,
    },
    {
      key: "actions",
      header: "",
      cell: (row) => <ScheduleActions schedule={row} />,
      className: "text-right"
    }
  ]

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-end">
        <Button onClick={() => setIsAddOpen(true)}>Add schedule</Button>
        <ScheduleFormDialog isOpen={isAddOpen} onOpenChange={setIsAddOpen} onClose={() => setIsAddOpen(false)} />
      </div>
      <DataTable columns={columns} rows={data.schedules} getRowId={(row) => row.id} />
    </div>
  )
}
