import type { ConfigResponseT, BreakerStateT } from "@/lib/types"
import { formatAge, formatDuration, formatModel } from "@/lib/format"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { DataTable, type DataTableColumn } from "@/components/DataTable"

const columns: DataTableColumn<BreakerStateT>[] = [
  {
    key: "agent",
    header: "Agent",
    cell: (row) => <span className="font-medium">{row.agent}</span>,
  },
  {
    key: "model",
    header: "Model",
    cell: (row) => (
      <span className="font-mono text-xs text-muted-foreground" title={row.model}>
        {formatModel(row.model)}
      </span>
    ),
  },
  {
    key: "state",
    header: "State",
    cell: (row) => (
      <Badge variant={row.open ? "destructive" : "outline"} className="text-[10px]">
        {row.open ? "open" : "closed"}
      </Badge>
    ),
  },
  {
    key: "failures",
    header: "Failures",
    cell: (row) => <span className="font-mono text-xs">{row.failureCount}</span>,
  },
  {
    key: "lastFailure",
    header: "Last failure",
    cell: (row) => (
      <span className="text-xs text-muted-foreground">
        {row.lastFailureAt ? formatAge(row.lastFailureAt) : "—"}
      </span>
    ),
  },
]

export function BreakerTab({ config }: { config: ConfigResponseT }) {
  const b = config.breaker || {
    windowMs: 0,
    failureThreshold: 0,
    failureKinds: [],
    immediateKinds: [],
  }

  const breakerStates = config.breakerState || []

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Breaker & TTL settings</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">Breaker window</dt>
              <dd className="font-mono text-sm">{formatDuration(b.windowMs / 1000)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Failure threshold</dt>
              <dd className="font-mono text-sm">{b.failureThreshold} failure(s)</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Failure kinds</dt>
              <dd className="font-mono text-xs text-muted-foreground">
                {(b.failureKinds || []).join(", ") || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Immediate kinds</dt>
              <dd className="font-mono text-xs text-muted-foreground">
                {(b.immediateKinds || []).join(", ") || "—"}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Breaker state</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={columns}
            rows={breakerStates}
            getRowId={(row) => `${row.agent}:${row.model}`}
            emptyMessage="No breaker state recorded"
          />
        </CardContent>
      </Card>
    </div>
  )
}
