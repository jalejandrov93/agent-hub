import { Users } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { EmptyState } from "@/components/EmptyState"

export function SubagentsView() {
  return (
    <>
      <PageHeader title="Claude subagents" description="subagent.start / subagent.stop events from the Claude hook." />
      <EmptyState icon={Users} title="Coming soon" description="The Claude subagents view is not built yet." />
    </>
  )
}
