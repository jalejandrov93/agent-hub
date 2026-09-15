import * as React from "react"
import { CheckSquare, RefreshCw } from "lucide-react"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ConfirmDialog } from "@/components/ConfirmDialog"
import { DataTable, type DataTableColumn } from "@/components/DataTable"
import { EmptyState } from "@/components/EmptyState"
import { RelativeTime } from "@/components/RelativeTime"
import { StatusBadge } from "@/components/StatusBadge"
import { formatDuration } from "@/lib/format"
import {
  useDecideProposalMutation,
  useProposalsQuery,
  useRefreshProposalsMutation,
} from "@/lib/queries"
import type { ProposalT } from "@/lib/types"

type Pair = ProposalT["fromOrder"][number]

type StatusFilter = "pending" | "all"

type EvidenceRow = {
  pair: string
  samples: number
  successRate: number | null
  wilsonLow: number | null
  wilsonHigh: number | null
  p50Ms: number | null
}

const STATUS_ITEMS = [
  { value: "pending", label: "Pending" },
  { value: "all", label: "All statuses" },
]

function percent(value: number | null | undefined): string {
  if (value == null || Number.isNaN(Number(value))) return "—"
  return `${Math.round(Number(value) * 100)}%`
}

function wilsonRange(low: number | null | undefined, high: number | null | undefined): string {
  if (low == null || high == null) return "—"
  return `${percent(low)}–${percent(high)}`
}

function samePair(a: Pair | undefined, b: Pair | undefined): boolean {
  return Boolean(a && b && a.agent === b.agent && a.model === b.model)
}

function evidenceRows(proposal: ProposalT): EvidenceRow[] {
  return Object.entries(proposal.evidence).map(([pair, stats]) => ({
    pair,
    samples: stats.samples,
    successRate: stats.successRate ?? null,
    wilsonLow: stats.wilsonLow ?? null,
    wilsonHigh: stats.wilsonHigh ?? null,
    p50Ms: stats.p50Ms ?? null,
  }))
}

const EVIDENCE_COLUMNS: DataTableColumn<EvidenceRow>[] = [
  { key: "pair", header: "Pair", cell: (row) => <span className="truncate">{row.pair}</span> },
  { key: "samples", header: "Samples", cell: (row) => row.samples },
  { key: "successRate", header: "Success", cell: (row) => percent(row.successRate) },
  {
    key: "wilson",
    header: "Wilson 95%",
    cell: (row) => wilsonRange(row.wilsonLow, row.wilsonHigh),
  },
  {
    key: "p50",
    header: "p50",
    cell: (row) => (row.p50Ms == null ? "—" : formatDuration(row.p50Ms / 1000)),
  },
]

function OrderList({
  title,
  order,
  other,
}: {
  title: string
  order: Pair[]
  other: Pair[]
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ol className="flex flex-col gap-1">
        {order.map((pair, index) => {
          const changed = !samePair(pair, other[index])
          return (
            <li key={`${pair.agent}:${pair.model}:${index}`} className="flex min-w-0 items-center gap-2">
              <span className="text-muted-foreground">{index + 1}.</span>
              <span className="truncate">{pair.agent}</span>
              <span className="truncate text-muted-foreground">{pair.model}</span>
              {changed ? <Badge variant="secondary">changed</Badge> : null}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function ProposalCard({
  proposal,
  onAccept,
  onReject,
  rejecting,
}: {
  proposal: ProposalT
  onAccept: (proposal: ProposalT) => void
  onReject: (proposal: ProposalT) => void
  rejecting: boolean
}) {
  const rows = evidenceRows(proposal)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="capitalize">{proposal.taskType}</CardTitle>
        <CardAction>
          <StatusBadge kind="status" value={proposal.status} />
        </CardAction>
        <CardDescription>{proposal.reason}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <OrderList title="Current order" order={proposal.fromOrder} other={proposal.toOrder} />
          <OrderList title="Proposed order" order={proposal.toOrder} other={proposal.fromOrder} />
        </div>
        <DataTable
          columns={EVIDENCE_COLUMNS}
          rows={rows}
          getRowId={(row) => row.pair}
          emptyMessage="No evidence yet."
        />
      </CardContent>
      <CardFooter className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-xs text-muted-foreground">
          Created <RelativeTime iso={proposal.createdAt} />
          {proposal.decidedAt ? (
            <>
              {" · decided "}
              <RelativeTime iso={proposal.decidedAt} />
            </>
          ) : null}
        </span>
        {proposal.status === "pending" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={() => onReject(proposal)} disabled={rejecting}>
              Reject
            </Button>
            <Button onClick={() => onAccept(proposal)}>Accept</Button>
          </div>
        ) : null}
      </CardFooter>
    </Card>
  )
}

export function ProposalsPanel() {
  const { data, isLoading } = useProposalsQuery()
  const refresh = useRefreshProposalsMutation()
  const decide = useDecideProposalMutation()
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>("pending")
  const [accepting, setAccepting] = React.useState<ProposalT | null>(null)

  const proposals = data?.proposals ?? []
  const filtered =
    statusFilter === "pending" ? proposals.filter((p) => p.status === "pending") : proposals

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="outline"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          {refresh.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <RefreshCw data-icon="inline-start" />
          )}
          Refresh proposals
        </Button>
        <Select
          items={STATUS_ITEMS}
          value={statusFilter}
          onValueChange={(value) => setStatusFilter(value as StatusFilter)}
        >
          <SelectTrigger aria-label="Status filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {STATUS_ITEMS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <Card size="sm">
        <CardHeader>
          <CardDescription>
            Proposals only suggest a different routing order. Nothing changes until you accept one —
            accepting makes route() use the proposed order for that task type.
          </CardDescription>
        </CardHeader>
      </Card>

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={CheckSquare}
          title="No proposals"
          description="There is nothing waiting for a routing decision."
        />
      ) : (
        filtered.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            proposal={proposal}
            onAccept={setAccepting}
            onReject={(target) => decide.mutate({ id: target.id, decision: "reject" })}
            rejecting={decide.isPending && decide.variables?.decision === "reject"}
          />
        ))
      )}

      <ConfirmDialog
        open={accepting !== null}
        onOpenChange={(open) => {
          if (!open) setAccepting(null)
        }}
        title={`Accept proposal for ${accepting?.taskType ?? ""}`}
        description={`route() will use this order for ${accepting?.taskType ?? ""} tasks once you accept. Nothing changes before you accept.`}
        confirmLabel="Accept order"
        onConfirm={() => {
          if (accepting) decide.mutate({ id: accepting.id, decision: "accept" })
        }}
      />
    </div>
  )
}
