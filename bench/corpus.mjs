export const CORPUS = [
  {
    id: 'happy-path',
    description: 'Happy path sequential workflow where all steps complete and pass verification',
    workflow: {
      id: 'wf-happy-path',
      name: 'Happy Path',
      nodes: [
        {
          id: 'plan',
          type: 'delegate',
          task: 'Create implementation plan',
          mode: 'read'
        },
        {
          id: 'execute',
          type: 'delegate',
          task: 'Execute plan and generate artifact',
          mode: 'write',
          dependsOn: ['plan'],
          verify: [
            { name: 'verify-task', argv: ['echo', 'ok'] }
          ]
        }
      ]
    },
    dispatch: {
      plan: {
        results: ['succeed']
      },
      execute: {
        results: ['succeed'],
        verification: 'pass'
      }
    }
  },
  {
    id: 'retry-transient',
    description: 'Transient dispatch failure retried successfully within maxAttempts',
    workflow: {
      id: 'wf-retry-transient',
      name: 'Retry Transient Failure',
      nodes: [
        {
          id: 'flaky_step',
          type: 'delegate',
          task: 'Perform operation with transient failure',
          maxAttempts: 2,
          mode: 'read'
        }
      ]
    },
    dispatch: {
      flaky_step: {
        results: ['fail', 'succeed']
      }
    }
  },
  {
    id: 'revision-verification',
    description: 'Verification failure triggers revision loop before passing',
    workflow: {
      id: 'wf-revision-verification',
      name: 'Revision on Verification Failure',
      nodes: [
        {
          id: 'review_step',
          type: 'delegate',
          task: 'Implement code needing review revision',
          maxRevisionAttempts: 2,
          mode: 'write',
          verify: {
            checks: [
              { name: 'quality-gate', argv: ['npm', 'test'] }
            ],
            required: true
          }
        }
      ]
    },
    dispatch: {
      review_step: {
        results: ['succeed', 'succeed'],
        verification: ['fail', 'pass']
      }
    }
  },
  {
    id: 'fanout-child-failure',
    description: 'Fanout workflow where one child fails, causing parent and workflow to fail',
    workflow: {
      id: 'wf-fanout-failure',
      name: 'Fanout Child Failure',
      nodes: [
        {
          id: 'fanout_step',
          type: 'fanout',
          items: ['task_alpha', 'task_beta']
        }
      ]
    },
    dispatch: {
      fanout_step_0: {
        results: ['succeed']
      },
      fanout_step_1: {
        results: ['fail']
      }
    }
  }
]
