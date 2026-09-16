import * as React from "react"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { StatusBadge } from "@/components/StatusBadge"
import { breakerFor, overrideFor } from "@/lib/badges"
import { formatAge, formatLatency, formatModel } from "@/lib/format"
import type { AgentRow, DerivedState, QuotaInfoT, QuotaWindowT } from "@/lib/types"

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children ?? "—"}</dd>
    </div>
  )
}

export function AgentDetailSheet({
  row,
  state,
  onOpenChange,
}: {
  row: AgentRow | null
  state: DerivedState
  onOpenChange: (open: boolean) => void
}) {
  const breaker = row ? breakerFor(state, row.agent, row.model) : null
  const override = row ? overrideFor(state, row.agent, row.model) : null
  const discovery = row ? state.config?.discovery?.[row.agent] : undefined
  const models = discovery?.models ?? []

  let quotaInfo: QuotaInfoT | null = null
  if (row) {
    if (row.quota) {
      quotaInfo = row.quota
    } else if (state.quota) {
      const q = state.quota.find((q) => q.agent === row.agent && q.model === row.model)
      if (q && q.quota) quotaInfo = q.quota
    }
  }

  return (
    <Sheet open={row !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-md">
        {row ? (
          <>
            <SheetHeader>
              <SheetTitle>
                {row.agent} / {formatModel(row.model)}
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <StatusBadge kind="status" value={row.status} />
                <span className="font-mono text-xs break-all">{row.model}</span>
              </SheetDescription>
            </SheetHeader>
            <Separator />
            <dl className="grid grid-cols-2 gap-4 px-4 py-4">
              <DetailRow label="Reason">{row.reason || "—"}</DetailRow>
              <DetailRow label="Ladder level">{row.ladderLevel || "—"}</DetailRow>
              <DetailRow label="Latency">{formatLatency(row.latencyMs)}</DetailRow>
              <DetailRow label="Quota signal">{row.quotaSignal || "—"}</DetailRow>
              <DetailRow label="Data policy">{row.dataPolicy || "—"}</DetailRow>
              <DetailRow label="Checked">{formatAge(row.checkedAt)}</DetailRow>
              <DetailRow label="Bin path">{row.binPath || "—"}</DetailRow>
              <DetailRow label="CLI version">{row.cliVersion || "—"}</DetailRow>
              <DetailRow label="Breaker failures">
                {breaker ? String(breaker.failureCount) : "0"}
                {breaker?.open ? <span className="text-destructive"> (open)</span> : null}
              </DetailRow>
              <DetailRow label="Last failure">{breaker?.lastFailureAt ? formatAge(breaker.lastFailureAt) : "—"}</DetailRow>
              <DetailRow label="Hold">{override?.hold ? "yes" : "no"}</DetailRow>
              <DetailRow label="Override set">{override?.setAt ? formatAge(override.setAt) : "—"}</DetailRow>
              {override?.breakerReset ? (
                <DetailRow label="Breaker reset">{override.breakerReset}</DetailRow>
              ) : null}

              <div className="col-span-2 flex flex-col gap-2 pt-2 border-t mt-2">
                <dt className="text-xs font-semibold uppercase text-muted-foreground">Quota</dt>
                {quotaInfo?.note ? (
                  <span className="text-sm text-muted-foreground">{quotaInfo.note}</span>
                ) : quotaInfo?.quotaUnavailableReason ? (
                  <span className="text-sm text-muted-foreground flex gap-1 items-center">
                    <span className="w-2 h-2 rounded-full bg-warning"></span>
                    Unavailable: {quotaInfo.quotaUnavailableReason}
                  </span>
                ) : quotaInfo?.windows?.length ? (
                  <div className="flex flex-col gap-2">
                    {quotaInfo.windows.map((w: QuotaWindowT) => {
                      const isExhausted = w.usageKnown && typeof w.usedPercent === 'number' && w.usedPercent >= 100
                      const resetDesc = w.resetsAt ? `resets ${formatAge(w.resetsAt)}` : ""
                      return (
                        <div key={w.id} className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-medium w-32 truncate" title={w.label}>{w.label}</span>
                          {w.usageKnown ? (
                            <>
                              <Badge variant={isExhausted ? "destructive" : "secondary"}>
                                {w.usedPercent?.toFixed(0)}%
                              </Badge>
                              {resetDesc && <span className="text-xs text-muted-foreground">{resetDesc}</span>}
                            </>
                          ) : (
                            <span className="text-xs text-muted-foreground">unknown usage</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <span className="text-sm text-muted-foreground">—</span>
                )}
              </div>

              <div className="col-span-2 flex flex-col gap-1 mt-2">
                <dt className="text-xs text-muted-foreground">Discovery models ({models.length})</dt>
                <dd className="flex flex-wrap gap-1">
                  {models.length ? (
                    models.map((model) => (
                      <Badge key={model.id} variant="outline">
                        {model.label ?? model.id}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </dd>
              </div>
              {discovery?.error ? (
                <div className="col-span-2">
                  <DetailRow label="Discovery error">
                    <span className="text-destructive">{discovery.error}</span>
                  </DetailRow>
                </div>
              ) : null}
            </dl>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
