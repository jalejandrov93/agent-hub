import { History } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { EmptyState } from "@/components/EmptyState"

export function HistoryView() {
  return (
    <>
      <PageHeader title="Job history" description="Completed, failed, and canceled jobs." />
      <EmptyState icon={History} title="Coming soon" description="The job history view is not built yet." />
    </>
  )
}
