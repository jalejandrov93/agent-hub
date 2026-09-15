import { useNavigate, useSearch } from "@tanstack/react-router"
import { Toaster } from "@/components/ui/toast"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageHeader } from "@/components/PageHeader"
import { useLearningsQuery, useProposalsQuery } from "@/lib/queries"
import { ProposalsPanel } from "./proposals-panel"
import { LearningsPanel } from "./learnings-panel"

function PendingCount({ count }: { count: number }) {
  return <Badge variant={count > 0 ? "default" : "secondary"}>{count}</Badge>
}

export function ApprovalsView() {
  const { tab } = useSearch({ from: "/approvals" })
  const navigate = useNavigate({ from: "/approvals" })

  const proposals = useProposalsQuery().data?.proposals ?? []
  const learnings = useLearningsQuery().data?.learnings ?? []
  const pendingProposals = proposals.filter((proposal) => proposal.status === "pending").length
  const pendingLearnings = learnings.filter((learning) => learning.status === "pending").length

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Routing proposals and learnings awaiting a decision."
      />
      <Toaster />
      <Tabs
        value={tab}
        onValueChange={(value) => {
          const next = value === "learnings" ? "learnings" : "proposals"
          if (next === tab) return
          navigate({ to: "/approvals", search: (prev) => ({ ...prev, tab: next }) })
        }}
      >
        <TabsList>
          <TabsTrigger value="proposals">
            Proposals
            <PendingCount count={pendingProposals} />
          </TabsTrigger>
          <TabsTrigger value="learnings">
            Learnings
            <PendingCount count={pendingLearnings} />
          </TabsTrigger>
        </TabsList>
        <TabsContent value="proposals">
          <ProposalsPanel />
        </TabsContent>
        <TabsContent value="learnings">
          <LearningsPanel />
        </TabsContent>
      </Tabs>
    </>
  )
}
