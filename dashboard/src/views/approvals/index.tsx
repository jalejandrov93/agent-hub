import { CheckSquare } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { EmptyState } from "@/components/EmptyState"

export function ApprovalsView() {
  return (
    <>
      <PageHeader title="Approvals" description="Routing proposals and learnings awaiting a decision." />
      <EmptyState icon={CheckSquare} title="Coming soon" description="The approvals view is not built yet." />
    </>
  )
}
