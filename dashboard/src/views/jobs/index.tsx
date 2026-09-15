import { PlayCircle } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { EmptyState } from "@/components/EmptyState"

export function JobsView() {
  return (
    <>
      <PageHeader title="Running jobs" description="Queued and in-progress jobs." />
      <EmptyState icon={PlayCircle} title="Coming soon" description="The running jobs view is not built yet." />
    </>
  )
}
