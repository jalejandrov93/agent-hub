import { useNavigate, useSearch } from "@tanstack/react-router"
import { useConfigQuery } from "@/lib/queries"
import { ConfigSearch, type ConfigSearchT } from "@/routes/search"
import { PageHeader } from "@/components/PageHeader"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import { DelegationTab } from "./delegation-tab"
import { ProcessTab } from "./process-tab"
import { BreakerTab } from "./breaker-tab"
import { OverridesTab } from "./overrides-tab"
import { PathsTab } from "./paths-tab"

export function ConfigView() {
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const { section } = ConfigSearch.parse(search)
  const navigate = useNavigate()

  const { data: config, isLoading } = useConfigQuery()

  const handleTabChange = (val: string | number) => {
    navigate({
      to: "/config",
      search: { section: String(val) as ConfigSearchT["section"] },
    })
  }

  return (
    <div id="config-panel" className="flex flex-1 flex-col gap-4">
      <PageHeader
        title="Config"
        description="Delegation map, timeouts, breaker, overrides, and process paths."
      />

      <Tabs value={section} onValueChange={handleTabChange} className="flex-1">
        <TabsList className="mb-2">
          <TabsTrigger value="delegation">Delegation</TabsTrigger>
          <TabsTrigger value="process">Process & CLIs</TabsTrigger>
          <TabsTrigger value="breaker">Breaker & TTL</TabsTrigger>
          <TabsTrigger value="overrides">Overrides</TabsTrigger>
          <TabsTrigger value="paths">Paths</TabsTrigger>
        </TabsList>

        {isLoading || !config ? (
          <div className="flex flex-col gap-4 py-4">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : (
          <>
            <TabsContent value="delegation">
              <DelegationTab config={config} />
            </TabsContent>
            <TabsContent value="process">
              <ProcessTab config={config} />
            </TabsContent>
            <TabsContent value="breaker">
              <BreakerTab config={config} />
            </TabsContent>
            <TabsContent value="overrides">
              <OverridesTab config={config} />
            </TabsContent>
            <TabsContent value="paths">
              <PathsTab config={config} />
            </TabsContent>
          </>
        )}
      </Tabs>
    </div>
  )
}
