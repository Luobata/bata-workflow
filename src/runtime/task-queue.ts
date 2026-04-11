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
  RuntimeTaskState,
  TaskExecutionResult,
  WorkerPoolConfig,
  WorkerSnapshot
} from '../domain/types.js'
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
  return {
    taskId: assignment.task.id,
    status: assignment.task.dependsOn.length === 0 ? 'ready' : assignment.task.status,
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
      events: []
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

  getBatchId(taskId: string): string {
    return this.batchMap.get(taskId) ?? 'B0'
  }

  getTaskState(taskId: string): RuntimeTaskState {
    return this.requireTask(taskId).state
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
    const { result, finalizeAttempt, ...statePatch } = patch

    record.state = {
      ...record.state,
      ...statePatch,
      status,
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
    record.assignment.modelResolution = fallback.modelResolution
    this.queue.updatedAt = now()
    this.persist()
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
      events: []
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
      return task ? ['completed', 'failed'].includes(task.state.status) : true
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
        record.state.claimedBy = null
        record.state.releasedAt = recoveredAt
        record.state.nextAttemptAt = null
        record.state.lastUpdatedAt = recoveredAt
      }

      if (record.state.status === 'failed' && record.state.attempts < record.state.maxAttempts) {
        record.state.status = 'ready'
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

      if (record.state.status === 'failed' && record.state.attempts >= record.state.maxAttempts) {
        continue
      }

      const depsSatisfied = this.dependenciesSatisfied(taskId)
      if (record.state.status === 'pending' && depsSatisfied) {
        record.state.status = 'ready'
      }
      if (record.state.status === 'ready' && !depsSatisfied) {
        record.state.status = 'pending'
      }
    }

    this.queue.readyTaskIds = []
    this.queue.inProgressTaskIds = []
    this.queue.pendingTaskIds = []
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

export function createTaskQueue(params: CreateTaskQueueParams): PersistentTaskQueue {
  return PersistentTaskQueue.create(params)
}

export function loadTaskQueue(
  runDirectory: string,
  options: { recover: boolean; workerPool?: WorkerPoolConfig } = { recover: false }
): PersistentTaskQueue {
  return PersistentTaskQueue.load(runDirectory, options)
}
