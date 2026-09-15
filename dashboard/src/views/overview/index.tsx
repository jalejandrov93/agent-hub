import { LayoutDashboard } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { EmptyState } from "@/components/EmptyState"

export function OverviewView() {
  return (
    <>
      <PageHeader title="Overview" description="Fleet health at a glance." />
      <EmptyState icon={LayoutDashboard} title="Coming soon" description="The overview dashboard is not built yet." />
    </>
  )
}
