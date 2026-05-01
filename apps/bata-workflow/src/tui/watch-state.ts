import { existsSync } from 'node:fs'
import { basename, dirname } from 'node:path'

import type { MailboxMessage, RunReport, RuntimeTaskState, Task, TaskArtifacts, WorkerSnapshot } from '../domain/types.js'
import { getRunReportPath, loadLatestRunPointer, loadRunReport } from '../runtime/state-store.js'
import { buildRunSummary, loadTaskQueue } from '../runtime/task-queue.js'
import { queueExists } from '../runtime/task-store.js'

const PLACEHOLDER = '--'
const DEFAULT_HOT_TASK_LIMIT = 8
const DEFAULT_RECENT_EVENT_LIMIT = 8
const DEFAULT_TASK_MAILBOX_LIMIT = 3
const HANDOFF_SUMMARY_PATTERN = /(交接|handoff|移交)/i
const FAILURE_MAILBOX_PATTERN = /^(执行失败:\s*|failed:\s*|failure:\s*|error:\s*)/i

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
  tmuxSessionLabel: string | null
  totalTaskCount: number
  completedTaskCount: number
  failedTaskCount: number
  blockedTaskCount: number
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
  scopeLabel: string
  status: WorkerSnapshot['status']
  roleLabel: string
  taskId: string | null
  taskTitle: string
  modelLabel: string
  heartbeatLabel: string
  paneLabel: string
  tmuxSessionLabel: string
  isPlaceholder: boolean
}

export type WatchHotTaskViewModel = {
  taskId: string
  title: string
  role: string
  taskType: Task['taskType']
  status: RuntimeTaskState['status']
  phase: RuntimeTaskState['phase']
  phaseDetail: RuntimeTaskState['phaseDetail']
  attempts: number
  maxAttempts: number
  lastError: string | null
  generatedFromTaskId: string | null
  lastUpdatedAt: string | null
  summary: string | null
}

export type WatchRecentEventViewModel = {
  source: 'event' | 'mailbox'
  type: string
  createdAt: string | null
  workerId: string | null
  batchId: string | null
  taskId: string | null
  detail: string
}

export type WatchSelectedTaskViewModel = {
  taskId: string
  title: string
  role: string
  taskType: Task['taskType']
  status: RuntimeTaskState['status']
  phase: RuntimeTaskState['phase']
  phaseDetail: RuntimeTaskState['phaseDetail']
  attempts: number
  maxAttempts: number
  lastError: string | null
  summary: string | null
  dependsOn: string[]
  generatedFromTaskId: string | null
  execution: WatchTaskExecutionViewModel | null
  failureDetail: WatchFailureDetailViewModel | null
  collaboration: WatchTaskCollaborationViewModel
  artifacts: WatchTaskArtifactsViewModel
}

export type WatchTaskExecutionViewModel = {
  workerId: string
  slotId: number | null
  paneId: string | null
  tmuxSessionLabel: string | null
}

export type WatchTaskArtifactsViewModel = {
  changes: Array<{
    path: string
    type: 'added' | 'modified' | 'deleted'
    stats: string | null
  }>
  generatedFiles: string[]
  notes: string[]
}

export type WatchFailureAttemptViewModel = {
  attempt: number
  workerId: string | null
  startedAt: string | null
  finishedAt: string | null
  status: Extract<RuntimeTaskState['attemptHistory'][number]['status'], 'failed'>
}

export type WatchRerouteViewModel = {
  fromRole: string | null
  toRole: string | null
  reason: string
}

export type WatchBlockedDependentViewModel = {
  taskId: string
  title: string
  status: RuntimeTaskState['status']
}

export type WatchFailureDetailViewModel = {
  latestFailureMessage: string | null
  summary: string | null
  failedAttempts: WatchFailureAttemptViewModel[]
  rerouteHistory: WatchRerouteViewModel[]
  blockedDependents: WatchBlockedDependentViewModel[]
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
  artifacts: TaskArtifacts | null
}

function derivePhaseFromStatus(state: Pick<RuntimeTaskState, 'status' | 'nextAttemptAt'>): RuntimeTaskState['phase'] {
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

function normalizeRuntimeTaskState(state: RuntimeTaskState): RuntimeTaskState {
  const candidate = state as RuntimeTaskState & Partial<Pick<RuntimeTaskState, 'phase' | 'phaseDetail'>>
  return {
    ...state,
    phase: candidate.phase ?? derivePhaseFromStatus(state),
    phaseDetail: candidate.phaseDetail ?? null
  }
}

function formatNullable(value: string | null | undefined): string {
  return value && value.trim() ? value : PLACEHOLDER
}

function formatWorkerScopeLabel(worker: Pick<WorkerSnapshot, 'workerId' | 'slotId' | 'tmux'> | null | undefined): string {
  if (!worker) {
    return PLACEHOLDER
  }

  return [worker.workerId, worker.slotId ? `S${worker.slotId}` : null, worker.tmux?.paneId ?? null]
    .filter((part): part is string => Boolean(part))
    .join('/')
}

function resolveTmuxSessionLabel(workers: WorkerSnapshot[]): string | null {
  return workers.find((worker) => worker.tmux?.sessionName)?.tmux?.sessionName ?? null
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
    case 'blocked':
      return 1
    case 'in_progress':
      return 2
    case 'ready':
      return 3
    case 'completed':
      return 4
    default:
      return 5
  }
}

function getRecentActivityTimestamp(createdAt: string | null | undefined): number {
  return createdAt ? Date.parse(createdAt) || 0 : 0
}

function resolveEventCreatedAt(
  event: RunReport['runtime']['events'][number],
  taskMetadataById: Map<string, TaskMetadata>
): string | null {
  if (event.createdAt) {
    return event.createdAt
  }

  return event.taskId ? taskMetadataById.get(event.taskId)?.state.lastUpdatedAt ?? null : null
}

function buildReportFromQueue(runDirectory: string): RunReport {
  const queue = loadTaskQueue(runDirectory)
  const runtime = queue.getRuntimeSnapshot()
  const results = queue.listResults()

  return {
    goal: queue.goal,
    plan: queue.plan,
    assignments: queue.listAssignments(),
    batches: runtime.batches,
    runtime,
    results,
    summary: buildRunSummary({ runtime, results }),
    artifactsByTaskId: queue.listArtifactsByTaskId()
  }
}

function buildTaskMetadata(report: RunReport): TaskMetadata[] {
  const stateByTaskId = new Map(report.runtime.taskStates.map((state) => {
    const normalizedState = normalizeRuntimeTaskState(state)
    return [normalizedState.taskId, normalizedState] as const
  }))
  const summaryByTaskId = new Map(report.results.map((result) => [result.taskId, result.summary]))
  const assignmentByTaskId = new Map(report.assignments.map((assignment) => [assignment.task.id, assignment]))

  return report.plan.tasks
    .map((task) => {
      const assignment = assignmentByTaskId.get(task.id)
      const state = stateByTaskId.get(task.id)
      if (!state) {
        return null
      }

      return {
        task: assignment
          ? {
              ...task,
              ...assignment.task,
              role: assignment.roleDefinition.name
            }
          : task,
        state,
        summary: summaryByTaskId.get(task.id) ?? null,
        artifacts: report.artifactsByTaskId?.[task.id] ?? null
      } satisfies TaskMetadata
    })
    .filter((entry): entry is TaskMetadata => entry !== null)
}

function buildSelectedTaskArtifactsViewModel(entry: TaskMetadata): WatchTaskArtifactsViewModel {
  const artifacts = entry.artifacts
  if (!artifacts) {
    return {
      changes: [],
      generatedFiles: [],
      notes: ['No recorded artifacts']
    }
  }

  return {
    changes: artifacts.changes.map((change) => ({
      path: change.path,
      type: change.type,
      stats:
        change.additions == null && change.deletions == null
          ? null
          : `+${change.additions ?? 0} -${change.deletions ?? 0}`
    })),
    generatedFiles: [...artifacts.generatedFiles],
    notes: [...artifacts.notes]
  }
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

function buildFailureAttempts(entry: TaskMetadata): WatchFailureAttemptViewModel[] {
  return entry.state.attemptHistory
    .filter((attempt) => attempt.status === 'failed')
    .map((attempt) => ({
      attempt: attempt.attempt,
      workerId: attempt.workerId,
      startedAt: attempt.startedAt,
      finishedAt: attempt.finishedAt,
      status: 'failed'
    }))
}

function parseRerouteEvent(detail: string, fallbackRole: string | null): WatchRerouteViewModel {
  const toRoleMatch = detail.match(/role=(.+?)(?:,\s*model=|$)/)

  return {
    fromRole: fallbackRole,
    toRole: toRoleMatch?.[1]?.trim() ?? null,
    reason: detail
  }
}

function normalizeFailureMessage(message: string): string {
  return message
    .replace(/^.+?执行\s+.+?失败:\s*/u, '')
    .replace(/^执行失败:\s*/u, '')
    .replace(/^(failed|failure|error|timeout):\s*/iu, '')
    .trim()
}

function buildBlockedDependents(
  entry: TaskMetadata,
  taskMetadataById: Map<string, TaskMetadata>
): WatchBlockedDependentViewModel[] {
  return Array.from(taskMetadataById.values())
    .filter((candidate) => candidate.task.id !== entry.task.id)
    .filter((candidate) => candidate.task.dependsOn.includes(entry.task.id) && candidate.state.status === 'blocked')
    .sort((left, right) => {
      const timeDiff = getTaskSortTimestamp(right.state) - getTaskSortTimestamp(left.state)
      if (timeDiff !== 0) {
        return timeDiff
      }

      return left.task.id.localeCompare(right.task.id, 'zh-Hans-CN')
    })
    .map((candidate) => ({
      taskId: candidate.task.id,
      title: candidate.task.title,
      status: candidate.state.status
    }))
}

function buildLatestFailureMessage(report: RunReport, entry: TaskMetadata): string | null {
  if (entry.state.lastError?.trim()) {
    return normalizeFailureMessage(entry.state.lastError)
  }

  const eventDetail = [...report.runtime.events]
    .reverse()
    .find((event) => event.type === 'task-failed' && event.taskId === entry.task.id)?.detail
  if (eventDetail?.trim()) {
    return normalizeFailureMessage(eventDetail)
  }

  const outboundMailbox = [...report.runtime.mailbox]
    .reverse()
    .find((message) => {
      return message.taskId === entry.task.id
        && message.direction === 'outbound'
        && FAILURE_MAILBOX_PATTERN.test(message.content)
    })?.content

  if (outboundMailbox?.trim()) {
    return normalizeFailureMessage(outboundMailbox)
  }

  return null
}

function buildSelectedTaskFailureDetailViewModel(
  report: RunReport,
  entry: TaskMetadata,
  taskMetadataById: Map<string, TaskMetadata>
): WatchFailureDetailViewModel | null {
  const originalTask = report.plan.tasks.find((task) => task.id === entry.task.id) ?? null
  const failedAttempts = buildFailureAttempts(entry)
  const rerouteHistory = report.runtime.events
    .filter((event) => event.type === 'task-rerouted' && event.taskId === entry.task.id)
    .reduce<WatchRerouteViewModel[]>((history, event) => {
      const previousRole = history[history.length - 1]?.toRole ?? originalTask?.role ?? entry.task.role
      history.push(parseRerouteEvent(event.detail, previousRole))
      return history
    }, [])
  const blockedDependents = buildBlockedDependents(entry, taskMetadataById)

  if (entry.state.status !== 'failed') {
    return null
  }

  return {
    latestFailureMessage: buildLatestFailureMessage(report, entry),
    summary: entry.summary,
    failedAttempts,
    rerouteHistory,
    blockedDependents
  }
}

function buildSelectedTaskExecutionViewModel(report: RunReport, entry: TaskMetadata): WatchTaskExecutionViewModel | null {
  const workerId = entry.state.claimedBy ?? entry.state.workerHistory.at(-1) ?? null
  if (!workerId) {
    return null
  }

  const worker = report.runtime.workers.find((candidate) => candidate.workerId === workerId)
  return {
    workerId,
    slotId: worker?.slotId ?? null,
    paneId: worker?.tmux?.paneId ?? null,
    tmuxSessionLabel: worker?.tmux?.sessionName ?? null
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
    phase: entry.state.phase,
    phaseDetail: entry.state.phaseDetail,
    attempts: entry.state.attempts,
    maxAttempts: entry.state.maxAttempts,
    lastError: entry.state.lastError,
    summary: entry.summary,
    dependsOn: entry.task.dependsOn,
    generatedFromTaskId: entry.task.generatedFromTaskId ?? null,
    execution: buildSelectedTaskExecutionViewModel(report, entry),
    failureDetail: buildSelectedTaskFailureDetailViewModel(report, entry, taskMetadataById),
    collaboration: buildSelectedTaskCollaborationViewModel(report, entry, taskMetadataById),
    artifacts: buildSelectedTaskArtifactsViewModel(entry)
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
      failed: 0,
      blocked: 0
    } as Record<RuntimeTaskState['status'], number>
  )
  const batchCount = report.runtime.batches.length
  const settledBatchCount = report.runtime.batches.filter((batch) => {
    return batch.taskIds.every((taskId) => {
      const taskState = report.runtime.taskStates.find((state) => state.taskId === taskId)
      return taskState ? ['completed', 'failed', 'blocked'].includes(taskState.status) : false
    })
  }).length
  const overallStatus =
    statusCounts.in_progress > 0 || statusCounts.ready > 0 || statusCounts.pending > 0
      ? 'RUNNING'
      : statusCounts.failed > 0 || statusCounts.blocked > 0
        ? 'FAILED'
        : 'COMPLETED'
  const tmuxSessionLabel = resolveTmuxSessionLabel(report.runtime.workers)

  const workers = Array.from({ length: Math.max(report.runtime.workers.length, report.runtime.maxConcurrency, 1) }, (_, index) => {
    const workerId = `W${index + 1}`
    const worker = report.runtime.workers.find((candidate) => candidate.workerId === workerId)
    const task = worker?.taskId ? taskById.get(worker.taskId) : null

    return {
      workerId,
      scopeLabel: worker ? formatWorkerScopeLabel(worker) : workerId,
      status: worker?.status ?? 'idle',
      roleLabel: formatNullable(worker?.role),
      taskId: worker?.taskId ?? null,
      taskTitle: formatNullable(task?.title),
      modelLabel: formatNullable(worker?.model),
      heartbeatLabel: formatNullable(worker?.lastHeartbeatAt),
      paneLabel: formatNullable(worker?.tmux?.paneId ?? null),
      tmuxSessionLabel: formatNullable(worker?.tmux?.sessionName ?? null),
      isPlaceholder: !worker
    } satisfies WatchWorkerViewModel
  })

  const sortedHotTaskEntries = tasks
    .filter(({ state }) => ['failed', 'blocked', 'in_progress', 'ready', 'completed'].includes(state.status))
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
      phase: state.phase,
      phaseDetail: state.phaseDetail,
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

  const recentEvents = [
    ...report.runtime.events.map((event) => ({
      source: 'event' as const,
      type: event.type,
      createdAt: resolveEventCreatedAt(event, taskMetadataById),
      workerId: null,
      batchId: event.batchId,
      taskId: event.taskId ?? null,
      detail: event.detail
    })),
    ...report.runtime.mailbox.map((message) => ({
      source: 'mailbox' as const,
      type: `mailbox:${message.direction}`,
      createdAt: message.createdAt,
      workerId: message.workerId,
      batchId: null,
      taskId: message.taskId,
      detail: message.content
    }))
  ]
    .sort((left, right) => {
      const timeDiff = getRecentActivityTimestamp(right.createdAt) - getRecentActivityTimestamp(left.createdAt)
      if (timeDiff !== 0) {
        return timeDiff
      }

      return right.type.localeCompare(left.type, 'zh-Hans-CN')
    })
    .slice(0, recentEventLimit)

  return {
    resolvedRun,
    summary: {
      runLabel: resolvedRun.runDirectory ? basename(resolvedRun.runDirectory) : basename(resolvedRun.reportPath),
      goal: report.goal,
      overallStatus,
      batchProgress: `${settledBatchCount}/${batchCount}`,
      tmuxSessionLabel,
      totalTaskCount: report.plan.tasks.length,
      completedTaskCount: statusCounts.completed,
      failedTaskCount: statusCounts.failed,
      blockedTaskCount: statusCounts.blocked,
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

  if (resolvedRun.runDirectory && queueExists(resolvedRun.runDirectory)) {
    const report = buildReportFromQueue(resolvedRun.runDirectory)
    return buildWatchViewModel(report, resolvedRun, options)
  }

  if (existsSync(resolvedRun.reportPath)) {
    const report = loadRunReport(resolvedRun.reportPath)
    return buildWatchViewModel(report, resolvedRun, options)
  }

  throw new Error(`未找到运行报告: ${resolvedRun.reportPath}`)
}
