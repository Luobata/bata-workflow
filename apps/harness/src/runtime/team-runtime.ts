import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

import type { CocoExecutionRequest, CocoAdapter } from './coco-adapter.js'
import { createTaskQueue, loadTaskQueue, PersistentTaskQueue, rerouteFailedTask, retryFailedTask } from './task-queue.js'
import { shouldRetryTask } from './failure-policy.js'
import { readPendingControlCommands, type RuntimeControlCommand } from './control-channel.js'
import { buildTaskArtifacts, captureTaskArtifactSnapshot } from './task-artifacts.js'
import type { TaskQueueSnapshot } from './task-store.js'
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

function deriveMonitorRunMetadata(workspaceRoot: string): NonNullable<TaskQueueSnapshot['monitor']> {
  const normalizedWorkspaceRoot = resolve(workspaceRoot)
  const liveCocoSessionId = process.env.COCO_SESSION_ID?.trim()
  const rootSessionId = liveCocoSessionId || `workspace-${createHash('sha1').update(normalizedWorkspaceRoot).digest('hex').slice(0, 12)}`

  return {
    rootSessionId,
    monitorSessionId: `monitor:${rootSessionId}`,
    workspaceRoot: normalizedWorkspaceRoot
  }
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
    executionTarget: remediation.executionTarget,
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

function formatWorkerScope(queue: PersistentTaskQueue, workerId: string): string {
  const worker = queue.getWorker(workerId)
  const scopeParts = [workerId, worker.slotId ? `S${worker.slotId}` : null, worker.tmux?.paneId ?? null]
  return scopeParts.filter((part): part is string => Boolean(part)).join('/')
}

async function executeClaim(params: {
  queue: PersistentTaskQueue
  claim: QueueClaimResult
  adapter: CocoAdapter
  workspaceRoot: string
}): Promise<void> {
  const { queue, claim, adapter, workspaceRoot } = params
  const { assignment, batchId, maxAttempts, taskId, workerId } = claim
  const artifactSnapshotBefore = captureTaskArtifactSnapshot(workspaceRoot)
  const workerScope = formatWorkerScope(queue, workerId)

  queue.appendTaskEvent(taskId, {
    type: 'task-claimed',
    batchId,
    taskId,
    detail: `${workerScope} claim ${taskId} (attempt ${claim.attempt}/${maxAttempts})`
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
    detail: `${workerScope} 开始执行 ${taskId}`
  })

  try {
    const dependencyResults = queue.getDependencyTaskContexts(taskId)
    const result = await adapter.execute({ assignment, dependencyResults } satisfies CocoExecutionRequest)
    const finishedAt = now()
    const slotId = queue.getWorker(workerId).slotId
    const finalResult: TaskExecutionResult = {
      ...result,
      model: assignment.executionTarget.model,
      backend: assignment.executionTarget.backend,
      command: assignment.executionTarget.command ?? null,
      transport: assignment.executionTarget.transport,
      profile: assignment.executionTarget.profile ?? null,
      slotId,
      attempt: claim.attempt
    }

    if (finalResult.status !== 'completed') {
      throw new Error(finalResult.summary)
    }

    queue.transitionTask(taskId, 'in_progress', {
      phase: 'finalizing',
      phaseDetail: 'writing result summary and artifacts'
    })
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
      detail: `${workerScope} 完成 ${taskId}`
    })
    queue.releaseTask(taskId)
    queue.appendTaskEvent(taskId, {
      type: 'task-released',
      batchId,
      taskId,
      detail: `${workerScope} release ${taskId}`
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
      phase: retryable ? 'retrying' : 'failed',
      phaseDetail: retryable ? `waiting to retry: ${retryDecision.reason}` : null,
      result: retryable
        ? null
        : {
            taskId,
            role: assignment.roleDefinition.name,
            model: assignment.executionTarget.model,
            backend: assignment.executionTarget.backend,
            command: assignment.executionTarget.command ?? null,
            transport: assignment.executionTarget.transport,
            profile: assignment.executionTarget.profile ?? null,
            slotId: queue.getWorker(workerId).slotId,
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
      detail: `${workerScope} 执行 ${taskId} 失败: ${message}`
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
      detail: `${workerScope} release ${taskId} (failed)`
    })
  } finally {
    queue.updateTaskArtifacts(taskId, buildTaskArtifacts(taskId, artifactSnapshotBefore, captureTaskArtifactSnapshot(workspaceRoot)))
  }
}

function claimBatchTasks(queue: PersistentTaskQueue, batch: ExecutionBatch): QueueClaimResult[] {
  const runtime = queue.getRuntimeSnapshot()
  const claims: QueueClaimResult[] = []

  const idleWorkers = [...runtime.workers]
    .filter((candidate) => candidate.status === 'idle')
    .sort((left, right) => {
      const leftTimestamp = left.lastHeartbeatAt ? Date.parse(left.lastHeartbeatAt) || 0 : Number.NEGATIVE_INFINITY
      const rightTimestamp = right.lastHeartbeatAt ? Date.parse(right.lastHeartbeatAt) || 0 : Number.NEGATIVE_INFINITY
      if (leftTimestamp !== rightTimestamp) {
        return leftTimestamp - rightTimestamp
      }

      return (left.slotId ?? Number.MAX_SAFE_INTEGER) - (right.slotId ?? Number.MAX_SAFE_INTEGER)
    })

  for (const worker of idleWorkers.slice(0, runtime.maxConcurrency)) {
    const claim = queue.claimNextTask(worker.workerId, { allowedTaskIds: batch.taskIds })
    if (!claim) {
      continue
    }
    claims.push(claim)
  }

  return claims
}

async function applyControlCommand(queue: PersistentTaskQueue, command: RuntimeControlCommand): Promise<void> {
  if (command.type === 'abort-run') {
    return
  }

  if (command.type === 'retry-task') {
    const batchId = queue.getBatchId(command.taskId)

    try {
      retryFailedTask(queue, command.taskId)
      queue.appendTaskEvent(command.taskId, {
        type: 'task-retry',
        batchId,
        taskId: command.taskId,
        detail: `收到控制命令 ${command.id}，将任务 ${command.taskId} 标记为可重试`
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      queue.appendTaskEvent(command.taskId, {
        type: 'task-retry',
        batchId,
        taskId: command.taskId,
        detail: `处理控制命令 ${command.id} 失败: ${message}`
      })
    }
  }

  if (command.type === 'reroute-task') {
    const batchId = queue.getBatchId(command.taskId)

    try {
      const reroute = rerouteFailedTask(queue, command.taskId, command.targetRole)
      queue.appendTaskEvent(command.taskId, {
        type: 'task-rerouted',
        batchId,
        taskId: command.taskId,
        detail: `收到控制命令 ${command.id}，将任务 ${command.taskId} 从 ${reroute.fromRole} reroute 到 ${reroute.toRole}`
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      queue.appendTaskEvent(command.taskId, {
        type: 'task-rerouted',
        batchId,
        taskId: command.taskId,
        detail: `处理 reroute 控制命令 ${command.id} 失败: ${message}`
      })
    }
  }
}

type RuntimeControlState = {
  cursor: number
  abortRequested: boolean
  abortEventLogged: boolean
  processedCommandIds: Set<string>
}

async function executeBatch(
  queue: PersistentTaskQueue,
  batch: ExecutionBatch,
  adapter: CocoAdapter,
  controlState: RuntimeControlState,
  workspaceRoot: string
): Promise<void> {
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

  const handleControlCommands = async (): Promise<void> => {
    const { commands, nextCursor } = await readPendingControlCommands(queue.runDirectory, controlState.cursor)
    controlState.cursor = nextCursor

    for (const command of commands) {
      if (controlState.processedCommandIds.has(command.id)) {
        continue
      }
      controlState.processedCommandIds.add(command.id)

      await applyControlCommand(queue, command)

      if (command.type === 'abort-run') {
        controlState.abortRequested = true
        if (!controlState.abortEventLogged) {
          queue.appendEvent({
            type: 'run-abort-requested',
            batchId: batch.batchId,
            detail: `收到 abort 请求 ${command.id}`
          })
          controlState.abortEventLogged = true
        }
      }
    }
  }

  while (true) {
    await handleControlCommands()

    if (controlState.abortRequested && !queue.hasInProgressTasks()) {
      break
    }
    if (queue.isBatchSettled(batch.batchId)) {
      break
    }
    const claims = controlState.abortRequested ? [] : claimBatchTasks(queue, batch)
    if (claims.length === 0) {
      const nextEligibleAt = queue.getNextEligibleAt(batch.taskIds)
      if (nextEligibleAt) {
        await sleep(Math.max(1, new Date(nextEligibleAt).getTime() - Date.now()))
        continue
      }
      throw new Error(`批次 ${batch.batchId} 无可执行任务，但仍未完成`)
    }
    await Promise.all(claims.map((claim) => executeClaim({ queue, claim, adapter, workspaceRoot })))
    await handleControlCommands()
  }

  queue.appendEvent({
    type: 'batch-complete',
    batchId: batch.batchId,
    detail: `批次 ${batch.batchId} 执行完成`
  })
}

export async function runAssignmentsWithRuntime(params: {
  workspaceRoot?: string
  runDirectory: string
  adapter: CocoAdapter
  goal?: string
  plan?: Plan
  assignments?: DispatchAssignment[]
  batches?: ExecutionBatch[]
  workerPool?: WorkerPoolConfig
  resume?: boolean
}): Promise<{ runtime: RuntimeSnapshot; results: TaskExecutionResult[]; artifactsByTaskId: Record<string, import('../domain/types.js').TaskArtifacts> }> {
  const { workspaceRoot = process.cwd(), runDirectory, adapter, goal, plan, assignments, batches, workerPool, resume = false } = params

  const queue = resume
    ? loadTaskQueue(runDirectory, { recover: true, workerPool })
    : createTaskQueue({
        runDirectory,
        goal: goal ?? plan?.goal ?? 'unknown goal',
        plan: plan ?? { goal: goal ?? 'unknown goal', summary: '', tasks: [] },
        assignments: assignments ?? [],
        batches: batches ?? [],
        workerPool: workerPool ?? { maxConcurrency: 2 },
        monitor: deriveMonitorRunMetadata(workspaceRoot)
      })

  if (!queue.hasEvent('run-started')) {
    queue.appendEvent({
      type: 'run-started',
      batchId: 'RUN',
      detail: `开始运行 ${queue.goal}`
    })
  }

  const controlState: RuntimeControlState = {
    cursor: 0,
    abortRequested: false,
    abortEventLogged: false,
    processedCommandIds: new Set<string>()
  }

  try {
    for (const batch of queue.getRuntimeSnapshot().batches) {
      await executeBatch(queue, batch, adapter, controlState, workspaceRoot)
      if (controlState.abortRequested) {
        break
      }
    }
  } catch (error) {
    queue.appendEvent({
      type: 'run-failed',
      batchId: 'RUN',
      detail: error instanceof Error ? error.message : String(error)
    })
    throw error
  }

  if (controlState.abortRequested) {
    queue.appendEvent({
      type: 'run-aborted',
      batchId: 'RUN',
      detail: '运行已按 abort 请求收口'
    })
  } else {
    queue.appendEvent({
      type: 'run-completed',
      batchId: 'RUN',
      detail: '运行完成'
    })
  }

  return {
    runtime: queue.getRuntimeSnapshot(),
    results: queue.listResults(),
    artifactsByTaskId: queue.listArtifactsByTaskId()
  }
}
