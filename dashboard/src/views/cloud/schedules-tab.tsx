import * as React from "react"
import { useSchedulesQuery, useCreateScheduleMutation, useUpdateScheduleMutation, useDeleteScheduleMutation, useRunScheduleNowMutation } from "@/lib/queries"
import { DataTable, type DataTableColumn } from "@/components/DataTable"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldLabel } from "@/components/ui/field"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Trash, Pencil, Play } from "lucide-react"
import { RelativeTime } from "@/components/RelativeTime"
import { StatusBadge } from "@/components/StatusBadge"
import type { CloudSchedule } from "@/lib/types"

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
  const [label, setLabel] = React.useState(schedule?.label ?? "")
  const [scheduleCron, setScheduleCron] = React.useState(schedule?.schedule ?? "")
  const [source, setSource] = React.useState(schedule?.source ?? "")

  React.useEffect(() => {
    if (isOpen) {
      setLabel(schedule?.label ?? "")
      setScheduleCron(schedule?.schedule ?? "")
      setSource(schedule?.source ?? "")
    }
  }, [isOpen, schedule])

  const createMut = useCreateScheduleMutation()
  const updateMut = useUpdateScheduleMutation()

  const isPending = createMut.isPending || updateMut.isPending

  const isValid = label.trim().length > 0 && scheduleCron.trim().length > 0 && source.trim().length > 0

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!isValid) return

    if (schedule) {
      updateMut.mutate(
        { id: schedule.id, data: { label, schedule: scheduleCron, source } },
        { onSuccess: onClose }
      )
    } else {
      createMut.mutate(
        { label, schedule: scheduleCron, source, enabled: true },
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
            <Input id="schedule-label" value={label} onChange={(e) => setLabel(e.target.value)} disabled={isPending} />
          </Field>
          <Field>
            <FieldLabel htmlFor="schedule-cron">Schedule (Cron or Interval)</FieldLabel>
            <Input id="schedule-cron" value={scheduleCron} onChange={(e) => setScheduleCron(e.target.value)} disabled={isPending} placeholder="e.g. 5m or daily at 10:00" />
          </Field>
          <Field>
            <FieldLabel htmlFor="schedule-source">Source (Repo)</FieldLabel>
            <Input id="schedule-source" value={source} onChange={(e) => setSource(e.target.value)} disabled={isPending} />
          </Field>
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
        description={`Are you sure you want to delete ${schedule.label}?`}
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
      cell: (row) => <div className="font-medium">{row.label}</div>,
    },
    {
      key: "schedule",
      header: "Schedule",
      cell: (row) => <div>{row.schedule}</div>,
    },
    {
      key: "source",
      header: "Source",
      cell: (row) => <div>{row.source}</div>,
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
      cell: (row) => row.nextRun ? <RelativeTime iso={row.nextRun} /> : <span className="text-muted-foreground">-</span>,
    },
    {
      key: "lastRun",
      header: "Last Run",
      cell: (row) => row.lastRun ? <RelativeTime iso={row.lastRun} /> : <span className="text-muted-foreground">-</span>,
    },
    {
      key: "lastResult",
      header: "Last Result",
      cell: (row) => row.lastResult ? (
        <StatusBadge
          kind="status"
          value={row.lastResult === "success" ? "succeeded" : "failed"}
        />
      ) : <span className="text-muted-foreground">-</span>,
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
