/**
 * C1.1 execution helpers — re-exported here so workflow code does not need
 * to import the whole dispatch module graph.
 */
export {
  createExecutionHandle,
  isExecutionHandle,
  isWaitingJobState,
  waitingReasonForState,
  waitExecution,
  TERMINAL_JOB_STATUSES,
} from '../dispatch.mjs'
