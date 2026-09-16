import { useNavigate, useSearch } from "@tanstack/react-router"
import { PageHeader } from "@/components/PageHeader"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { CloudSearch, type CloudSearchT } from "@/routes/search"
import { AccountsTab } from "./accounts-tab"
import { SourcesTab } from "./sources-tab"
import { SchedulesTab } from "./schedules-tab"
import { SessionsTab } from "./sessions-tab"
import { Toaster } from "@/components/ui/toast"

export function CloudView() {
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const { tab } = CloudSearch.parse(search)
  const navigate = useNavigate()

  const handleTabChange = (val: string | number) => {
    navigate({
      to: "/cloud",
      search: { tab: String(val) as CloudSearchT["tab"] },
    })
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="Cloud"
        description="Manage connected GitHub repos, agent sessions, and automated schedules."
      />
      <Toaster />

      <Tabs value={tab} onValueChange={handleTabChange} className="flex-1">
        <TabsList className="mb-2">
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
          <TabsTrigger value="sources">Sources</TabsTrigger>
          <TabsTrigger value="schedules">Schedules</TabsTrigger>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
        </TabsList>

        <TabsContent value="accounts">
          <AccountsTab />
        </TabsContent>
        <TabsContent value="sources">
          <SourcesTab />
        </TabsContent>
        <TabsContent value="schedules">
          <SchedulesTab />
        </TabsContent>
        <TabsContent value="sessions">
          <SessionsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
