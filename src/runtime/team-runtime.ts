import type {
  CocoExecutionRequest,
  CocoAdapter
} from './coco-adapter.js'
import type {
  DispatchAssignment,
  ExecutionBatch,
  MailboxMessage,
  RuntimeEvent,
  RuntimeSnapshot,
  RuntimeTaskState,
  TaskExecutionResult,
  WorkerSnapshot
} from '../domain/types.js'

function createInitialTaskStates(assignments: DispatchAssignment[]): RuntimeTaskState[] {
  return assignments.map((assignment) => ({
    taskId: assignment.task.id,
    status: assignment.task.status,
    claimedBy: null,
    attempts: 0,
    maxAttempts: assignment.task.maxAttempts,
    lastError: null
  }))
}

function createInitialWorkers(assignments: DispatchAssignment[]): WorkerSnapshot[] {
  return assignments.map((assignment, index) => ({
    workerId: `W${index + 1}`,
    role: assignment.roleDefinition.name,
    taskId: assignment.task.id,
    model: assignment.modelResolution.model,
    status: 'idle',
    lastHeartbeatAt: null
  }))
}

function createRuntimeSnapshot(
  assignments: DispatchAssignment[],
  batches: ExecutionBatch[],
  initialCompletedTaskIds: string[] = []
): RuntimeSnapshot {
  return {
    workers: createInitialWorkers(assignments),
    batches,
    completedTaskIds: [...initialCompletedTaskIds],
    pendingTaskIds: assignments
      .map((assignment) => assignment.task.id)
      .filter((taskId) => !initialCompletedTaskIds.includes(taskId)),
    events: [],
    mailbox: [],
    taskStates: createInitialTaskStates(assignments)
  }
}

function pushEvent(events: RuntimeEvent[], event: RuntimeEvent): void {
  events.push(event)
}

function heartbeat(worker: WorkerSnapshot): void {
  worker.lastHeartbeatAt = new Date().toISOString()
}

function pushMailbox(mailbox: MailboxMessage[], params: Omit<MailboxMessage, 'messageId' | 'createdAt'>): void {
  mailbox.push({
    messageId: `M${mailbox.length + 1}`,
    createdAt: new Date().toISOString(),
    ...params
  })
}

function getTaskState(runtime: RuntimeSnapshot, taskId: string): RuntimeTaskState {
  const taskState = runtime.taskStates.find((item) => item.taskId === taskId)
  if (!taskState) {
    throw new Error(`未找到 taskState: ${taskId}`)
  }
  return taskState
}

async function executeTaskWithRetry(params: {
  runtime: RuntimeSnapshot
  batch: ExecutionBatch
  assignment: DispatchAssignment
  worker: WorkerSnapshot
  adapter: CocoAdapter
}): Promise<TaskExecutionResult> {
  const { runtime, batch, assignment, worker, adapter } = params
  const taskId = assignment.task.id
  const taskState = getTaskState(runtime, taskId)

  while (taskState.attempts < taskState.maxAttempts) {
    taskState.attempts += 1
    taskState.claimedBy = worker.workerId
    taskState.status = 'in_progress'
    taskState.lastError = null
    worker.status = 'running'
    heartbeat(worker)
    pushEvent(runtime.events, {
      type: 'task-claimed',
      batchId: batch.batchId,
      taskId,
      detail: `${worker.workerId} claim ${taskId} (attempt ${taskState.attempts}/${taskState.maxAttempts})`
    })
    pushMailbox(runtime.mailbox, {
      workerId: worker.workerId,
      taskId,
      direction: 'inbound',
      content: `claim task ${taskId} (attempt ${taskState.attempts}/${taskState.maxAttempts})`
    })
    pushEvent(runtime.events, {
      type: 'task-start',
      batchId: batch.batchId,
      taskId,
      detail: `${worker.workerId} 开始执行 ${taskId}`
    })

    try {
      const result = await adapter.execute({ assignment } satisfies CocoExecutionRequest)
      const finalResult: TaskExecutionResult = { ...result, attempt: taskState.attempts }

      if (finalResult.status === 'completed') {
        worker.status = 'completed'
        heartbeat(worker)
        taskState.status = 'completed'
        taskState.claimedBy = null
        runtime.completedTaskIds.push(taskId)
        runtime.pendingTaskIds = runtime.pendingTaskIds.filter((pendingTaskId) => pendingTaskId !== taskId)
        pushMailbox(runtime.mailbox, {
          workerId: worker.workerId,
          taskId,
          direction: 'outbound',
          content: finalResult.summary
        })
        pushEvent(runtime.events, {
          type: 'task-complete',
          batchId: batch.batchId,
          taskId,
          detail: `${worker.workerId} 完成 ${taskId}`
        })
        pushEvent(runtime.events, {
          type: 'task-released',
          batchId: batch.batchId,
          taskId,
          detail: `${worker.workerId} release ${taskId}`
        })
        return finalResult
      }

      throw new Error(finalResult.summary)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      worker.status = 'failed'
      heartbeat(worker)
      taskState.lastError = message
      taskState.claimedBy = null
      pushEvent(runtime.events, {
        type: 'task-failed',
        batchId: batch.batchId,
        taskId,
        detail: `${worker.workerId} 执行 ${taskId} 失败: ${message}`
      })
      pushMailbox(runtime.mailbox, {
        workerId: worker.workerId,
        taskId,
        direction: 'outbound',
        content: `执行失败: ${message}`
      })

      if (taskState.attempts < taskState.maxAttempts) {
        worker.status = 'idle'
        taskState.status = 'ready'
        pushEvent(runtime.events, {
          type: 'task-retry',
          batchId: batch.batchId,
          taskId,
          detail: `${taskId} 将进行重试 (${taskState.attempts + 1}/${taskState.maxAttempts})`
        })
        continue
      }

      taskState.status = 'failed'
      pushEvent(runtime.events, {
        type: 'task-released',
        batchId: batch.batchId,
        taskId,
        detail: `${worker.workerId} release ${taskId} (failed)`
      })
      return {
        taskId,
        role: assignment.roleDefinition.name,
        model: assignment.modelResolution.model,
        status: 'failed',
        summary: message,
        attempt: taskState.attempts
      }
    }
  }

  return {
    taskId,
    role: assignment.roleDefinition.name,
    model: assignment.modelResolution.model,
    status: 'failed',
    summary: '未知重试终止',
    attempt: taskState.attempts
  }
}

export async function runAssignmentsWithRuntime(params: {
  assignments: DispatchAssignment[]
  batches: ExecutionBatch[]
  adapter: CocoAdapter
  initialCompletedTaskIds?: string[]
}): Promise<{ runtime: RuntimeSnapshot; results: TaskExecutionResult[] }> {
  const { assignments, batches, adapter, initialCompletedTaskIds = [] } = params
  const runtime = createRuntimeSnapshot(assignments, batches, initialCompletedTaskIds)
  const assignmentMap = new Map(assignments.map((assignment) => [assignment.task.id, assignment]))
  const workerMap = new Map(runtime.workers.map((worker) => [worker.taskId, worker]))
  const results: TaskExecutionResult[] = []

  for (const batch of batches) {
    const runnableTaskIds = batch.taskIds.filter((taskId) => {
      const assignment = assignmentMap.get(taskId)
      if (!assignment) {
        return false
      }

      return assignment.task.dependsOn.every((dependencyId) => runtime.completedTaskIds.includes(dependencyId))
    })

    if (runnableTaskIds.length === 0) {
      break
    }

    pushEvent(runtime.events, {
      type: 'batch-start',
      batchId: batch.batchId,
      detail: `开始执行批次 ${batch.batchId}`
    })

    const executions = runnableTaskIds.map(async (taskId) => {
      const assignment = assignmentMap.get(taskId)
      const worker = workerMap.get(taskId)

      if (!assignment || !worker) {
        throw new Error(`执行批次时缺少任务或 worker: ${taskId}`)
      }
      return executeTaskWithRetry({ runtime, batch, assignment, worker, adapter })
    })

    const batchResults = await Promise.all(executions)
    results.push(...batchResults)
    pushEvent(runtime.events, {
      type: 'batch-complete',
      batchId: batch.batchId,
      detail: `批次 ${batch.batchId} 执行完成`
    })
  }

  return { runtime, results }
}
