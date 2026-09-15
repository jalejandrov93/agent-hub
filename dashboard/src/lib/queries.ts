import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import * as api from "./api"
import { qk } from "./query-keys"
import type { LearningInputT } from "./types"

const STATE_REFETCH_INTERVAL_MS = 15000

export function useStateQuery() {
  return useQuery({
    queryKey: qk.state,
    queryFn: api.getState,
    refetchInterval: STATE_REFETCH_INTERVAL_MS,
  })
}

export function useConfigQuery() {
  return useQuery({ queryKey: qk.config, queryFn: api.getConfig })
}

export function useMetricsQuery() {
  return useQuery({ queryKey: qk.metrics, queryFn: api.getMetrics })
}

export function useProposalsQuery() {
  return useQuery({ queryKey: qk.proposals, queryFn: api.getProposals })
}

export function useLearningsQuery() {
  return useQuery({ queryKey: qk.learnings, queryFn: api.getLearnings })
}

export function useRefreshAgentsMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.refreshAgents,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.state }),
  })
}

export function useRefreshDiscoveryMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.refreshDiscovery,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.config }),
  })
}

export function useSetOverrideMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.setOverride,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.config }),
  })
}

export function useClearOverrideMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ agent, model }: { agent: string; model: string }) => api.clearOverride(agent, model),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.config }),
  })
}

export function useCancelJobMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.cancelJob,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.state }),
  })
}

export function useRefreshProposalsMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.refreshProposals,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.proposals }),
  })
}

export function useDecideProposalMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "accept" | "reject" }) =>
      api.decideProposal(id, decision),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.proposals }),
  })
}

export function useDecideLearningMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: "approve" | "reject" }) =>
      api.decideLearning(id, decision),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.learnings }),
  })
}

export function useDeleteLearningMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.deleteLearning,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.learnings }),
  })
}

export function useCreateLearningMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: LearningInputT) => api.createLearning(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.learnings }),
  })
}
