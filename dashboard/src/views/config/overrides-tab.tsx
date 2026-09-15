import { useState } from "react"
import { Sliders } from "lucide-react"
import type { ConfigResponseT, OverrideT } from "@/lib/types"
import { useClearOverrideMutation } from "@/lib/queries"
import { formatAge } from "@/lib/format"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/EmptyState"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { DataTable, type DataTableColumn } from "@/components/DataTable"
import { toast } from "@/components/ui/toast"

type OverrideRow = {
  key: string
  agent: string
  model: string
  hold?: boolean
  breakerReset?: string
  reason?: string
  setAt?: string
}

export function OverridesTab({ config }: { config: ConfigResponseT }) {
  const [target, setTarget] = useState<OverrideRow | null>(null)
  const clearMutation = useClearOverrideMutation()

  const rawOverrides = config.overrides
  const rows: OverrideRow[] = []

  if (rawOverrides && !Array.isArray(rawOverrides) && typeof rawOverrides === "object") {
    for (const [key, val] of Object.entries(rawOverrides as Record<string, OverrideT>)) {
      const sep = key.indexOf(":")
      const agent = sep !== -1 ? key.slice(0, sep) : key
      const model = sep !== -1 ? key.slice(sep + 1) : ""
      rows.push({
        key,
        agent,
        model,
        hold: val?.hold,
        breakerReset: val?.breakerReset,
        reason: val?.reason,
        setAt: val?.setAt,
      })
    }
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Sliders}
        title="No overrides set"
        description="No manual holds or breaker resets are currently set."
      />
    )
  }

  const columns: DataTableColumn<OverrideRow>[] = [
    {
      key: "pair",
      header: "Pair",
      cell: (row) => <span className="font-mono text-xs font-medium">{row.key}</span>,
    },
    {
      key: "hold",
      header: "Hold",
      cell: (row) =>
        row.hold ? (
          <Badge variant="outline" className="border-warning/50 text-warning text-[10px]">
            held
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: "breakerReset",
      header: "Breaker reset",
      cell: (row) => (
        <span className="font-mono text-xs text-muted-foreground">
          {row.breakerReset || "—"}
        </span>
      ),
    },
    {
      key: "reason",
      header: "Reason",
      cell: (row) => <span className="text-xs">{row.reason || "—"}</span>,
    },
    {
      key: "setAt",
      header: "Set at",
      cell: (row) => (
        <span className="text-xs text-muted-foreground">
          {row.setAt ? formatAge(row.setAt) : "—"}
        </span>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      cell: (row) => (
        <Button
          variant="ghost"
          size="sm"
          disabled={clearMutation.isPending}
          onClick={() => setTarget(row)}
        >
          Clear
        </Button>
      ),
    },
  ]

  const handleConfirmClear = () => {
    if (!target) return
    const currentTarget = target
    clearMutation.mutate(
      { agent: currentTarget.agent, model: currentTarget.model },
      {
        onSuccess: () => {
          toast.add({
            title: "Override cleared",
            description: `Cleared override for ${currentTarget.key}.`,
            type: "success",
          })
        },
        onError: (err) => {
          toast.add({
            title: "Failed to clear override",
            description: err instanceof Error ? err.message : "Request failed",
            type: "error",
          })
        },
      }
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Overrides</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            rows={rows}
            getRowId={(row) => row.key}
            emptyMessage="No overrides set"
          />
        </CardContent>
      </Card>

      <ConfirmDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null)
        }}
        title="Clear override"
        description={`Are you sure you want to clear the override for ${target?.key}?`}
        confirmLabel="Clear"
        destructive
        onConfirm={handleConfirmClear}
      />
    </div>
  )
}
