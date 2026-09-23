import { BarChart3, Info } from "lucide-react"
import { useNavigate, useSearch } from "@tanstack/react-router"
import { TASK_TYPES } from "@shared"
import { PageHeader } from "@/components/PageHeader"
import { EmptyState } from "@/components/EmptyState"
import { DataTable, type DataTableColumn } from "@/components/DataTable"
import { StatusBadge } from "@/components/StatusBadge"
import { useMetricsQuery } from "@/lib/queries"
import { formatDuration, formatModel, formatNumber } from "@/lib/format"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import PixelCard from "@/components/reactbits/PixelCard"
import { CountUpValue } from "@/components/CountUpValue"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  XAxis,
  YAxis,
} from "recharts"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { MetricsRowT } from "@/lib/types"
import { chartHeightClass, mapMetricsChartRows } from "./chart-data"

const chartConfig: ChartConfig = {
  successRate: {
    label: "Success rate",
    color: "var(--chart-1)",
  },
}

function taskTypeLabel(taskType: string | null) {
  return taskType ?? "untagged"
}

function pairKey(row: MetricsRowT) {
  return `${row.agent}:${row.model}`
}

function errorEntries(row: MetricsRowT) {
  return Object.entries(row.errorKinds)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 2)
}

export function MetricsView() {
  const search = useSearch({ from: "/metrics" })
  const navigate = useNavigate({ from: "/metrics" })
  const metrics = useMetricsQuery()
  const rows = metrics.data?.rows ?? []
  const filteredRows = rows.filter((row) =>
    search.taskType === "untagged"
      ? row.taskType === null
      : !search.taskType || row.taskType === search.taskType
  )
  const sortedRows = [...filteredRows].sort((a, b) => b.samples - a.samples)
  const chartRows = mapMetricsChartRows(filteredRows)
  const totalSamples = filteredRows.reduce((sum, row) => sum + row.samples, 0)
  const succeeded = filteredRows.reduce((sum, row) => sum + row.succeeded, 0)
  const overallSuccessRate = totalSamples ? (succeeded / totalSamples) * 100 : null
  const lowSamplePairs = new Set(
    filteredRows.filter((row) => row.samples < 10).map(pairKey)
  ).size

  const columns: DataTableColumn<MetricsRowT>[] = [
    { key: "agent", header: "Agent", cell: (row) => row.agent },
    {
      key: "model",
      header: "Model",
      cell: (row) => <span title={row.model}>{formatModel(row.model)}</span>,
    },
    {
      key: "mode",
      header: "Mode",
      cell: (row) => <Badge variant="outline">{row.mode}</Badge>,
    },
    {
      key: "taskType",
      header: "Task type",
      cell: (row) => <Badge variant="secondary">{taskTypeLabel(row.taskType)}</Badge>,
    },
    {
      key: "samples",
      header: "Samples",
      cell: (row) => (
        <div className="flex items-center gap-2">
          <span>{formatNumber(row.samples)}</span>
          {row.samples < 10 ? <Badge variant="outline">low sample</Badge> : null}
        </div>
      ),
    },
    {
      key: "successRate",
      header: "Success rate",
      cell: (row) =>
        row.successRate == null ? "—" : `${(row.successRate * 100).toFixed(1)}%`,
    },
    {
      key: "p50",
      header: "p50",
      cell: (row) => formatDuration(row.p50Ms == null ? null : row.p50Ms / 1000),
    },
    {
      key: "p95",
      header: "p95",
      cell: (row) => formatDuration(row.p95Ms == null ? null : row.p95Ms / 1000),
    },
    {
      key: "errors",
      header: "Top errors",
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {errorEntries(row).length ? (
            errorEntries(row).map(([kind, count]) => (
              <StatusBadge key={kind} kind="errorKind" value={`${kind} (${count})`} />
            ))
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
      ),
    },
    {
      key: "tokens",
      header: "Avg tokens",
      cell: (row) => formatNumber(row.tokensAvg),
    },
    {
      key: "verified",
      header: "Verified",
      cell: (row) => {
        const hasSamples = typeof row.verifiedSamples === "number" && row.verifiedSamples > 0
        const rate = !hasSamples || row.verifiedRate == null ? "—" : `${(row.verifiedRate * 100).toFixed(1)}%`
        return <span>{rate}</span>
      },
    },
    {
      key: "quality",
      header: "Quality",
      cell: (row) => {
        const score = row.qualityScore == null ? "—" : row.qualityScore.toFixed(1)
        const isUnverified = row.verifiedSamples === 0 || row.verifiedSamples == null
        return (
          <div className="flex items-center gap-2">
            <span>{score}</span>
            {isUnverified ? <Badge variant="outline">unverified</Badge> : null}
          </div>
        )
      },
    },
    {
      key: "cost",
      header: "Avg cost",
      cell: (row) => (row.costUsdAvg == null ? "—" : `$${row.costUsdAvg.toFixed(4)}`),
    },
    {
      key: "revisions",
      header: "Avg revisions",
      cell: (row) => (row.revisionAvg == null ? "—" : row.revisionAvg.toFixed(2)),
    },
  ]

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Metrics"
        description="Success rate, latency, tokens, verified rate, and quality by task type."
        actions={
          <div className="flex items-center gap-2">
            <label htmlFor="metrics-task-type" className="text-sm text-muted-foreground">
              Task type
            </label>
            <Select
              value={search.taskType || "all"}
              onValueChange={(value) => {
                void navigate({
                  search: (previous) => ({
                    ...previous,
                    taskType: value === "all" || value == null ? "" : value,
                  }),
                })
              }}
            >
              <SelectTrigger id="metrics-task-type" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">All task types</SelectItem>
                  {TASK_TYPES.map((taskType) => (
                    <SelectItem key={taskType} value={taskType}>
                      {taskType}
                    </SelectItem>
                  ))}
                  <SelectItem value="untagged">untagged</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        }
      />

      <Alert>
        <Info />
        <AlertTitle>How metrics are used</AlertTitle>
        <AlertDescription>
          This feed powers adaptive timeouts and routing proposals. Jobs without a
          taskType are shown as &quot;untagged&quot; until delegate() receives taskType.
        </AlertDescription>
      </Alert>

      {metrics.isPending ? (
        <div className="text-sm text-muted-foreground">Loading metrics...</div>
      ) : metrics.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Unable to load metrics</AlertTitle>
          <AlertDescription>{metrics.error.message}</AlertDescription>
        </Alert>
      ) : filteredRows.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="No metrics yet"
          description="There are no metric rows for this task type."
        />
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <PixelCard noFocus className="rounded-xl">
              <Card className="h-full bg-transparent border-0 ring-0 shadow-none">
                <CardHeader>
                  <CardTitle>Total samples</CardTitle>
                </CardHeader>
                <CardContent className="text-2xl font-semibold">
                  <CountUpValue value={totalSamples} format={(v) => formatNumber(Math.round(v))} />
                </CardContent>
              </Card>
            </PixelCard>
            <PixelCard noFocus className="rounded-xl">
              <Card className="h-full bg-transparent border-0 ring-0 shadow-none">
                <CardHeader>
                  <CardTitle>Overall success rate</CardTitle>
                </CardHeader>
                <CardContent className="text-2xl font-semibold">
                  {overallSuccessRate == null ? (
                    <span className="tabular-nums">—</span>
                  ) : (
                    <CountUpValue
                      value={overallSuccessRate}
                      format={(v) => `${v.toFixed(1)}%`}
                    />
                  )}
                </CardContent>
              </Card>
            </PixelCard>
            <PixelCard noFocus className="rounded-xl">
              <Card className="h-full bg-transparent border-0 ring-0 shadow-none">
                <CardHeader>
                  <CardTitle>Pairs with low samples</CardTitle>
                </CardHeader>
                <CardContent className="text-2xl font-semibold">
                  <CountUpValue value={lowSamplePairs} format={(v) => formatNumber(Math.round(v))} />
                </CardContent>
              </Card>
            </PixelCard>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Success rate by agent and model</CardTitle>
            </CardHeader>
            <CardContent>
              <ChartContainer
                config={chartConfig}
                className={`w-full ${chartHeightClass(chartRows.length)}`}
              >
                <BarChart
                  accessibilityLayer
                  data={chartRows}
                  layout="vertical"
                  margin={{ left: 8, right: 8 }}
                >
                  <CartesianGrid horizontal={false} />
                  <XAxis
                    type="number"
                    domain={[0, 100]}
                    tickFormatter={(value) => `${value}%`}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={220}
                    tickFormatter={(value) =>
                      value.length > 32 ? `${value.slice(0, 29)}...` : value
                    }
                    tickLine={false}
                    axisLine={false}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value, _name, item) => {
                          const row = item.payload as (typeof chartRows)[number]
                          return (
                            <div className="flex flex-col gap-1">
                              <span>{Number(value).toFixed(1)}% success</span>
                              <span className="text-muted-foreground">
                                {formatNumber(row.samples)} samples · p95 {formatDuration(row.p95Ms == null ? null : row.p95Ms / 1000)}
                              </span>
                              {row.samples < 10 ? (
                                <span className="text-muted-foreground">low sample</span>
                              ) : null}
                            </div>
                          )
                        }}
                      />
                    }
                  />
                  <Bar dataKey="successRatePct" fill="var(--color-successRate)" radius={4}>
                    {chartRows.map((row) => (
                      <Cell key={row.name} fillOpacity={row.fillOpacity} />
                    ))}
                  </Bar>
                </BarChart>
              </ChartContainer>
            </CardContent>
          </Card>

          <DataTable
            columns={columns}
            rows={sortedRows}
            getRowId={(row) => `${row.agent}:${row.model}:${row.mode}:${row.taskType ?? "untagged"}`}
          />
        </>
      )}
    </div>
  )
}
