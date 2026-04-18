import type {
  DispatchFallbackTarget,
  DispatchAssignment,
  RuntimeDynamicTaskStats,
  MailboxMessage,
  Plan,
  QueueClaimResult,
  RunSummary,
  RuntimeEvent,
  RuntimeLoopSummary,
  RuntimeSnapshot,
  TaskPhase,
  TaskArtifacts,
  RuntimeTaskState,
  TaskExecutionResult,
  UpstreamTaskContext,
  WorkerPoolConfig,
  WorkerSnapshot
} from '../domain/types.js'
import { appendRuntimeEvent } from './event-stream.js'
import {
  type PersistedTaskRecord,
  type PersistentRunState,
  type TaskQueueSnapshot,
  loadPersistentRunState,
  loadTaskStoreSnapshot,
  queueExists,
  savePersistentRunState
} from './task-store.js'

function createWorkerPool(taskCount: number, config: WorkerPoolConfig): WorkerSnapshot[] {
  const poolSize = Math.max(1, Math.min(config.maxConcurrency, Math.max(taskCount, 1)))
  return Array.from({ length: poolSize }, (_, index) => ({
    workerId: `W${index + 1}`,
    role: null,
    taskId: null,
    model: null,
    status: 'idle',
    lastHeartbeatAt: null
  }))
}

function createInitialTaskState(assignment: DispatchAssignment): RuntimeTaskState {
  const status = assignment.task.dependsOn.length === 0 ? 'ready' : assignment.task.status
  return {
    taskId: assignment.task.id,
    status,
    phase: deriveTaskPhase({ status, nextAttemptAt: null }),
    phaseDetail: status === 'pending' ? 'waiting for dependencies' : null,
    claimedBy: null,
    attempts: 0,
    maxAttempts: assignment.task.maxAttempts,
    lastError: null,
    attemptHistory: [],
    workerHistory: [],
    failureTimestamps: [],
    lastClaimedAt: null,
    releasedAt: null,
    nextAttemptAt: null,
    lastUpdatedAt: null
  }
}

function now(): string {
  return new Date().toISOString()
}

function deriveTaskPhase(state: Pick<RuntimeTaskState, 'status' | 'nextAttemptAt'>): TaskPhase {
  switch (state.status) {
    case 'pending':
      return 'queued'
    case 'ready':
      return state.nextAttemptAt ? 'retrying' : 'ready'
    case 'in_progress':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'blocked':
      return 'blocked'
  }
}

export interface CreateTaskQueueParams {
  runDirectory: string
  goal: string
  plan: Plan
  assignments: DispatchAssignment[]
  batches: RuntimeSnapshot['batches']
  workerPool: WorkerPoolConfig
}

export interface AppendGeneratedTaskParams {
  assignment: DispatchAssignment
  batchId: string
}

export interface TransitionTaskPatch extends Partial<RuntimeTaskState> {
  result?: TaskExecutionResult | null
  finalizeAttempt?: Extract<RuntimeTaskState['status'], 'completed'> | 'failed'
}

export interface ClaimNextTaskOptions {
  allowedTaskIds?: string[]
}

export function buildRunSummary(params: { runtime: RuntimeSnapshot; results: TaskExecutionResult[] }): RunSummary {
  const { runtime } = params
  const loopedSourceTaskIds = runtime.loopSummaries
    .filter((summary) => summary.generatedTaskIds.length > 0)
    .map((summary) => summary.sourceTaskId)

  return {
    generatedTaskCount: runtime.dynamicTaskStats.generatedTaskCount,
    loopCount: loopedSourceTaskIds.length,
    loopedSourceTaskIds,
    failedTaskCount: runtime.taskStates.filter((taskState) => taskState.status === 'failed').length,
    blockedTaskCount: runtime.taskStates.filter((taskState) => taskState.status === 'blocked').length,
    completedTaskCount: runtime.taskStates.filter((taskState) => taskState.status === 'completed').length,
    retryTaskCount: runtime.taskStates.filter((taskState) => taskState.attempts > 1).length
  }
}

export class PersistentTaskQueue {
  private readonly assignmentMap: Map<string, DispatchAssignment>
  private readonly batchMap: Map<string, string>
  private readonly taskMap: Map<string, PersistedTaskRecord>

  private constructor(
    readonly runDirectory: string,
    readonly goal: string,
    readonly plan: Plan,
    private queue: TaskQueueSnapshot,
    tasks: PersistedTaskRecord[]
  ) {
    this.taskMap = new Map(tasks.map((task) => [task.taskId, task]))
    this.assignmentMap = new Map(tasks.map((task) => [task.taskId, task.assignment]))
    this.batchMap = new Map(queue.batches.flatMap((batch) => batch.taskIds.map((taskId) => [taskId, batch.batchId] as const)))
  }

  static create(params: CreateTaskQueueParams): PersistentTaskQueue {
    const { runDirectory, goal, plan, assignments, batches, workerPool } = params
    const createdAt = now()
    const tasks = assignments.map((assignment) => ({
      taskId: assignment.task.id,
      assignment,
      state: createInitialTaskState(assignment),
      result: null,
      events: [],
      artifacts: null
    }))

    const queue: TaskQueueSnapshot = {
      goal,
      createdAt,
      updatedAt: createdAt,
      maxConcurrency: workerPool.maxConcurrency,
      batches,
      taskOrder: assignments.map((assignment) => assignment.task.id),
      workers: createWorkerPool(assignments.length, workerPool),
      readyTaskIds: [],
      inProgressTaskIds: [],
      pendingTaskIds: [],
      blockedTaskIds: [],
      completedTaskIds: [],
      failedTaskIds: [],
      events: [],
      mailbox: []
    }

    const taskQueue = new PersistentTaskQueue(runDirectory, goal, plan, queue, tasks)
    taskQueue.rebuildDerivedState()
    taskQueue.persist()
    return taskQueue
  }

  static load(
    runDirectory: string,
    options: { recover: boolean; workerPool?: WorkerPoolConfig } = { recover: false }
  ): PersistentTaskQueue {
    const taskStore = loadTaskStoreSnapshot(runDirectory)
    const state = loadPersistentRunState(runDirectory)
    const taskQueue = new PersistentTaskQueue(runDirectory, state.queue.goal, taskStore.plan, state.queue, state.tasks)

    if (options.recover) {
      taskQueue.prepareForResume(options.workerPool)
      taskQueue.persist()
    } else {
      taskQueue.rebuildDerivedState()
    }

    return taskQueue
  }

  static exists(runDirectory: string): boolean {
    return queueExists(runDirectory)
  }

  listTasks(): PersistedTaskRecord[] {
    return this.queue.taskOrder.map((taskId) => this.taskMap.get(taskId)!).filter(Boolean)
  }

  listAssignments(): DispatchAssignment[] {
    return this.listTasks().map((task) => task.assignment)
  }

  listGeneratedTaskIds(sourceTaskId: string): string[] {
    return this.listTasks()
      .filter((task) => task.assignment.task.generatedFromTaskId === sourceTaskId)
      .map((task) => task.taskId)
  }

  listResults(): TaskExecutionResult[] {
    return this.listTasks().map((task) => task.result).filter(Boolean) as TaskExecutionResult[]
  }

  listArtifactsByTaskId(): Record<string, TaskArtifacts> {
    return Object.fromEntries(
      this.listTasks()
        .filter((task) => task.artifacts !== null)
        .map((task) => [task.taskId, task.artifacts!])
    )
  }

  hasEvent(type: RuntimeEvent['type']): boolean {
    return this.queue.events.some((event) => event.type === type)
  }

  getBatchId(taskId: string): string {
    return this.batchMap.get(taskId) ?? 'B0'
  }

  getTaskState(taskId: string): RuntimeTaskState {
    return this.requireTask(taskId).state
  }

  getDependencyTaskContexts(taskId: string): UpstreamTaskContext[] {
    const assignment = this.assignmentMap.get(taskId)
    if (!assignment) {
      return []
    }

    return assignment.task.dependsOn.map((dependencyId) => {
      const dependencyRecord = this.requireTask(dependencyId)
      return {
        taskId: dependencyId,
        role: dependencyRecord.assignment.roleDefinition.name,
        taskType: dependencyRecord.assignment.task.taskType,
        status: dependencyRecord.state.status,
        summary: dependencyRecord.result?.summary ?? null,
        attempt: dependencyRecord.result?.attempt ?? null
      }
    })
  }

  getWorker(workerId: string): WorkerSnapshot {
    const worker = this.queue.workers.find((item) => item.workerId === workerId)
    if (!worker) {
      throw new Error(`未找到 worker: ${workerId}`)
    }
    return worker
  }

  getRuntimeSnapshot(): RuntimeSnapshot {
    const dynamicTaskStats = this.buildDynamicTaskStats()
    const loopSummaries = this.buildLoopSummaries()

    return {
      maxConcurrency: this.queue.maxConcurrency,
      workers: this.queue.workers.map((worker) => ({ ...worker })),
      batches: [...this.queue.batches],
      completedTaskIds: [...this.queue.completedTaskIds],
      pendingTaskIds: [...this.queue.pendingTaskIds],
      blockedTaskIds: [...this.queue.blockedTaskIds],
      readyTaskIds: [...this.queue.readyTaskIds],
      inProgressTaskIds: [...this.queue.inProgressTaskIds],
      failedTaskIds: [...this.queue.failedTaskIds],
      dynamicTaskStats,
      loopSummaries,
      events: [...this.queue.events],
      mailbox: [...this.queue.mailbox],
      taskStates: this.listTasks().map((task) => ({
        ...task.state,
        attemptHistory: task.state.attemptHistory.map((attempt) => ({ ...attempt })),
        workerHistory: [...task.state.workerHistory],
        failureTimestamps: [...task.state.failureTimestamps]
      }))
    }
  }

  isSettled(): boolean {
    return this.queue.readyTaskIds.length === 0 && this.queue.inProgressTaskIds.length === 0
  }

  hasInProgressTasks(): boolean {
    return this.queue.inProgressTaskIds.length > 0
  }

  claimNextTask(workerId: string, options: ClaimNextTaskOptions = {}): QueueClaimResult | null {
    this.rebuildDerivedState()
    const allowedTaskIds = options.allowedTaskIds ? new Set(options.allowedTaskIds) : null
    const taskId = this.queue.readyTaskIds.find((candidateTaskId) =>
      (allowedTaskIds ? allowedTaskIds.has(candidateTaskId) : true) && this.isClaimEligible(candidateTaskId)
    )

    if (!taskId) {
      return null
    }

    const record = this.requireTask(taskId)
    const worker = this.getWorker(workerId)
    const claimedAt = now()
    record.state.attempts += 1
    record.state.claimedBy = workerId
    record.state.status = 'in_progress'
    record.state.phase = 'running'
    record.state.phaseDetail = null
    record.state.lastError = null
    record.state.lastClaimedAt = claimedAt
    record.state.releasedAt = null
    record.state.nextAttemptAt = null
    record.state.lastUpdatedAt = claimedAt
    record.state.workerHistory.push(workerId)
    record.state.attemptHistory.push({
      attempt: record.state.attempts,
      workerId,
      startedAt: claimedAt,
      finishedAt: null,
      status: 'in_progress'
    })

    worker.taskId = taskId
    worker.role = record.assignment.roleDefinition.name
    worker.model = record.assignment.modelResolution.model
    worker.status = 'running'
    worker.lastHeartbeatAt = claimedAt

    this.rebuildDerivedState()
    this.persist()

    return {
      workerId,
      taskId,
      batchId: this.getBatchId(taskId),
      attempt: record.state.attempts,
      maxAttempts: record.state.maxAttempts,
      assignment: record.assignment
    }
  }

  transitionTask(taskId: string, status: RuntimeTaskState['status'], patch: TransitionTaskPatch = {}): void {
    const record = this.requireTask(taskId)
    const updatedAt = now()
    const { result, finalizeAttempt, phase, phaseDetail, ...statePatch } = patch
    const nextAttemptAt = statePatch.nextAttemptAt ?? record.state.nextAttemptAt

    record.state = {
      ...record.state,
      ...statePatch,
      status,
      phase: phase ?? deriveTaskPhase({ status, nextAttemptAt }),
      phaseDetail: phaseDetail ?? null,
      lastUpdatedAt: updatedAt
    }

    if (finalizeAttempt) {
      const latestAttempt = record.state.attemptHistory.at(-1)
      if (latestAttempt) {
        latestAttempt.finishedAt = updatedAt
        latestAttempt.status = finalizeAttempt
      }
    }

    if (finalizeAttempt === 'failed') {
      record.state.failureTimestamps.push(updatedAt)
    }

    if (result !== undefined) {
      record.result = result
    }

    this.rebuildDerivedState()
    this.persist()
  }

  releaseTask(taskId: string): void {
    const record = this.requireTask(taskId)
    const releasedAt = now()
    const workerId = record.state.claimedBy

    record.state.claimedBy = null
    record.state.releasedAt = releasedAt
    record.state.lastUpdatedAt = releasedAt

    if (workerId) {
      const worker = this.getWorker(workerId)
      worker.taskId = null
      worker.role = null
      worker.model = null
      worker.status = 'idle'
      worker.lastHeartbeatAt = releasedAt
    }

    this.rebuildDerivedState()
    this.persist()
  }

  updateWorker(workerId: string, patch: Partial<WorkerSnapshot>): void {
    Object.assign(this.getWorker(workerId), patch)
    this.queue.updatedAt = now()
    this.persist()
  }

  applyFallback(taskId: string, fallback: DispatchFallbackTarget): void {
    const record = this.requireTask(taskId)
    record.assignment.roleDefinition = fallback.roleDefinition
    record.assignment.task.role = fallback.roleDefinition.name
    record.assignment.modelResolution = fallback.modelResolution
    this.queue.updatedAt = now()
    this.persist()
  }

  rerouteTask(taskId: string, targetRole: 'reviewer' | 'planner' | 'coder'): { fromRole: string; toRole: string } {
    const record = this.requireTask(taskId)
    const fromRole = record.assignment.roleDefinition.name
    record.assignment.roleDefinition = {
      ...record.assignment.roleDefinition,
      name: targetRole,
      description: record.assignment.roleDefinition.description || targetRole
    }
    record.assignment.task.role = targetRole
    record.assignment.modelResolution = {
      ...record.assignment.modelResolution,
      source: 'fallback',
      reason: `rerouted from ${fromRole} to ${targetRole}`
    }
    this.queue.updatedAt = now()
    this.persist()
    return { fromRole, toRole: targetRole }
  }

  addDependency(taskId: string, dependencyId: string): void {
    const record = this.requireTask(taskId)
    if (!record.assignment.task.dependsOn.includes(dependencyId)) {
      record.assignment.task.dependsOn.push(dependencyId)
      const planTask = this.plan.tasks.find((task) => task.id === taskId)
      if (planTask && !planTask.dependsOn.includes(dependencyId)) {
        planTask.dependsOn.push(dependencyId)
      }
      this.queue.updatedAt = now()
      this.rebuildDerivedState()
      this.persist()
    }
  }

  appendGeneratedTask(params: AppendGeneratedTaskParams): void {
    const { assignment, batchId } = params
    if (this.taskMap.has(assignment.task.id)) {
      return
    }

    const record: PersistedTaskRecord = {
      taskId: assignment.task.id,
      assignment,
      state: createInitialTaskState(assignment),
      result: null,
      events: [],
      artifacts: null
    }

    this.taskMap.set(assignment.task.id, record)
    this.assignmentMap.set(assignment.task.id, assignment)
    this.queue.taskOrder.push(assignment.task.id)
    this.plan.tasks.push(assignment.task)

    const batch = this.queue.batches.find((item) => item.batchId === batchId)
    if (!batch) {
      throw new Error(`未找到可追加任务的批次: ${batchId}`)
    }
    if (!batch.taskIds.includes(assignment.task.id)) {
      batch.taskIds.push(assignment.task.id)
    }
    this.batchMap.set(assignment.task.id, batchId)

    this.rebuildDerivedState()
    this.persist()
  }

  getNextEligibleAt(taskIds?: string[]): string | null {
    const taskIdSet = taskIds ? new Set(taskIds) : null
    const candidates = this.listTasks()
      .filter((task) => task.state.status === 'ready')
      .filter((task) => (taskIdSet ? taskIdSet.has(task.taskId) : true))
      .map((task) => task.state.nextAttemptAt)
      .filter((value): value is string => Boolean(value))
      .sort()

    return candidates[0] ?? null
  }

  appendEvent(event: RuntimeEvent): void {
    this.queue.events.push(event)
    appendRuntimeEvent({
      runDirectory: this.runDirectory,
      seq: this.queue.events.length,
      type: toStructuredRuntimeEventType(event.type),
      payload: {
        batchId: event.batchId,
        taskId: event.taskId ?? null,
        detail: event.detail
      }
    })
    this.queue.updatedAt = now()
    this.persist()
  }

  appendTaskEvent(taskId: string, event: RuntimeEvent): void {
    const record = this.requireTask(taskId)
    record.events.push(event)
    this.appendEvent(event)
  }

  appendMailboxMessage(message: MailboxMessage): void {
    this.queue.mailbox.push(message)
    this.queue.updatedAt = now()
    this.persist()
  }

  updateTaskArtifacts(taskId: string, artifacts: TaskArtifacts): void {
    const record = this.requireTask(taskId)
    record.artifacts = artifacts
    this.queue.updatedAt = now()
    this.persist()
  }

  hasBatchStarted(batchId: string): boolean {
    return this.queue.events.some((event) => event.type === 'batch-start' && event.batchId === batchId)
  }

  hasBatchCompleted(batchId: string): boolean {
    return this.queue.events.some((event) => event.type === 'batch-complete' && event.batchId === batchId)
  }

  isBatchSettled(batchId: string): boolean {
    const taskIds = this.queue.batches.find((batch) => batch.batchId === batchId)?.taskIds ?? []
    return taskIds.every((taskId) => {
      const task = this.taskMap.get(taskId)
      return task ? ['completed', 'failed', 'blocked'].includes(task.state.status) : true
    })
  }

  private prepareForResume(workerPool?: WorkerPoolConfig): void {
    const recoveredAt = now()
    const hasRecoverableTasks = [...this.taskMap.values()].some((record) => {
      if (record.state.status === 'completed') {
        return false
      }

      if (record.state.status === 'failed') {
        return record.state.attempts < record.state.maxAttempts
      }

      return true
    })

    if (!hasRecoverableTasks) {
      this.rebuildDerivedState()
      return
    }

    for (const record of this.taskMap.values()) {
      if (record.state.status === 'completed') {
        continue
      }

      if (record.state.status === 'in_progress') {
        record.state.status = 'ready'
        record.state.phase = 'ready'
        record.state.phaseDetail = 'recovered from interrupted run'
        record.state.claimedBy = null
        record.state.releasedAt = recoveredAt
        record.state.nextAttemptAt = null
        record.state.lastUpdatedAt = recoveredAt
      }

      if (record.state.status === 'failed' && record.state.attempts < record.state.maxAttempts) {
        record.state.status = 'ready'
        record.state.phase = 'ready'
        record.state.phaseDetail = 'recovered from resumable failure'
        record.state.claimedBy = null
        record.state.releasedAt = recoveredAt
        record.state.nextAttemptAt = null
        record.state.lastUpdatedAt = recoveredAt
      }
    }

    this.resetWorkerPool(workerPool?.maxConcurrency)

    this.rebuildDerivedState()
  }

  private resetWorkerPool(maxConcurrency = this.queue.maxConcurrency): void {
    this.queue.maxConcurrency = maxConcurrency
    this.queue.workers = createWorkerPool(this.queue.taskOrder.length, { maxConcurrency })
  }

  private requireTask(taskId: string): PersistedTaskRecord {
    const task = this.taskMap.get(taskId)
    if (!task) {
      throw new Error(`未找到任务: ${taskId}`)
    }
    return task
  }

  private dependenciesSatisfied(taskId: string): boolean {
    const assignment = this.assignmentMap.get(taskId)
    if (!assignment) {
      return false
    }

    return assignment.task.dependsOn.every((dependencyId) => {
      const dependency = this.taskMap.get(dependencyId)
      return dependency ? dependency.state.status === 'completed' : true
    })
  }

  private hasTerminalDependencyFailure(taskId: string): boolean {
    const assignment = this.assignmentMap.get(taskId)
    if (!assignment) {
      return false
    }

    return assignment.task.dependsOn.some((dependencyId) => {
      const dependency = this.taskMap.get(dependencyId)
      if (!dependency) {
        return false
      }

      if (dependency.state.status === 'blocked') {
        return true
      }

      return dependency.state.status === 'failed' && dependency.state.attempts >= dependency.state.maxAttempts
    })
  }

  private isClaimEligible(taskId: string): boolean {
    const nextAttemptAt = this.requireTask(taskId).state.nextAttemptAt
    return !nextAttemptAt || new Date(nextAttemptAt).getTime() <= Date.now()
  }

  private buildDynamicTaskStats(): RuntimeDynamicTaskStats {
    const generatedTasks = this.listTasks().filter((task) => task.assignment.task.generatedFromTaskId)
    const generatedTaskCountBySourceTaskId = generatedTasks.reduce<Record<string, number>>((accumulator, task) => {
      const sourceTaskId = task.assignment.task.generatedFromTaskId!
      accumulator[sourceTaskId] = (accumulator[sourceTaskId] ?? 0) + 1
      return accumulator
    }, {})

    return {
      generatedTaskCount: generatedTasks.length,
      generatedTaskIds: generatedTasks.map((task) => task.taskId),
      generatedTaskCountBySourceTaskId
    }
  }

  private buildLoopSummaries(): RuntimeLoopSummary[] {
    const sourceTasks = this.listTasks().filter(
      (task) => task.assignment.task.failurePolicy?.fixVerifyLoop?.enabled || task.assignment.task.generatedFromTaskId == null
    )

    return sourceTasks
      .map((task) => {
        const generatedTasks = this.listTasks().filter((candidate) => candidate.assignment.task.generatedFromTaskId === task.taskId)
        if (!task.assignment.task.failurePolicy?.fixVerifyLoop?.enabled && generatedTasks.length === 0) {
          return null
        }

        return {
          sourceTaskId: task.taskId,
          loopEnabled: task.assignment.task.failurePolicy?.fixVerifyLoop?.enabled ?? false,
          maxRounds: task.assignment.task.failurePolicy?.fixVerifyLoop?.maxRounds ?? null,
          generatedTaskIds: generatedTasks.map((candidate) => candidate.taskId),
          completedGeneratedTaskIds: generatedTasks
            .filter((candidate) => candidate.state.status === 'completed')
            .map((candidate) => candidate.taskId),
          pendingGeneratedTaskIds: generatedTasks
            .filter((candidate) => candidate.state.status !== 'completed')
            .map((candidate) => candidate.taskId)
        } satisfies RuntimeLoopSummary
      })
      .filter((item): item is RuntimeLoopSummary => Boolean(item))
  }

  private rebuildDerivedState(): void {
    for (const taskId of this.queue.taskOrder) {
      const record = this.requireTask(taskId)

      if (record.state.status === 'completed') {
        continue
      }

      if (record.state.status === 'blocked') {
        continue
      }

      if (record.state.status === 'failed' && record.state.attempts >= record.state.maxAttempts) {
        continue
      }

      if (this.hasTerminalDependencyFailure(taskId)) {
        record.state.status = 'blocked'
        record.state.phase = 'blocked'
        record.state.phaseDetail = 'blocked by upstream failure'
        record.state.lastUpdatedAt = now()
        continue
      }

      const depsSatisfied = this.dependenciesSatisfied(taskId)
      if (record.state.status === 'pending' && depsSatisfied) {
        record.state.status = 'ready'
        record.state.phase = 'ready'
        record.state.phaseDetail = null
      }
      if (record.state.status === 'ready' && !depsSatisfied) {
        record.state.status = 'pending'
        record.state.phase = 'queued'
        record.state.phaseDetail = 'waiting for dependencies'
      }

      if (record.state.phase !== 'finalizing') {
        record.state.phase = deriveTaskPhase(record.state)
        if (record.state.phase === 'ready' || record.state.phase === 'running' || record.state.phase === 'completed' || record.state.phase === 'failed') {
          record.state.phaseDetail = null
        }
      }
    }

    this.queue.readyTaskIds = []
    this.queue.inProgressTaskIds = []
    this.queue.pendingTaskIds = []
    this.queue.blockedTaskIds = []
    this.queue.completedTaskIds = []
    this.queue.failedTaskIds = []

    for (const taskId of this.queue.taskOrder) {
      const state = this.requireTask(taskId).state
      if (state.status === 'completed') {
        this.queue.completedTaskIds.push(taskId)
        continue
      }

      if (state.status === 'failed') {
        this.queue.failedTaskIds.push(taskId)
        continue
      }

      if (state.status === 'blocked') {
        this.queue.blockedTaskIds.push(taskId)
        continue
      }

      this.queue.pendingTaskIds.push(taskId)

      if (state.status === 'ready') {
        this.queue.readyTaskIds.push(taskId)
      }

      if (state.status === 'in_progress') {
        this.queue.inProgressTaskIds.push(taskId)
      }
    }

    this.queue.updatedAt = now()
  }

  private persist(): void {
    savePersistentRunState(
      this.runDirectory,
      {
        queue: this.queue,
        tasks: this.listTasks()
      } satisfies PersistentRunState,
      this.plan
    )
  }
}

function toStructuredRuntimeEventType(type: RuntimeEvent['type']): string {
  switch (type) {
    case 'run-started':
      return 'run-started'
    case 'run-abort-requested':
      return 'run-abort-requested'
    case 'run-aborted':
      return 'run-aborted'
    case 'run-completed':
      return 'run-completed'
    case 'run-failed':
      return 'run-failed'
    case 'batch-start':
      return 'batch-started'
    case 'batch-complete':
      return 'batch-completed'
    case 'task-start':
      return 'task-started'
    case 'task-complete':
      return 'task-completed'
    case 'task-retry':
      return 'task-retried'
    default:
      return type
  }
}

export function createTaskQueue(params: CreateTaskQueueParams): PersistentTaskQueue {
  return PersistentTaskQueue.create(params)
}

export function loadTaskQueue(
  runDirectory: string,
  options: { recover: boolean; workerPool?: WorkerPoolConfig } = { recover: false }
): PersistentTaskQueue {
  return PersistentTaskQueue.load(runDirectory, options)
}

export function retryFailedTask(queue: PersistentTaskQueue, taskId: string): void {
  const state = queue.getTaskState(taskId)

  if (state.status === 'completed') {
    throw new Error(`任务 ${taskId} 已完成，不能重试`)
  }

  if (state.status === 'in_progress') {
    throw new Error(`任务 ${taskId} 正在执行中，不能重试`)
  }

  if (state.status === 'blocked') {
    throw new Error(`任务 ${taskId} 被依赖阻塞，不能直接重试`)
  }

  if (state.status !== 'failed') {
    throw new Error(`任务 ${taskId} 当前状态为 ${state.status}，仅支持对 failed 任务重试`)
  }

  const runtime = queue.getRuntimeSnapshot()
  if (!runtime.failedTaskIds.includes(taskId)) {
    throw new Error(`任务 ${taskId} 不在 failed 列表中，不能重试`)
  }

  const nowIso = new Date().toISOString()

  // 将 failed 任务重新标记为 ready，让调度循环按正常规则重新 claim
  queue.transitionTask(taskId, 'ready', {
    lastError: null,
    nextAttemptAt: null,
    releasedAt: nowIso,
    result: null
  })
}

export function rerouteFailedTask(
  queue: PersistentTaskQueue,
  taskId: string,
  targetRole: 'reviewer' | 'planner' | 'coder'
): { fromRole: string; toRole: string } {
  const state = queue.getTaskState(taskId)

  if (state.status !== 'failed') {
    throw new Error(`任务 ${taskId} 当前状态为 ${state.status}，仅支持对 failed 任务 reroute`)
  }

  const reroute = queue.rerouteTask(taskId, targetRole)
  const nowIso = new Date().toISOString()
  queue.transitionTask(taskId, 'ready', {
    lastError: null,
    nextAttemptAt: null,
    releasedAt: nowIso,
    result: null
  })
  return reroute
}
