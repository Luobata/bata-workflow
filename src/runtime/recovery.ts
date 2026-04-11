import type { DispatchAssignment, RunReport } from '../domain/types.js'
import type { CocoAdapter } from './coco-adapter.js'
import { buildExecutionBatches } from './scheduler.js'
import { runAssignmentsWithRuntime } from './team-runtime.js'

function getCompletedTaskIds(report: RunReport): string[] {
  return report.runtime.taskStates.filter((taskState) => taskState.status === 'completed').map((taskState) => taskState.taskId)
}

function getIncompleteAssignments(report: RunReport): DispatchAssignment[] {
  const completed = new Set(getCompletedTaskIds(report))
  return report.assignments.filter((assignment) => !completed.has(assignment.task.id))
}

function prefixBatches(batches: RunReport['batches'], prefix: string) {
  return batches.map((batch, index) => ({
    batchId: `${prefix}${index + 1}`,
    taskIds: batch.taskIds
  }))
}

export async function resumeRun(params: {
  previousReport: RunReport
  adapter: CocoAdapter
}): Promise<RunReport> {
  const { previousReport, adapter } = params
  const incompleteAssignments = getIncompleteAssignments(previousReport)

  if (incompleteAssignments.length === 0) {
    return previousReport
  }

  const completedTaskIds = getCompletedTaskIds(previousReport)
  const resumedBatches = prefixBatches(buildExecutionBatches(incompleteAssignments, completedTaskIds), 'R')
  const resumed = await runAssignmentsWithRuntime({
    assignments: incompleteAssignments,
    batches: resumedBatches,
    adapter,
    initialCompletedTaskIds: completedTaskIds
  })

  const mergedResultsMap = new Map(previousReport.results.map((result) => [result.taskId, result]))
  for (const result of resumed.results) {
    mergedResultsMap.set(result.taskId, result)
  }

  const mergedTaskStateMap = new Map(previousReport.runtime.taskStates.map((taskState) => [taskState.taskId, taskState]))
  for (const taskState of resumed.runtime.taskStates) {
    mergedTaskStateMap.set(taskState.taskId, taskState)
  }

  const mergedWorkers = [
    ...previousReport.runtime.workers.filter(
      (worker) => !resumed.runtime.workers.some((resumedWorker) => resumedWorker.taskId === worker.taskId)
    ),
    ...resumed.runtime.workers
  ]

  const mergedRuntime = {
    workers: mergedWorkers,
    batches: [...previousReport.runtime.batches, ...resumed.runtime.batches],
    completedTaskIds: Array.from(
      new Set([...previousReport.runtime.completedTaskIds, ...resumed.runtime.completedTaskIds])
    ),
    pendingTaskIds: Array.from(new Set([...previousReport.runtime.pendingTaskIds, ...resumed.runtime.pendingTaskIds])).filter(
      (taskId) => !resumed.runtime.completedTaskIds.includes(taskId)
    ),
    events: [...previousReport.runtime.events, ...resumed.runtime.events],
    mailbox: [...previousReport.runtime.mailbox, ...resumed.runtime.mailbox],
    taskStates: previousReport.assignments.map((assignment) => mergedTaskStateMap.get(assignment.task.id)!).filter(Boolean)
  }

  return {
    ...previousReport,
    batches: [...previousReport.batches, ...resumedBatches],
    runtime: mergedRuntime,
    results: previousReport.assignments
      .map((assignment) => mergedResultsMap.get(assignment.task.id))
      .filter(Boolean) as RunReport['results']
  }
}
