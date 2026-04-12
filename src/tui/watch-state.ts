import { existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'

import type { MailboxMessage, RunReport, RuntimeTaskState, Task, WorkerSnapshot } from '../domain/types.js'
import { getRunReportPath, loadLatestRunPointer, loadRunReport } from '../runtime/state-store.js'

const PLACEHOLDER = '--'
const DEFAULT_HOT_TASK_LIMIT = 8
const DEFAULT_RECENT_EVENT_LIMIT = 8
const DEFAULT_TASK_MAILBOX_LIMIT = 3
const HANDOFF_SUMMARY_PATTERN = /(交接|handoff|移交)/i

export type WatchStateOptions = {
  stateRoot: string
  runDirectory?: string
  reportPath?: string
  selectedTaskId?: string
  hotTaskLimit?: number
  recentEventLimit?: number
}

export type WatchResolvedRun = {
  runDirectory: string | null
  reportPath: string
}

export type WatchSummaryViewModel = {
  runLabel: string
  goal: string
  overallStatus: 'RUNNING' | 'FAILED' | 'COMPLETED'
  batchProgress: string
  totalTaskCount: number
  completedTaskCount: number
  failedTaskCount: number
  inProgressTaskCount: number
  readyTaskCount: number
  pendingTaskCount: number
  generatedTaskCount: number
  retryTaskCount: number
  loopCount: number
  loopedSourceTaskIds: string[]
  maxConcurrency: number
}

export type WatchWorkerViewModel = {
  workerId: string
  status: WorkerSnapshot['status']
  roleLabel: string
  taskId: string | null
  taskTitle: string
  modelLabel: string
  heartbeatLabel: string
  isPlaceholder: boolean
}

export type WatchHotTaskViewModel = {
  taskId: string
  title: string
  role: string
  taskType: Task['taskType']
  status: RuntimeTaskState['status']
  attempts: number
  maxAttempts: number
  lastError: string | null
  generatedFromTaskId: string | null
  lastUpdatedAt: string | null
  summary: string | null
}

export type WatchRecentEventViewModel = {
  type: RunReport['runtime']['events'][number]['type']
  batchId: string
  taskId: string | null
  detail: string
}

export type WatchSelectedTaskViewModel = {
  taskId: string
  title: string
  role: string
  taskType: Task['taskType']
  status: RuntimeTaskState['status']
  attempts: number
  maxAttempts: number
  lastError: string | null
  summary: string | null
  dependsOn: string[]
  generatedFromTaskId: string | null
  collaboration: WatchTaskCollaborationViewModel
}

export type WatchTaskMailboxMessageViewModel = {
  messageId: string
  workerId: string
  taskId: string
  direction: MailboxMessage['direction']
  content: string
  createdAt: string
}

export type WatchTaskUpstreamViewModel = {
  taskId: string
  role: string
  taskType: Task['taskType']
  status: RuntimeTaskState['status']
  summary: string | null
}

export type WatchTaskCollaborationViewModel = {
  mailbox: WatchTaskMailboxMessageViewModel[]
  upstream: WatchTaskUpstreamViewModel[]
  handoffSummary: string | null
  collaborationStatus: {
    hasInboundMailbox: boolean
    hasOutboundMailbox: boolean
    hasUpstreamSummaries: boolean
  }
}

export type WatchViewModel = {
  resolvedRun: WatchResolvedRun
  summary: WatchSummaryViewModel
  workers: WatchWorkerViewModel[]
  hotTasks: WatchHotTaskViewModel[]
  selectedTask: WatchSelectedTaskViewModel | null
  recentEvents: WatchRecentEventViewModel[]
}

type TaskMetadata = {
  task: Task
  state: RuntimeTaskState
  summary: string | null
}

function formatNullable(value: string | null | undefined): string {
  return value && value.trim() ? value : PLACEHOLDER
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && value! > 0 ? value! : fallback
}

export function resolveWatchRun(options: WatchStateOptions): WatchResolvedRun {
  if (options.reportPath) {
    return {
      runDirectory: dirname(options.reportPath),
      reportPath: options.reportPath
    }
  }

  if (options.runDirectory) {
    return {
      runDirectory: options.runDirectory,
      reportPath: getRunReportPath(options.runDirectory)
    }
  }

  const latestRun = loadLatestRunPointer(options.stateRoot)
  if (!latestRun) {
    throw new Error('未找到可观察的运行，请先执行 run，或通过 --runDirectory/--reportPath 指定目标')
  }

  return {
    runDirectory: latestRun.runDirectory,
    reportPath: latestRun.reportPath
  }
}

function getTaskSortTimestamp(state: RuntimeTaskState): number {
  const attemptFinishedAt = [...state.attemptHistory]
    .reverse()
    .find((attempt) => attempt.finishedAt)?.finishedAt
  const candidate = attemptFinishedAt ?? state.lastUpdatedAt ?? state.lastClaimedAt ?? state.releasedAt ?? state.nextAttemptAt

  return candidate ? Date.parse(candidate) || 0 : 0
}

function getHotTaskRank(status: RuntimeTaskState['status']): number {
  switch (status) {
    case 'failed':
      return 0
    case 'in_progress':
      return 1
    case 'ready':
      return 2
    case 'completed':
      return 3
    default:
      return 4
  }
}

function buildTaskMetadata(report: RunReport): TaskMetadata[] {
  const stateByTaskId = new Map(report.runtime.taskStates.map((state) => [state.taskId, state]))
  const summaryByTaskId = new Map(report.results.map((result) => [result.taskId, result.summary]))

  return report.plan.tasks
    .map((task) => {
      const state = stateByTaskId.get(task.id)
      if (!state) {
        return null
      }

      return {
        task,
        state,
        summary: summaryByTaskId.get(task.id) ?? null
      } satisfies TaskMetadata
    })
    .filter((entry): entry is TaskMetadata => entry !== null)
}

function buildSelectedTaskCollaborationViewModel(
  report: RunReport,
  entry: TaskMetadata,
  taskMetadataById: Map<string, TaskMetadata>
): WatchTaskCollaborationViewModel {
  const relatedMailbox = report.runtime.mailbox.filter((message) => message.taskId === entry.task.id)
  const mailbox = relatedMailbox
    .slice(-DEFAULT_TASK_MAILBOX_LIMIT)
    .reverse()
    .map((message) => ({
      messageId: message.messageId,
      workerId: message.workerId,
      taskId: message.taskId,
      direction: message.direction,
      content: message.content,
      createdAt: message.createdAt
    }))
  const latestInboundMailbox = [...relatedMailbox].reverse().find((message) => message.direction === 'inbound')
  const upstream = entry.task.dependsOn
    .map((taskId) => {
      const dependencyEntry = taskMetadataById.get(taskId)
      if (!dependencyEntry) {
        return null
      }

      return {
        taskId: dependencyEntry.task.id,
        role: dependencyEntry.task.role,
        taskType: dependencyEntry.task.taskType,
        status: dependencyEntry.state.status,
        summary: dependencyEntry.summary
      } satisfies WatchTaskUpstreamViewModel
    })
    .filter((item): item is WatchTaskUpstreamViewModel => item !== null)

  return {
    mailbox,
    upstream,
    handoffSummary: latestInboundMailbox && HANDOFF_SUMMARY_PATTERN.test(latestInboundMailbox.content) ? latestInboundMailbox.content : null,
    collaborationStatus: {
      hasInboundMailbox: relatedMailbox.some((message) => message.direction === 'inbound'),
      hasOutboundMailbox: relatedMailbox.some((message) => message.direction === 'outbound'),
      hasUpstreamSummaries: upstream.some((item) => Boolean(item.summary))
    }
  }
}

function toSelectedTaskViewModel(
  report: RunReport,
  entry: TaskMetadata,
  taskMetadataById: Map<string, TaskMetadata>
): WatchSelectedTaskViewModel {
  return {
    taskId: entry.task.id,
    title: entry.task.title,
    role: entry.task.role,
    taskType: entry.task.taskType,
    status: entry.state.status,
    attempts: entry.state.attempts,
    maxAttempts: entry.state.maxAttempts,
    lastError: entry.state.lastError,
    summary: entry.summary,
    dependsOn: entry.task.dependsOn,
    generatedFromTaskId: entry.task.generatedFromTaskId ?? null,
    collaboration: buildSelectedTaskCollaborationViewModel(report, entry, taskMetadataById)
  }
}

export function buildWatchViewModel(report: RunReport, resolvedRun: WatchResolvedRun, options: WatchStateOptions): WatchViewModel {
  const tasks = buildTaskMetadata(report)
  const taskById = new Map(tasks.map((entry) => [entry.task.id, entry.task]))
  const taskMetadataById = new Map(tasks.map((entry) => [entry.task.id, entry]))
  const hotTaskLimit = normalizePositiveInteger(options.hotTaskLimit, DEFAULT_HOT_TASK_LIMIT)
  const recentEventLimit = normalizePositiveInteger(options.recentEventLimit, DEFAULT_RECENT_EVENT_LIMIT)
  const statusCounts = report.runtime.taskStates.reduce(
    (accumulator, taskState) => {
      accumulator[taskState.status] += 1
      return accumulator
    },
    {
      pending: 0,
      ready: 0,
      in_progress: 0,
      completed: 0,
      failed: 0
    } as Record<RuntimeTaskState['status'], number>
  )
  const batchCount = report.runtime.batches.length
  const settledBatchCount = report.runtime.batches.filter((batch) => {
    return batch.taskIds.every((taskId) => {
      const taskState = report.runtime.taskStates.find((state) => state.taskId === taskId)
      return taskState ? ['completed', 'failed'].includes(taskState.status) : false
    })
  }).length
  const overallStatus =
    statusCounts.in_progress > 0 || statusCounts.ready > 0 || statusCounts.pending > 0
      ? 'RUNNING'
      : statusCounts.failed > 0
        ? 'FAILED'
        : 'COMPLETED'

  const workers = Array.from({ length: Math.max(report.runtime.maxConcurrency, 1) }, (_, index) => {
    const workerId = `W${index + 1}`
    const worker = report.runtime.workers.find((candidate) => candidate.workerId === workerId)
    const task = worker?.taskId ? taskById.get(worker.taskId) : null

    return {
      workerId,
      status: worker?.status ?? 'idle',
      roleLabel: formatNullable(worker?.role),
      taskId: worker?.taskId ?? null,
      taskTitle: formatNullable(task?.title),
      modelLabel: formatNullable(worker?.model),
      heartbeatLabel: formatNullable(worker?.lastHeartbeatAt),
      isPlaceholder: !worker
    } satisfies WatchWorkerViewModel
  })

  const sortedHotTaskEntries = tasks
    .filter(({ state }) => ['failed', 'in_progress', 'ready', 'completed'].includes(state.status))
    .sort((left, right) => {
      const rankDiff = getHotTaskRank(left.state.status) - getHotTaskRank(right.state.status)
      if (rankDiff !== 0) {
        return rankDiff
      }

      const timeDiff = getTaskSortTimestamp(right.state) - getTaskSortTimestamp(left.state)
      if (timeDiff !== 0) {
        return timeDiff
      }

      return left.task.id.localeCompare(right.task.id, 'zh-Hans-CN')
    })

  const hotTasks = sortedHotTaskEntries
    .slice(0, hotTaskLimit)
    .map(({ task, state, summary }) => ({
      taskId: task.id,
      title: task.title,
      role: task.role,
      taskType: task.taskType,
      status: state.status,
      attempts: state.attempts,
      maxAttempts: state.maxAttempts,
      lastError: state.lastError,
      generatedFromTaskId: task.generatedFromTaskId ?? null,
      lastUpdatedAt: state.lastUpdatedAt,
      summary
    }))

  const selectedTaskEntry =
    sortedHotTaskEntries.find((entry) => entry.task.id === options.selectedTaskId) ??
    sortedHotTaskEntries[0] ??
    null

  const selectedTask = selectedTaskEntry
    ? toSelectedTaskViewModel(report, taskMetadataById.get(selectedTaskEntry.task.id)!, taskMetadataById)
    : null

  const recentEvents = report.runtime.events
    .slice(-recentEventLimit)
    .reverse()
    .map((event) => ({
      type: event.type,
      batchId: event.batchId,
      taskId: event.taskId ?? null,
      detail: event.detail
    }))

  return {
    resolvedRun,
    summary: {
      runLabel: resolvedRun.runDirectory ? basename(resolvedRun.runDirectory) : basename(resolvedRun.reportPath),
      goal: report.goal,
      overallStatus,
      batchProgress: `${settledBatchCount}/${batchCount}`,
      totalTaskCount: report.plan.tasks.length,
      completedTaskCount: statusCounts.completed,
      failedTaskCount: statusCounts.failed,
      inProgressTaskCount: statusCounts.in_progress,
      readyTaskCount: statusCounts.ready,
      pendingTaskCount: statusCounts.pending,
      generatedTaskCount: report.runtime.dynamicTaskStats.generatedTaskCount,
      retryTaskCount: report.summary.retryTaskCount,
      loopCount: report.summary.loopCount,
      loopedSourceTaskIds: report.summary.loopedSourceTaskIds,
      maxConcurrency: report.runtime.maxConcurrency
    },
    workers,
    hotTasks,
    selectedTask,
    recentEvents
  }
}

export function loadWatchViewModel(options: WatchStateOptions): WatchViewModel {
  const resolvedRun = resolveWatchRun(options)

  if (!existsSync(resolvedRun.reportPath)) {
    throw new Error(`未找到运行报告: ${resolvedRun.reportPath}`)
  }

  const report = loadRunReport(resolvedRun.reportPath)
  return buildWatchViewModel(report, resolvedRun, options)
}
