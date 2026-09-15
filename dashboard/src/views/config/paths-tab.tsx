import type { ConfigResponseT } from "@/lib/types"
import { formatDuration, formatModel } from "@/lib/format"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { DataTable, type DataTableColumn } from "@/components/DataTable"

type TimeoutRow = {
  id: string
  agent: string
  model: string
  seconds: number
}

const timeoutColumns: DataTableColumn<TimeoutRow>[] = [
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
    key: "timeout",
    header: "Timeout",
    cell: (row) => <span className="font-mono text-xs">{row.seconds}s</span>,
  },
]

export function PathsTab({ config }: { config: ConfigResponseT }) {
  const timeoutRows: TimeoutRow[] = []
  const timeouts = config.timeouts || {}

  for (const [agent, models] of Object.entries(timeouts)) {
    for (const [model, seconds] of Object.entries(models)) {
      timeoutRows.push({
        id: `${agent}:${model}`,
        agent,
        model,
        seconds,
      })
    }
  }

  const allowlist = config.writeAllowlist || []

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Storage & TTL</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">State directory (agentHubHome)</dt>
              <dd className="font-mono text-xs break-all text-foreground">
                {config.agentHubHome || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Preflight TTL (ttlMs)</dt>
              <dd className="font-mono text-sm text-foreground">
                {formatDuration((config.ttlMs || 0) / 1000)}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Write allowlist</CardTitle>
        </CardHeader>
        <CardContent>
          {allowlist.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Write allowlist is empty. Write mode requires a secondary git worktree registered in the allowlist.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {allowlist.map((item) => (
                <li
                  key={item}
                  className="rounded-md bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground"
                >
                  {item}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle>Timeouts</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={timeoutColumns}
            rows={timeoutRows}
            getRowId={(row) => row.id}
            emptyMessage="No timeouts configured"
          />
        </CardContent>
      </Card>
    </div>
  )
}
