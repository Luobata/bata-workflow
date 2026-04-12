import type { WatchViewModel } from './watch-state.js'

const COLUMN_GAP = '  '
const WORKERS_WIDTH = 66
const HOT_TASKS_WIDTH = 60
const TASK_DETAILS_WIDTH = 46
const RECENT_EVENT_DETAIL_WIDTH = 88
const PLACEHOLDER = '--'
const TASK_DETAILS_SECTION_SPACER = ''
const TASK_DETAILS_MAILBOX_LIMIT = 2
const TASK_DETAILS_UPSTREAM_LIMIT = 2

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text
  }

  return `${text.slice(0, Math.max(0, maxLength - 1))}…`
}

function pad(text: string, width: number): string {
  return truncate(text, width).padEnd(width, ' ')
}

function formatNullable(value: string | null | undefined): string {
  return value && value.trim() ? value : PLACEHOLDER
}

function formatDetailLine(label: string, value: string, width = TASK_DETAILS_WIDTH): string {
  const prefix = `${label}: `
  return `${prefix}${truncate(value, Math.max(0, width - prefix.length))}`
}

function formatIndentedLine(value: string, width = TASK_DETAILS_WIDTH): string {
  const prefix = '  - '
  return `${prefix}${truncate(value, Math.max(0, width - prefix.length))}`
}

function formatMailboxSummary(direction: 'inbound' | 'outbound', content: string): string {
  return `${direction} ${content}`
}

function formatUpstreamSummary(taskId: string, status: string, summary: string | null): string {
  return `${taskId}/${status}/${formatNullable(summary)}`
}

function renderTaskOverviewSection(view: NonNullable<WatchViewModel['selectedTask']>): string[] {
  return [
    'Overview',
    formatDetailLine('Task ID', view.taskId),
    formatDetailLine('Title', view.title),
    formatDetailLine('Role', view.role),
    formatDetailLine('Task Type', view.taskType),
    formatDetailLine('Status', view.status),
    formatDetailLine('Attempts', `${view.attempts}/${view.maxAttempts}`),
    formatDetailLine('Last Error', formatNullable(view.lastError)),
    formatDetailLine('Summary', formatNullable(view.summary)),
    formatDetailLine('Depends On', view.dependsOn.length > 0 ? view.dependsOn.join(', ') : PLACEHOLDER),
    formatDetailLine('Generated From', formatNullable(view.generatedFromTaskId))
  ]
}

function renderTaskCollaborationSection(view: NonNullable<WatchViewModel['selectedTask']>): string[] {
  const mailboxLines =
    view.collaboration.mailbox.length > 0
      ? view.collaboration.mailbox
          .slice(0, TASK_DETAILS_MAILBOX_LIMIT)
          .map((message) => formatMailboxSummary(message.direction, message.content))
      : ['No mailbox activity']
  const upstreamLines =
    view.collaboration.upstream.length > 0
      ? view.collaboration.upstream
          .slice(0, TASK_DETAILS_UPSTREAM_LIMIT)
          .map((item) => formatUpstreamSummary(item.taskId, item.status, item.summary))
      : ['No upstream tasks']

  return [
    'Collaboration',
    formatDetailLine('Mailbox', mailboxLines[0]!),
    ...mailboxLines.slice(1).map((line) => formatIndentedLine(line)),
    formatDetailLine('Upstream', upstreamLines[0]!),
    ...upstreamLines.slice(1).map((line) => formatIndentedLine(line)),
    formatDetailLine('Handoff', view.collaboration.handoffSummary ?? 'No handoff summary'),
    formatDetailLine(
      'Collab Status',
      `in=${view.collaboration.collaborationStatus.hasInboundMailbox ? 'Y' : 'N'} out=${view.collaboration.collaborationStatus.hasOutboundMailbox ? 'Y' : 'N'} up=${view.collaboration.collaborationStatus.hasUpstreamSummaries ? 'Y' : 'N'}`
    )
  ]
}

function renderSummary(view: WatchViewModel): string[] {
  const { summary } = view

  return [
    `Run: ${summary.runLabel}    Status: ${summary.overallStatus}    Batch: ${summary.batchProgress}`,
    `Goal: ${summary.goal}`,
    `Tasks: total=${summary.totalTaskCount} completed=${summary.completedTaskCount} failed=${summary.failedTaskCount} in_progress=${summary.inProgressTaskCount} ready=${summary.readyTaskCount} pending=${summary.pendingTaskCount}`,
    `Loops: generated=${summary.generatedTaskCount} retry=${summary.retryTaskCount} loop=${summary.loopCount} maxConcurrency=${summary.maxConcurrency}`
  ]
}

function renderHeader(title: string, width: number): string {
  return pad(title, width)
}

function renderWorkers(view: WatchViewModel): string[] {
  return [
    renderHeader('Workers', WORKERS_WIDTH),
    ...view.workers.map((worker) => {
      return `${pad(worker.workerId, 4)} ${pad(worker.roleLabel, 12)} ${pad(worker.status, 10)} ${pad(worker.taskId ?? PLACEHOLDER, 8)} ${truncate(worker.taskTitle, 28)}`
    })
  ]
}

function renderHotTasks(view: WatchViewModel): string[] {
  return [
    renderHeader('Hot Tasks', HOT_TASKS_WIDTH),
    ...view.hotTasks.map((task) => {
      const isSelected = view.selectedTask?.taskId === task.taskId
      const marker = isSelected ? '>' : ' '
      return `${marker} ${pad(task.taskId, 8)} ${pad(task.taskType, 12)} ${pad(task.status, 12)} ${truncate(task.title, 22)}`
    })
  ]
}

function renderTaskDetails(view: WatchViewModel): string[] {
  if (!view.selectedTask) {
    return [renderHeader('Task Details', TASK_DETAILS_WIDTH), 'No active task selected']
  }

  const task = view.selectedTask
  return [
    renderHeader('Task Details', TASK_DETAILS_WIDTH),
    ...renderTaskOverviewSection(task),
    TASK_DETAILS_SECTION_SPACER,
    ...renderTaskCollaborationSection(task)
  ]
}

function renderColumns(columns: Array<{ lines: string[]; width: number }>): string[] {
  const rowCount = Math.max(...columns.map((column) => column.lines.length))

  return Array.from({ length: rowCount }, (_, index) => {
    return columns
      .map((column, columnIndex) => {
        const line = column.lines[index] ?? ''
        if (columnIndex === columns.length - 1) {
          return truncate(line, column.width)
        }

        return pad(line, column.width)
      })
      .join(COLUMN_GAP)
      .trimEnd()
  })
}

function renderRecentEvents(view: WatchViewModel): string[] {
  return [
    'Recent Events',
    ...view.recentEvents.map((event) => {
      return `${pad(event.type, 16)} ${pad(event.batchId, 8)} ${pad(event.taskId ?? PLACEHOLDER, 10)} ${truncate(event.detail, RECENT_EVENT_DETAIL_WIDTH)}`
    })
  ]
}

export function renderWatchScreen(view: WatchViewModel): string {
  return [
    ...renderSummary(view),
    '',
    ...renderColumns([
      { lines: renderWorkers(view), width: WORKERS_WIDTH },
      { lines: renderHotTasks(view), width: HOT_TASKS_WIDTH },
      { lines: renderTaskDetails(view), width: TASK_DETAILS_WIDTH }
    ]),
    '',
    ...renderRecentEvents(view),
    '',
    '[↑/k] prev  [↓/j] next  [q] quit  [r] refresh  [p] pause'
  ].join('\n')
}
