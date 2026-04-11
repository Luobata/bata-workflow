import type { DispatchAssignment, RunReport } from '../domain/types.js'

export interface VerificationSummary {
  ok: boolean
  checks: string[]
}

export function verifyAssignments(assignments: DispatchAssignment[]): VerificationSummary {
  const checks: string[] = []

  const hasCodingCodex = assignments.some(
    (assignment) => assignment.task.taskType === 'coding' && assignment.modelResolution.model === 'gpt5.3-codex'
  )
  checks.push(hasCodingCodex ? 'coding 任务命中 gpt5.3-codex' : 'coding 任务未命中 gpt5.3-codex')

  const nonCodingDefaults = assignments
    .filter((assignment) => !['coding', 'testing', 'code-review'].includes(assignment.task.taskType))
    .every((assignment) => assignment.modelResolution.model === 'gpt5.4')
  checks.push(nonCodingDefaults ? '非 coding 类任务命中 gpt5.4' : '存在非 coding 类任务未命中 gpt5.4')

  return {
    ok: hasCodingCodex && nonCodingDefaults,
    checks
  }
}

export function verifyRun(report: RunReport): VerificationSummary {
  const checks = [
    `执行任务数=${report.results.length}`,
    `计划任务数=${report.plan.tasks.length}`,
    `执行批次数=${report.batches.length}`
  ]
  const completedAll = report.results.length === report.plan.tasks.length && report.results.every((result) => result.status === 'completed')
  checks.push(completedAll ? '所有任务已完成' : '存在未完成任务')
  const runtimeSettled = report.runtime.pendingTaskIds.length === 0
  checks.push(runtimeSettled ? 'runtime 无待执行任务' : 'runtime 仍有待执行任务')
  const noDanglingClaims = report.runtime.taskStates.every((taskState) => taskState.claimedBy === null)
  checks.push(noDanglingClaims ? '无悬挂 claim' : '存在未释放 claim')

  return {
    ok: completedAll && runtimeSettled && noDanglingClaims,
    checks
  }
}
