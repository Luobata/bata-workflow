import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type {
  DispatchAssignment,
  ExecutionBatch,
  MailboxMessage,
  Plan,
  RuntimeEvent,
  TaskArtifacts,
  RuntimeTaskState,
  TaskExecutionResult,
  WorkerSnapshot
} from '../domain/types.js'

export interface PersistedTaskRecord {
  taskId: string
  assignment: DispatchAssignment
  state: RuntimeTaskState
  result: TaskExecutionResult | null
  events: RuntimeEvent[]
  artifacts: TaskArtifacts | null
}

export interface TaskStoreSnapshot {
  goal: string
  plan: Plan
  assignments: DispatchAssignment[]
  taskStates: RuntimeTaskState[]
  pendingTaskIds: string[]
  blockedTaskIds: string[]
  completedTaskIds: string[]
  results: TaskExecutionResult[]
  artifactsByTaskId?: Record<string, TaskArtifacts>
}

export interface TaskQueueSnapshot {
  goal: string
  createdAt: string
  updatedAt: string
  maxConcurrency: number
  batches: ExecutionBatch[]
  taskOrder: string[]
  workers: WorkerSnapshot[]
  readyTaskIds: string[]
  inProgressTaskIds: string[]
  pendingTaskIds: string[]
  blockedTaskIds: string[]
  completedTaskIds: string[]
  failedTaskIds: string[]
  events: RuntimeEvent[]
  mailbox: MailboxMessage[]
}

export interface PersistentRunState {
  queue: TaskQueueSnapshot
  tasks: PersistedTaskRecord[]
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

function atomicWriteJson(path: string, data: unknown): void {
  ensureDir(resolve(path, '..'))
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tempPath, JSON.stringify(data, null, 2))
  renameSync(tempPath, path)
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export function getQueuePath(runDirectory: string): string {
  return resolve(runDirectory, 'queue.json')
}

export function getTaskStorePath(runDirectory: string): string {
  return resolve(runDirectory, 'task-store.json')
}

export function getTasksDirectory(runDirectory: string): string {
  return resolve(runDirectory, 'tasks')
}

export function getTaskRecordPath(runDirectory: string, taskId: string): string {
  return resolve(getTasksDirectory(runDirectory), `${taskId}.json`)
}

export function queueExists(runDirectory: string): boolean {
  return existsSync(getQueuePath(runDirectory))
}

function buildTaskStoreSnapshot(goal: string, plan: Plan, tasks: PersistedTaskRecord[]): TaskStoreSnapshot {
  const taskStates = tasks.map((task) => task.state)
  const pendingTaskIds = taskStates
    .filter((taskState) => ['pending', 'ready', 'in_progress'].includes(taskState.status))
    .map((taskState) => taskState.taskId)
  const blockedTaskIds = taskStates.filter((taskState) => taskState.status === 'blocked').map((taskState) => taskState.taskId)
  const completedTaskIds = taskStates.filter((taskState) => taskState.status === 'completed').map((taskState) => taskState.taskId)
  const results = tasks.map((task) => task.result).filter(Boolean) as TaskExecutionResult[]

  return {
    goal,
    plan,
    assignments: tasks.map((task) => task.assignment),
    taskStates,
    pendingTaskIds,
    blockedTaskIds,
    completedTaskIds,
    results,
    artifactsByTaskId: Object.fromEntries(
      tasks
        .filter((task) => task.artifacts !== null)
        .map((task) => [task.taskId, task.artifacts!])
    )
  }
}

export function savePersistentRunState(runDirectory: string, state: PersistentRunState, plan: Plan): void {
  ensureDir(runDirectory)
  ensureDir(getTasksDirectory(runDirectory))

  const taskOrder = new Set(state.queue.taskOrder)
  for (const fileName of readdirSync(getTasksDirectory(runDirectory), { encoding: 'utf8' })) {
    if (!fileName.endsWith('.json')) {
      continue
    }

    const taskId = fileName.replace(/\.json$/, '')
    if (!taskOrder.has(taskId)) {
      rmSync(resolve(getTasksDirectory(runDirectory), fileName), { force: true })
    }
  }

  for (const task of state.tasks) {
    atomicWriteJson(getTaskRecordPath(runDirectory, task.taskId), task)
  }

  atomicWriteJson(getQueuePath(runDirectory), state.queue)
  atomicWriteJson(getTaskStorePath(runDirectory), buildTaskStoreSnapshot(state.queue.goal, plan, state.tasks))
}

export function loadTaskStoreSnapshot(runDirectory: string): TaskStoreSnapshot {
  return readJsonFile<TaskStoreSnapshot>(getTaskStorePath(runDirectory))
}

export function loadPersistentRunState(runDirectory: string): PersistentRunState {
  const queue = readJsonFile<TaskQueueSnapshot>(getQueuePath(runDirectory))
  const tasks = queue.taskOrder.map((taskId) => readJsonFile<PersistedTaskRecord>(getTaskRecordPath(runDirectory, taskId)))
  return { queue, tasks }
}
