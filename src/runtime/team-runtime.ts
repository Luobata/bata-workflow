import type { CocoExecutionRequest, CocoAdapter } from './coco-adapter.js'
import { createTaskQueue, loadTaskQueue, PersistentTaskQueue } from './task-queue.js'
import { shouldRetryTask } from './failure-policy.js'
import type {
  DispatchAssignment,
  ExecutionBatch,
  MailboxMessage,
  Plan,
  QueueClaimResult,
  RuntimeSnapshot,
  TaskExecutionResult,
  WorkerPoolConfig
} from '../domain/types.js'

function now(): string {
  return new Date().toISOString()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildNextAttemptAt(retryDelayMs: number): string | null {
  return retryDelayMs > 0 ? new Date(Date.now() + retryDelayMs).toISOString() : null
}

function renderTemplate(template: string, params: Record<string, string | number>): string {
  return Object.entries(params).reduce(
    (content, [key, value]) => content.replaceAll(`{{${key}}}`, String(value)),
    template
  )
}

function buildRemediationAssignment(baseAssignment: DispatchAssignment, attempt: number): DispatchAssignment {
  const loopPolicy = baseAssignment.task.failurePolicy?.fixVerifyLoop
  const remediation = baseAssignment.remediation
  if (!loopPolicy?.enabled || !remediation) {
    throw new Error(`任务 ${baseAssignment.task.id} 缺少 remediation 配置`)
  }

  const templateParams = {
    sourceTaskId: baseAssignment.task.id,
    sourceTitle: baseAssignment.task.title,
    sourceDescription: baseAssignment.task.description,
    attempt
  }

  return {
    task: {
      id: `${baseAssignment.task.id}_FIX_${attempt}`,
      title: renderTemplate(loopPolicy.remediationTitleTemplate, templateParams),
      description: renderTemplate(loopPolicy.remediationDescriptionTemplate, templateParams),
      role: remediation.roleDefinition.name,
      taskType: remediation.taskType,
      dependsOn: [...baseAssignment.task.dependsOn],
      acceptanceCriteria: [
        `修复 ${baseAssignment.task.id} 暴露的问题`,
        `输出修复说明，支持 ${baseAssignment.task.id} 重新验证`
      ],
      skills: [...remediation.skills],
      status: 'ready',
      maxAttempts: 1,
      generatedFromTaskId: baseAssignment.task.id,
      failurePolicy: {
        maxAttempts: 1,
        retryDelayMs: 0,
        fallbackRole: null,
        fallbackModel: null,
        fixVerifyLoop: null,
        retryOn: [],
        terminalOn: []
      }
    },
    roleDefinition: remediation.roleDefinition,
    modelResolution: remediation.modelResolution,
    fallback: null,
    remediation: null
  }
}

function maybeScheduleFixVerifyLoop(params: {
  queue: PersistentTaskQueue
  assignment: DispatchAssignment
  batchId: string
  attempt: number
}): boolean {
  const { queue, assignment, batchId, attempt } = params
  const loopPolicy = assignment.task.failurePolicy?.fixVerifyLoop
  if (assignment.task.taskType !== 'testing' || !loopPolicy?.enabled || !assignment.remediation) {
    return false
  }

  if (queue.listGeneratedTaskIds(assignment.task.id).length >= loopPolicy.maxRounds) {
    return false
  }

  const remediation = buildRemediationAssignment(assignment, attempt)
  queue.appendGeneratedTask({ assignment: remediation, batchId })
  queue.addDependency(assignment.task.id, remediation.task.id)
  queue.appendEvent({
    type: 'task-generated',
    batchId,
    taskId: remediation.task.id,
    detail: `${assignment.task.id} 失败后生成修复任务 ${remediation.task.id}`
  })
  return true
}

function createMailboxMessage(
  queue: PersistentTaskQueue,
  params: Omit<MailboxMessage, 'messageId' | 'createdAt'>
): MailboxMessage {
  const messageCount = queue.getRuntimeSnapshot().mailbox.length
  return {
    messageId: `M${messageCount + 1}`,
    createdAt: now(),
    ...params
  }
}

async function executeClaim(params: {
  queue: PersistentTaskQueue
  claim: QueueClaimResult
  adapter: CocoAdapter
}): Promise<void> {
  const { queue, claim, adapter } = params
  const { assignment, batchId, maxAttempts, taskId, workerId } = claim

  queue.appendTaskEvent(taskId, {
    type: 'task-claimed',
    batchId,
    taskId,
    detail: `${workerId} claim ${taskId} (attempt ${claim.attempt}/${maxAttempts})`
  })
  queue.appendMailboxMessage(
    createMailboxMessage(queue, {
      workerId,
      taskId,
      direction: 'inbound',
      content: `claim task ${taskId} (attempt ${claim.attempt}/${maxAttempts})`
    })
  )
  queue.appendTaskEvent(taskId, {
    type: 'task-start',
    batchId,
    taskId,
    detail: `${workerId} 开始执行 ${taskId}`
  })

  try {
    const dependencyResults = queue.getDependencyTaskContexts(taskId)
    const result = await adapter.execute({ assignment, dependencyResults } satisfies CocoExecutionRequest)
    const finishedAt = now()
    const finalResult: TaskExecutionResult = { ...result, attempt: claim.attempt }

    if (finalResult.status !== 'completed') {
      throw new Error(finalResult.summary)
    }

    queue.updateWorker(workerId, { status: 'completed', lastHeartbeatAt: finishedAt })
    queue.transitionTask(taskId, 'completed', {
      lastError: null,
      result: finalResult,
      finalizeAttempt: 'completed'
    })
    queue.appendMailboxMessage(
      createMailboxMessage(queue, {
        workerId,
        taskId,
        direction: 'outbound',
        content: finalResult.summary
      })
    )
    queue.appendTaskEvent(taskId, {
      type: 'task-complete',
      batchId,
      taskId,
      detail: `${workerId} 完成 ${taskId}`
    })
    queue.releaseTask(taskId)
    queue.appendTaskEvent(taskId, {
      type: 'task-released',
      batchId,
      taskId,
      detail: `${workerId} release ${taskId}`
    })
  } catch (error) {
    const failedAt = now()
    const message = error instanceof Error ? error.message : String(error)
    const retryDecision = shouldRetryTask(assignment.task, message, claim.attempt)
    const retryable = retryDecision.retryable
    const retryDelayMs = assignment.task.failurePolicy?.retryDelayMs ?? 0
    const nextAttemptAt = retryable ? buildNextAttemptAt(retryDelayMs) : null

    queue.updateWorker(workerId, { status: 'failed', lastHeartbeatAt: failedAt })
    queue.transitionTask(taskId, retryable ? 'ready' : 'failed', {
      lastError: message,
      nextAttemptAt,
      result: retryable
        ? null
        : {
            taskId,
            role: assignment.roleDefinition.name,
            model: assignment.modelResolution.model,
            status: 'failed',
            summary: message,
            attempt: claim.attempt
          },
      finalizeAttempt: 'failed'
    })
    queue.appendTaskEvent(taskId, {
      type: 'task-failed',
      batchId,
      taskId,
      detail: `${workerId} 执行 ${taskId} 失败: ${message}`
    })
    queue.appendMailboxMessage(
      createMailboxMessage(queue, {
        workerId,
        taskId,
        direction: 'outbound',
        content: `执行失败: ${message}`
      })
    )
    queue.releaseTask(taskId)

    if (retryable) {
      const scheduledFixLoop = maybeScheduleFixVerifyLoop({
        queue,
        assignment,
        batchId,
        attempt: claim.attempt
      })

      if (!scheduledFixLoop && assignment.fallback) {
        queue.applyFallback(taskId, assignment.fallback)
        queue.appendTaskEvent(taskId, {
          type: 'task-rerouted',
          batchId,
          taskId,
          detail: `${taskId} 失败后切换为 role=${assignment.fallback.roleDefinition.name}, model=${assignment.fallback.modelResolution.model}`
        })
      }

      queue.appendTaskEvent(taskId, {
        type: 'task-retry',
        batchId,
        taskId,
        detail: scheduledFixLoop
          ? `${taskId} 将在修复任务完成后重新验证 (${claim.attempt + 1}/${maxAttempts})，原因：${retryDecision.reason}`
          : `${taskId} 将进行重试 (${claim.attempt + 1}/${maxAttempts})，原因：${retryDecision.reason}`
      })
      return
    }

    queue.appendTaskEvent(taskId, {
      type: 'task-released',
      batchId,
      taskId,
      detail: `${workerId} release ${taskId} (failed)`
    })
  }
}

function claimBatchTasks(queue: PersistentTaskQueue, batch: ExecutionBatch): QueueClaimResult[] {
  const runtime = queue.getRuntimeSnapshot()
  const claims: QueueClaimResult[] = []

  for (const worker of runtime.workers.filter((candidate) => candidate.status === 'idle')) {
    const claim = queue.claimNextTask(worker.workerId, { allowedTaskIds: batch.taskIds })
    if (!claim) {
      continue
    }
    claims.push(claim)
  }

  return claims
}

async function executeBatch(queue: PersistentTaskQueue, batch: ExecutionBatch, adapter: CocoAdapter): Promise<void> {
  if (queue.hasBatchCompleted(batch.batchId)) {
    return
  }

  if (!queue.hasBatchStarted(batch.batchId)) {
    queue.appendEvent({
      type: 'batch-start',
      batchId: batch.batchId,
      detail: `开始执行批次 ${batch.batchId}`
    })
  }

  while (!queue.isBatchSettled(batch.batchId)) {
    const claims = claimBatchTasks(queue, batch)
    if (claims.length === 0) {
      const nextEligibleAt = queue.getNextEligibleAt(batch.taskIds)
      if (nextEligibleAt) {
        await sleep(Math.max(1, new Date(nextEligibleAt).getTime() - Date.now()))
        continue
      }
      throw new Error(`批次 ${batch.batchId} 无可执行任务，但仍未完成`)
    }
    await Promise.all(claims.map((claim) => executeClaim({ queue, claim, adapter })))
  }

  queue.appendEvent({
    type: 'batch-complete',
    batchId: batch.batchId,
    detail: `批次 ${batch.batchId} 执行完成`
  })
}

export async function runAssignmentsWithRuntime(params: {
  runDirectory: string
  adapter: CocoAdapter
  goal?: string
  plan?: Plan
  assignments?: DispatchAssignment[]
  batches?: ExecutionBatch[]
  workerPool?: WorkerPoolConfig
  resume?: boolean
}): Promise<{ runtime: RuntimeSnapshot; results: TaskExecutionResult[] }> {
  const { runDirectory, adapter, goal, plan, assignments, batches, workerPool, resume = false } = params

  const queue = resume
    ? loadTaskQueue(runDirectory, { recover: true, workerPool })
    : createTaskQueue({
        runDirectory,
        goal: goal ?? plan?.goal ?? 'unknown goal',
        plan: plan ?? { goal: goal ?? 'unknown goal', summary: '', tasks: [] },
        assignments: assignments ?? [],
        batches: batches ?? [],
        workerPool: workerPool ?? { maxConcurrency: 2 }
      })

  for (const batch of queue.getRuntimeSnapshot().batches) {
    await executeBatch(queue, batch, adapter)
  }

  return {
    runtime: queue.getRuntimeSnapshot(),
    results: queue.listResults()
  }
}
