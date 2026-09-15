import { Bot } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { EmptyState } from "@/components/EmptyState"

export function AgentsView() {
  return (
    <>
      <PageHeader title="Agents" description="CLI agents this dashboard can delegate to." />
      <EmptyState icon={Bot} title="Coming soon" description="The agents view is not built yet." />
    </>
  )
}
