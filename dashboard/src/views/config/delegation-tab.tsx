import { Link } from "@tanstack/react-router"
import type { ConfigResponseT } from "@/lib/types"
import { useProposalsQuery } from "@/lib/queries"
import { formatModel } from "@/lib/format"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { EmptyState } from "@/components/EmptyState"
import { Route } from "lucide-react"

type Step = {
  agent: string
  model: string
  mode?: string
  parallelWith?: Step
}

function StepItem({ step, index }: { step: Step; index: number }) {
  const isClaude = step.agent === "claude"
  const modelLabel = step.model ? formatModel(step.model) : ""

  return (
    <div className="flex flex-col gap-1 rounded-md border bg-muted/20 p-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold text-muted-foreground">
          #{index + 1}
        </span>
        <span className="font-medium text-foreground">
          {step.agent}
          {modelLabel ? `:${modelLabel}` : ""}
        </span>
        {step.mode ? (
          <Badge variant="outline" className="text-[10px]">
            {step.mode}
          </Badge>
        ) : null}
        {isClaude ? (
          <span className="text-xs text-muted-foreground">Claude Agent tool</span>
        ) : null}
      </div>
      {step.parallelWith ? (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-5 text-xs text-muted-foreground">
          <span className="font-medium">parallel with</span>
          <span className="font-medium text-foreground">
            {step.parallelWith.agent}
            {step.parallelWith.model ? `:${formatModel(step.parallelWith.model)}` : ""}
          </span>
          {step.parallelWith.mode ? (
            <Badge variant="outline" className="text-[10px]">
              {step.parallelWith.mode}
            </Badge>
          ) : null}
          {step.parallelWith.agent === "claude" ? (
            <span className="text-xs text-muted-foreground">Claude Agent tool</span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function DelegationTab({ config }: { config: ConfigResponseT }) {
  const { data: proposalsData } = useProposalsQuery()
  const proposals = proposalsData?.proposals ?? []

  const entries = Object.entries(config.delegationMap || {})

  if (entries.length === 0) {
    return (
      <EmptyState
        icon={Route}
        title="No delegation map configured"
        description="Task-type routing will appear here once configured."
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {entries.map(([taskType, entry]) => {
        const hasAcceptedProposal = proposals.some(
          (p) => p.taskType === taskType && p.status === "accepted"
        )

        return (
          <Card key={taskType}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <div className="flex items-center gap-2">
                <CardTitle>{taskType}</CardTitle>
                {hasAcceptedProposal ? (
                  <Badge
                    variant="secondary"
                    render={<Link to="/approvals" search={{ tab: "proposals" }} />}
                  >
                    reordered by proposal
                  </Badge>
                ) : null}
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">{entry.why}</p>
              <div className="flex flex-col gap-2">
                {entry.chain.map((step, idx) => (
                  <StepItem key={`${step.agent}-${step.model}-${idx}`} step={step} index={idx} />
                ))}
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
