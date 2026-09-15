import { BarChart3 } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { EmptyState } from "@/components/EmptyState"

export function MetricsView() {
  return (
    <>
      <PageHeader title="Metrics" description="Success rate, latency, and token usage by task type." />
      <EmptyState icon={BarChart3} title="Coming soon" description="The metrics view is not built yet." />
    </>
  )
}
