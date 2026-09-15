import { Settings } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { EmptyState } from "@/components/EmptyState"

export function ConfigView() {
  return (
    <div id="config-panel" className="flex flex-1 flex-col">
      <PageHeader title="Config" description="Delegation map, timeouts, breaker, overrides, and process paths." />
      <EmptyState icon={Settings} title="Coming soon" description="The config view is not built yet." />
    </div>
  )
}
