import type { DispatchAssignment, ExecutionBatch } from '../domain/types.js'

export function buildExecutionBatches(assignments: DispatchAssignment[], initiallyCompletedTaskIds: string[] = []): ExecutionBatch[] {
  const remainingDependencies = new Map(
    assignments.map((assignment) => [assignment.task.id, new Set(assignment.task.dependsOn)])
  )
  const activeTaskIds = new Set(assignments.map((assignment) => assignment.task.id))
  const completed = new Set<string>(initiallyCompletedTaskIds)
  const completedActive = new Set<string>()
  const batches: ExecutionBatch[] = []

  while (completedActive.size < assignments.length) {
    const ready = assignments
      .filter((assignment) => !completedActive.has(assignment.task.id))
      .filter((assignment) => {
        const deps = remainingDependencies.get(assignment.task.id)
        return deps
          ? [...deps].every((dependencyId) => !activeTaskIds.has(dependencyId) || completed.has(dependencyId))
          : true
      })
      .map((assignment) => assignment.task.id)

    if (ready.length === 0) {
      const unresolved = assignments
        .filter((assignment) => !completed.has(assignment.task.id))
        .map((assignment) => assignment.task.id)
      throw new Error(`无法生成执行批次，存在循环依赖或未满足依赖: ${unresolved.join(', ')}`)
    }

    const batchId = `B${batches.length + 1}`
    batches.push({ batchId, taskIds: ready })

    for (const taskId of ready) {
      completed.add(taskId)
      completedActive.add(taskId)
    }
  }

  return batches
}
