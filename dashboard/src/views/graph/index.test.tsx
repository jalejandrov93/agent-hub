import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionGraphResponseT } from '@/lib/types'
import { GraphView } from './index'

const mockUseExecutionGraphQuery = vi.fn()

vi.mock('@/lib/queries', () => ({
  useExecutionGraphQuery: () => mockUseExecutionGraphQuery(),
}))

const smallGraph: ExecutionGraphResponseT = {
  roots: ['root-1'],
  nodes: {
    'root-1': {
      id: 'root-1',
      jobId: 'job-root',
      agent: 'agy',
      model: 'gemini-3.8-flash-high',
      status: 'succeeded',
      workflow_id: 'wf-1',
      step_id: 'step-root',
      attempt: 1,
      parent: null,
      root: 'root-1',
      relation: 'delegate',
    },
    'child-1': {
      id: 'child-1',
      jobId: 'job-child-1',
      agent: 'opencode',
      model: 'muse-spark',
      status: 'succeeded',
      workflow_id: 'wf-1',
      step_id: 'step-child-1',
      attempt: 1,
      parent: 'root-1',
      root: 'root-1',
      relation: 'delegate',
    },
    'child-2': {
      id: 'child-2',
      jobId: 'job-child-2',
      agent: 'copilot',
      model: 'claude-3.5-sonnet',
      status: 'failed',
      workflow_id: 'wf-1',
      step_id: 'step-child-2',
      attempt: 1,
      parent: 'root-1',
      root: 'root-1',
      relation: 'delegate',
    },
    'grandchild-1': {
      id: 'grandchild-1',
      jobId: 'job-grandchild-1',
      agent: 'copilot',
      model: 'claude-3.5-sonnet',
      status: 'succeeded',
      workflow_id: 'wf-1',
      step_id: 'step-child-2',
      attempt: 2,
      parent: 'child-2',
      root: 'root-1',
      relation: 'retry',
    },
  },
  edges: [
    { from: 'root-1', to: 'child-1', relation: 'delegate' },
    { from: 'root-1', to: 'child-2', relation: 'delegate' },
    { from: 'child-2', to: 'grandchild-1', relation: 'retry' },
  ],
}

describe('GraphView', () => {
  beforeEach(() => {
    mockUseExecutionGraphQuery.mockReset()
  })

  it('renders the execution graph with root, children, agent:model and relation', () => {
    mockUseExecutionGraphQuery.mockReturnValue({
      data: smallGraph,
      isPending: false,
      isError: false,
    })

    render(<GraphView />)

    expect(screen.getByText('agy:gemini-3.8-flash-high')).toBeTruthy()
    expect(screen.getByText('opencode:muse-spark')).toBeTruthy()
    expect(screen.getAllByText('copilot:claude-3.5-sonnet').length).toBe(2)

    expect(screen.getAllByText('delegate').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('retry')).toBeTruthy()
  })

  it('renders empty state when there are no jobs in graph', () => {
    mockUseExecutionGraphQuery.mockReturnValue({
      data: { roots: [], nodes: {}, edges: [] },
      isPending: false,
      isError: false,
    })

    render(<GraphView />)

    expect(screen.getByText('No execution graph')).toBeTruthy()
  })

  it('renders loading state when query is pending', () => {
    mockUseExecutionGraphQuery.mockReturnValue({
      data: null,
      isPending: true,
      isError: false,
    })

    const { container } = render(<GraphView />)
    expect(container.querySelector('.animate-pulse')).toBeTruthy()
  })

  it('renders error state when query fails', () => {
    mockUseExecutionGraphQuery.mockReturnValue({
      data: null,
      isPending: false,
      isError: true,
      error: new Error('Failed to fetch execution graph'),
    })

    render(<GraphView />)
    expect(screen.getByText('Could not load execution graph')).toBeTruthy()
    expect(screen.getByText('Failed to fetch execution graph')).toBeTruthy()
  })
})
