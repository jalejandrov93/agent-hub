import * as React from 'react'
import { Network } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { EmptyState } from '@/components/EmptyState'
import { StatusBadge } from '@/components/StatusBadge'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Skeleton } from '@/components/ui/skeleton'
import { useExecutionGraphQuery } from '@/lib/queries'
import type { ExecutionGraphNodeT } from '@/lib/types'

function ExecutionNodeItem({
  node,
  childrenMap,
  depth = 0,
  visited,
}: {
  node: ExecutionGraphNodeT
  childrenMap: Map<string, ExecutionGraphNodeT[]>
  depth?: number
  visited: Set<string>
}) {
  if (visited.has(node.id)) return null
  visited.add(node.id)
  const children = childrenMap.get(node.id) ?? []

  return (
    <div className={depth > 0 ? 'ml-6 mt-3 border-l-2 border-border pl-4' : 'mt-3'}>
      <div className='flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3 text-card-foreground shadow-xs'>
        {depth > 0 ? (
          <Badge variant='outline' className='font-mono text-xs'>
            {node.relation || 'delegate'}
          </Badge>
        ) : (
          <Badge variant='secondary' className='font-mono text-xs'>
            root
          </Badge>
        )}

        <span className='font-medium'>
          {node.agent}:{node.model}
        </span>

        <StatusBadge kind='status' value={node.status} />

        <span className='font-mono text-xs text-muted-foreground'>
          {node.workflow_id || node.step_id ? (
            `${node.workflow_id ?? '—'} / ${node.step_id ?? '—'}`
          ) : (
            '—'
          )}
        </span>

        {node.attempt && node.attempt > 1 ? (
          <Badge variant='outline' className='text-xs'>
            attempt {node.attempt}
          </Badge>
        ) : null}

        <span className='ml-auto font-mono text-xs text-muted-foreground' title={node.id}>
          {node.id}
        </span>
      </div>

      {children.length > 0 ? (
        <div className='flex flex-col gap-1'>
          {children.map((child) => (
            <ExecutionNodeItem
              key={child.id}
              node={child}
              childrenMap={childrenMap}
              depth={depth + 1}
              visited={visited}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function GraphView() {
  const graphQuery = useExecutionGraphQuery()
  const data = graphQuery.data
  const nodes = data?.nodes ?? {}
  const roots = data?.roots ?? []

  const childrenMap = React.useMemo(() => {
    const map = new Map<string, ExecutionGraphNodeT[]>()
    for (const node of Object.values(nodes)) {
      if (node.parent) {
        if (!map.has(node.parent)) {
          map.set(node.parent, [])
        }
        map.get(node.parent)!.push(node)
      }
    }
    return map
  }, [nodes])

  const rootIds = React.useMemo(() => {
    if (roots.length > 0) return roots
    return Object.values(nodes)
      .filter((n) => !n.parent)
      .map((n) => n.id)
  }, [roots, nodes])

  const visited = new Set<string>()

  return (
    <div className='flex flex-col gap-6'>
      <PageHeader
        title='Execution graph'
        description='Tree view of multi-agent and workflow executions.'
      />

      {graphQuery.isPending ? (
        <Skeleton className='h-48 w-full' />
      ) : graphQuery.isError ? (
        <Alert variant='destructive'>
          <AlertTitle>Could not load execution graph</AlertTitle>
          <AlertDescription>{graphQuery.error.message}</AlertDescription>
        </Alert>
      ) : Object.keys(nodes).length === 0 ? (
        <EmptyState
          icon={Network}
          title='No execution graph'
          description='There are no execution records to display.'
        />
      ) : (
        <div className='flex flex-col gap-4'>
          {rootIds.map((rootId) => {
            const rootNode = nodes[rootId]
            if (!rootNode) return null
            return (
              <Card key={rootId} className='p-4'>
                <CardHeader className='p-0 pb-2'>
                  <CardTitle className='text-sm font-semibold text-muted-foreground'>
                    Root: {rootId}
                  </CardTitle>
                </CardHeader>
                <CardContent className='p-0'>
                  <ExecutionNodeItem
                    node={rootNode}
                    childrenMap={childrenMap}
                    depth={0}
                    visited={visited}
                  />
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
