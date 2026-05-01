import type { WatchPane } from './watch.js'
import type { WatchViewModel } from './watch-state.js'

type RenderWatchScreenOptions = {
  focusedPane?: WatchPane
  detailsScrollOffset?: number
  canRetrySelectedTask?: boolean
  canAbortRun?: boolean
  lastActionMessage?: string
  commandPalette?: {
    query: string
    actions: Array<{ label: string; enabled: boolean; selected: boolean; reason?: string }>
  }
}

const COLUMN_GAP = '  '
const WORKERS_WIDTH = 66
const HOT_TASKS_WIDTH = 60
const TASK_DETAILS_WIDTH = 46
const RECENT_EVENT_DETAIL_WIDTH = 88
const PLACEHOLDER = '--'
const TASK_DETAILS_SECTION_SPACER = ''
const TASK_DETAILS_MAILBOX_LIMIT = 2
const TASK_DETAILS_UPSTREAM_LIMIT = 2
const TASK_DETAILS_FAILURE_ATTEMPT_LIMIT = 3
const TASK_DETAILS_FAILURE_REROUTE_LIMIT = 3
const TASK_DETAILS_FAILURE_BLOCKED_LIMIT = 3
const TASK_DETAILS_ARTIFACT_CHANGE_LIMIT = 5
const TASK_DETAILS_GENERATED_FILE_LIMIT = 3

function clampDetailsScrollOffset(offset: number, maxOffset: number): number {
  if (!Number.isFinite(offset)) {
    return 0
  }

  const normalizedOffset = Math.trunc(offset)
  return Math.max(0, Math.min(normalizedOffset, Math.max(0, maxOffset)))
}

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
  const lastError = view.failureDetail?.latestFailureMessage ?? view.lastError

  return [
    'Overview',
    formatDetailLine('Task ID', view.taskId),
    formatDetailLine('Title', view.title),
    formatDetailLine('Role', view.role),
    formatDetailLine('Task Type', view.taskType),
    formatDetailLine('Status', view.status),
    formatDetailLine('Phase', view.phase),
    formatDetailLine('Phase Detail', formatNullable(view.phaseDetail)),
    formatDetailLine('Attempts', `${view.attempts}/${view.maxAttempts}`),
    formatDetailLine('Last Error', formatNullable(lastError)),
    formatDetailLine('Summary', formatNullable(view.summary)),
    formatDetailLine('Depends On', view.dependsOn.length > 0 ? view.dependsOn.join(', ') : PLACEHOLDER),
    formatDetailLine('Generated From', formatNullable(view.generatedFromTaskId)),
    formatDetailLine('Worker', formatNullable(view.execution?.workerId ?? null)),
    formatDetailLine('Slot', view.execution?.slotId != null ? String(view.execution.slotId) : PLACEHOLDER),
    formatDetailLine('Pane', formatNullable(view.execution?.paneId ?? null)),
    formatDetailLine('Tmux Session', formatNullable(view.execution?.tmuxSessionLabel ?? null))
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

function renderFailureAttempts(view: NonNullable<WatchViewModel['selectedTask']>): string[] {
  if (!view.failureDetail || view.failureDetail.failedAttempts.length === 0) {
    return ['No failed attempts']
  }

  return view.failureDetail.failedAttempts.slice(-TASK_DETAILS_FAILURE_ATTEMPT_LIMIT).reverse().map((attempt) => {
    return `${attempt.workerId ?? PLACEHOLDER}#${attempt.attempt}/${attempt.status}`
  })
}

function renderFailureReroutes(view: NonNullable<WatchViewModel['selectedTask']>): string[] {
  if (!view.failureDetail || view.failureDetail.rerouteHistory.length === 0) {
    return ['No reroute history']
  }

  return view.failureDetail.rerouteHistory.slice(-TASK_DETAILS_FAILURE_REROUTE_LIMIT).reverse().map((reroute) => {
    return `${formatNullable(reroute.fromRole)}→${formatNullable(reroute.toRole)} ${reroute.reason}`
  })
}

function renderFailureBlockedDependents(view: NonNullable<WatchViewModel['selectedTask']>): string[] {
  if (!view.failureDetail || view.failureDetail.blockedDependents.length === 0) {
    return ['No blocked dependents']
  }

  return view.failureDetail.blockedDependents.slice(0, TASK_DETAILS_FAILURE_BLOCKED_LIMIT).map((item) => {
    return `${item.taskId}/${item.status}/${item.title}`
  })
}

function renderTaskFailureSection(view: NonNullable<WatchViewModel['selectedTask']>): string[] {
  if (!view.failureDetail) {
    return ['Failure', 'No failure details']
  }

  const attemptLines = renderFailureAttempts(view)
  const rerouteLines = renderFailureReroutes(view)
  const blockedLines = renderFailureBlockedDependents(view)

  return [
    'Failure',
    formatDetailLine('Latest Failure', formatNullable(view.failureDetail.latestFailureMessage)),
    formatDetailLine('Summary', formatNullable(view.failureDetail.summary)),
    formatDetailLine('Attempts', attemptLines[0]!),
    ...attemptLines.slice(1).map((line) => formatIndentedLine(line)),
    formatDetailLine('Reroutes', rerouteLines[0]!),
    ...rerouteLines.slice(1).map((line) => formatIndentedLine(line)),
    formatDetailLine('Blocked Dependents', blockedLines[0]!),
    ...blockedLines.slice(1).map((line) => formatIndentedLine(line))
  ]
}

function renderTaskArtifactsSection(view: NonNullable<WatchViewModel['selectedTask']>): string[] {
  const artifactChanges =
    view.artifacts.changes.length > 0
      ? view.artifacts.changes.slice(0, TASK_DETAILS_ARTIFACT_CHANGE_LIMIT).map((change) => {
          const stats = change.stats ? ` ${change.stats}` : ''
          return `${change.type} ${change.path}${stats}`
        })
      : ['No recorded artifacts']
  const generatedFiles =
    view.artifacts.generatedFiles.length > 0
      ? view.artifacts.generatedFiles.slice(0, TASK_DETAILS_GENERATED_FILE_LIMIT)
      : ['No generated files']
  const notes = view.artifacts.notes.length > 0 ? view.artifacts.notes : ['No artifact notes']

  return [
    'Artifacts',
    formatDetailLine('Changes', artifactChanges[0]!),
    ...artifactChanges.slice(1).map((line) => formatIndentedLine(line)),
    formatDetailLine('Generated', generatedFiles[0]!),
    ...generatedFiles.slice(1).map((line) => formatIndentedLine(line)),
    formatDetailLine('Notes', notes[0]!),
    ...notes.slice(1).map((line) => formatIndentedLine(line))
  ]
}

function renderSummary(view: WatchViewModel): string[] {
  const { summary } = view

  return [
    `Run: ${summary.runLabel}    Status: ${summary.overallStatus}    Batch: ${summary.batchProgress}`,
    `Goal: ${summary.goal}`,
    `Tasks: total=${summary.totalTaskCount} completed=${summary.completedTaskCount} failed=${summary.failedTaskCount} blocked=${summary.blockedTaskCount} in_progress=${summary.inProgressTaskCount} ready=${summary.readyTaskCount} pending=${summary.pendingTaskCount}`,
    `Loops: generated=${summary.generatedTaskCount} retry=${summary.retryTaskCount} loop=${summary.loopCount} maxConcurrency=${summary.maxConcurrency}`,
    `Tmux: ${formatNullable(summary.tmuxSessionLabel)}`
  ]
}

function formatPaneTitle(title: string, focused: boolean): string {
  return `${title} (${focused ? 'focused' : 'unfocused'})`
}

function renderHeader(title: string, width: number, focused: boolean): string {
  return pad(formatPaneTitle(title, focused), width)
}

function formatFocusLabel(focusedPane: WatchPane): 'Workers' | 'Tasks' | 'Details' | 'Events' {
  switch (focusedPane) {
    case 'workers':
      return 'Workers'
    case 'tasks':
      return 'Tasks'
    case 'details':
      return 'Details'
    case 'events':
      return 'Events'
  }
}

function renderWorkers(view: WatchViewModel, focusedPane: WatchPane): string[] {
  return [
    renderHeader('Workers', WORKERS_WIDTH, focusedPane === 'workers'),
    ...view.workers.map((worker) => {
      return `${pad(worker.scopeLabel, 12)} ${pad(worker.roleLabel, 12)} ${pad(worker.status, 10)} ${pad(worker.taskId ?? PLACEHOLDER, 8)} ${truncate(worker.taskTitle, 20)}`
    })
  ]
}

function renderHotTasks(view: WatchViewModel, focusedPane: WatchPane): string[] {
  return [
    renderHeader('Hot Tasks', HOT_TASKS_WIDTH, focusedPane === 'tasks'),
    ...view.hotTasks.map((task) => {
      const isSelected = view.selectedTask?.taskId === task.taskId
      const marker = isSelected ? '>' : ' '
      const statusLabel = truncate(`${task.status}/${task.phase}`, 20)
      return `${marker} ${pad(task.taskId, 8)} ${pad(task.taskType, 12)} ${pad(statusLabel, 20)} ${truncate(task.title, 14)}`
    })
  ]
}

function renderTaskDetails(view: WatchViewModel, focusedPane: WatchPane): string[] {
  if (!view.selectedTask) {
    return [renderHeader('Task Details', TASK_DETAILS_WIDTH, focusedPane === 'details'), 'No active task selected']
  }

  const task = view.selectedTask
  return [
    renderHeader('Task Details', TASK_DETAILS_WIDTH, focusedPane === 'details'),
    ...renderTaskOverviewSection(task),
    TASK_DETAILS_SECTION_SPACER,
    ...renderTaskCollaborationSection(task),
    ...(task.failureDetail ? [TASK_DETAILS_SECTION_SPACER, ...renderTaskFailureSection(task)] : []),
    TASK_DETAILS_SECTION_SPACER,
    ...renderTaskArtifactsSection(task)
  ]
}

export function buildTaskDetailLines(view: WatchViewModel, focusedPane: WatchPane = 'tasks'): string[] {
  return renderTaskDetails(view, focusedPane)
}

export function getTaskDetailsViewportHeight(view: WatchViewModel): number {
  return Math.max(renderWorkers(view, 'workers').length, renderHotTasks(view, 'tasks').length)
}

function buildMoreIndicator(hasTopMore: boolean, hasBottomMore: boolean): string {
  if (hasTopMore && hasBottomMore) {
    return '↑ more / ↓ more'
  }

  return hasTopMore ? '↑ more' : '↓ more'
}

export function sliceDetailLines(
  lines: string[],
  viewportHeight: number,
  offset = 0
): { lines: string[]; maxOffset: number; offset: number } {
  if (viewportHeight <= 0 || lines.length === 0) {
    return {
      lines: [],
      maxOffset: 0,
      offset: 0
    }
  }

  if (lines.length <= viewportHeight) {
    return {
      lines,
      maxOffset: 0,
      offset: 0
    }
  }

  const [header, ...body] = lines
  const bodyViewportHeight = Math.max(0, viewportHeight - 1)
  const maxOffset = Math.max(0, body.length - bodyViewportHeight)
  const clampedOffset = clampDetailsScrollOffset(offset, maxOffset)

  if (bodyViewportHeight === 0) {
    return {
      lines: [header],
      maxOffset,
      offset: clampedOffset
    }
  }

  const visibleBody = body.slice(clampedOffset, clampedOffset + bodyViewportHeight)
  const hasTopMore = clampedOffset > 0
  const hasBottomMore = clampedOffset < maxOffset

  if (visibleBody.length > 0) {
    if (visibleBody.length === 1 && (hasTopMore || hasBottomMore)) {
      visibleBody[0] = buildMoreIndicator(hasTopMore, hasBottomMore)
    }
    else {
      if (hasTopMore) {
        visibleBody[0] = buildMoreIndicator(true, false)
      }
      if (hasBottomMore) {
        visibleBody[visibleBody.length - 1] = buildMoreIndicator(false, true)
      }
    }
  }

  return {
    lines: [header, ...visibleBody],
    maxOffset,
    offset: clampedOffset
  }
}

export function getMaxDetailsScrollOffset(view: WatchViewModel): number {
  return sliceDetailLines(buildTaskDetailLines(view), getTaskDetailsViewportHeight(view)).maxOffset
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

function renderRecentEvents(view: WatchViewModel, focusedPane: WatchPane): string[] {
  return [
    formatPaneTitle('Team Activity', focusedPane === 'events'),
    ...view.recentEvents.map((event) => {
      const scopeLabel = event.source === 'mailbox' ? event.workerId ?? PLACEHOLDER : event.batchId ?? PLACEHOLDER
      return `${pad(formatNullable(event.createdAt), 20)} ${pad(event.source, 7)} ${pad(event.type, 18)} ${pad(scopeLabel, 8)} ${pad(event.taskId ?? PLACEHOLDER, 10)} ${truncate(event.detail, RECENT_EVENT_DETAIL_WIDTH)}`
    })
  ]
}

function renderHelpLine(focusedPane: WatchPane, options: RenderWatchScreenOptions): string {
  if (options.commandPalette) {
    return '[Esc] close palette  [↑/k] prev  [↓/j] next  [Enter] run  [Backspace] delete query'
  }

  if (focusedPane === 'details') {
    const base =
      '[Tab] next pane  [1-4] focus  [↑/k] up  [↓/j] down  [Ctrl+u/Ctrl+d] page  [g/G] top/bottom  (details pane)  [q] quit  [r] refresh  [p] pause'
    const actionHints: string[] = []

    if (options.canRetrySelectedTask) {
      actionHints.push('[x] retry task')
    }

    if (options.canAbortRun) {
      actionHints.push('[A] abort run')
    }

    if (actionHints.length === 0) {
      return base
    }

    return `${base}  ${actionHints.join('  ')}`
  }

  const base = '[Tab] next pane  [1-4] focus  [↑/k] prev  [↓/j] next  (tasks pane)  [q] quit  [r] refresh  [p] pause'
  const actionHints: string[] = []

  if (options.canRetrySelectedTask) {
    actionHints.push('[x] retry task')
  }

  if (options.canAbortRun) {
    actionHints.push('[A] abort run')
  }

  if (actionHints.length === 0) {
    return base
  }

  return `${base}  ${actionHints.join('  ')}`
}

function renderCommandPalette(options: NonNullable<RenderWatchScreenOptions['commandPalette']>): string[] {
  const lines = ['Command Palette']
  lines.push(`Query: ${options.query || PLACEHOLDER}`)

  if (options.actions.length === 0) {
    lines.push('No matching commands')
    return lines
  }

  for (const action of options.actions.slice(0, 8)) {
    const marker = action.selected ? '>' : ' '
    const suffix = action.enabled ? '' : ` (${action.reason ?? 'disabled'})`
    lines.push(`${marker} ${action.label}${suffix}`)
  }

  return lines
}

export function renderWatchScreen(view: WatchViewModel, options: RenderWatchScreenOptions = {}): string {
  const focusedPane = options.focusedPane ?? 'tasks'
  const workersLines = renderWorkers(view, focusedPane)
  const hotTaskLines = renderHotTasks(view, focusedPane)
  const detailLines = options.detailsScrollOffset !== undefined || focusedPane === 'details'
    ? sliceDetailLines(
        buildTaskDetailLines(view, focusedPane),
        Math.max(workersLines.length, hotTaskLines.length),
        options.detailsScrollOffset ?? 0
      ).lines
    : buildTaskDetailLines(view, focusedPane)

  const helpLine = renderHelpLine(focusedPane, options)
  const focusLine = `Focus: ${formatFocusLabel(focusedPane)}`

  const lines = [
    ...renderSummary(view),
    '',
    ...renderColumns([
      { lines: workersLines, width: WORKERS_WIDTH },
      { lines: hotTaskLines, width: HOT_TASKS_WIDTH },
      { lines: detailLines, width: TASK_DETAILS_WIDTH }
    ]),
    '',
    ...renderRecentEvents(view, focusedPane),
    '',
    helpLine,
    focusLine
  ]

  if (options.commandPalette) {
    lines.push('')
    lines.push(...renderCommandPalette(options.commandPalette))
  }

  if (options.lastActionMessage && options.lastActionMessage.trim()) {
    lines.push(options.lastActionMessage)
  }

  return lines.join('\n')
}
