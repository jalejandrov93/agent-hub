import { Activity } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { EmptyState } from "@/components/EmptyState"

export function TimelineView() {
  return (
    <>
      <PageHeader title="Timeline" description="Every hub and claude-hook event, newest first." />
      <EmptyState icon={Activity} title="Coming soon" description="The timeline view is not built yet." />
    </>
  )
}
