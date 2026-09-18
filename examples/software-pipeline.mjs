/**
 * Example real workflow: Research -> Implementation -> Review
 *
 * Demonstrates a 3-step software development pipeline:
 * 1. research (delegate): Architectural analysis and exploration.
 * 2. implementation (delegate): Coding task dependent on research.
 * 3. review (delegate): Automated diff review dependent on implementation success.
 */
export const softwarePipelineWorkflow = {
  id: 'wf-software-pipeline',
  name: 'Research -> Implementation -> Review Pipeline',
  nodes: [
    {
      id: 'research',
      type: 'delegate',
      agent: 'agy',
      model: 'gemini-3.8-flash-high',
      taskType: 'architecture',
      task: 'Research architectural requirements and codebase conventions',
      maxAttempts: 2,
    },
    {
      id: 'implementation',
      type: 'delegate',
      agent: 'copilot',
      model: 'gpt-5-mini',
      taskType: 'implementation',
      task: 'Implement the feature following the research recommendations',
      dependsOn: ['research'],
      maxAttempts: 2,
    },
    {
      id: 'review',
      type: 'delegate',
      agent: 'opencode',
      model: 'default',
      taskType: 'review',
      task: 'Review implementation diff for correctness and style',
      dependsOn: ['implementation'],
      condition: "steps.implementation.status == 'succeeded'",
      maxAttempts: 1,
    },
  ],
}
