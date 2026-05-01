import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { emitKeypressEvents } from 'node:readline'

import type { RunReport } from '../domain/types.js'
import { appendControlCommand } from '../runtime/control-channel.js'
import { readRuntimeEventsSince } from '../runtime/event-stream.js'
import { getMaxDetailsScrollOffset, renderWatchScreen } from './render.js'
import { buildWatchCommands, filterWatchCommands, type WatchCommandAction, type WatchDispatchedCommand } from './commands.js'
import {
  buildWatchViewModel,
  loadWatchViewModel,
  resolveWatchRun,
  type WatchHotTaskViewModel,
  type WatchStateOptions
} from './watch-state.js'

export type WatchTuiOptions = {
  stateRoot: string
  runDirectory?: string
  reportPath?: string
  attachSession?: WatchAttachSession
}

export type WatchPane = 'workers' | 'tasks' | 'details' | 'events'

export type WatchKeyAction =
  | 'quit'
  | 'refresh'
  | 'toggle-pause'
  | 'select-prev'
  | 'select-next'
  | 'details-scroll-up'
  | 'details-scroll-down'
  | 'details-page-up'
  | 'details-page-down'
  | 'details-scroll-top'
  | 'details-scroll-bottom'
  | 'focus-next'
  | 'focus-workers'
  | 'focus-tasks'
  | 'focus-details'
  | 'focus-events'
  | 'retry-selected-task'
  | 'abort-run'
  | 'open-command-palette'
  | 'noop'

export type WatchDetailMode = 'combined' | 'overview' | 'collaboration'

export type WatchRenderReason =
  | 'initial'
  | 'timer'
  | 'event-stream'
  | 'refresh'
  | 'selection-change'
  | 'details-scroll'
  | 'pause-toggle'
  | 'pane-focus-change'
  | 'session-state-change'

export type WatchRenderCache = {
  lastFrame: string | null
  lastSessionStatus: 'idle' | 'running' | 'completed' | 'failed' | null
}

export type WatchAttachSession = {
  getStatus(): 'idle' | 'running' | 'completed' | 'failed'
}

export type WatchUiState = {
  paused: boolean
  selectedTaskId?: string
  hotTaskIds: string[]
  detailMode: WatchDetailMode
  focusedPane: WatchPane
  detailsScrollOffset: number
  lastActionMessage: string | null
  canRetrySelectedTask: boolean
  canAbortRun: boolean
  palette: {
    open: boolean
    query: string
    highlightedIndex: number
  }
}

type WatchSelectionDirection = 'prev' | 'next'

const WATCH_PANES: WatchPane[] = ['workers', 'tasks', 'details', 'events']
const DETAILS_PAGE_SCROLL_STEP = 5

const HOT_TASK_RESOLVED_RUN = {
  runDirectory: null,
  reportPath: 'watch-report.json'
} as const

function toHotTaskIds(hotTasks: WatchHotTaskViewModel[]): string[] {
  return hotTasks.map((task) => task.taskId)
}

export function syncSelectedTaskIdWithHotTasks(hotTaskIds: string[], selectedTaskId?: string): string | undefined {
  if (selectedTaskId && hotTaskIds.includes(selectedTaskId)) {
    return selectedTaskId
  }

  return hotTaskIds[0]
}

export function moveSelectedTaskIdWithHotTasks(
  hotTaskIds: string[],
  selectedTaskId: string | undefined,
  direction: WatchSelectionDirection
): string | undefined {
  const syncedSelectedTaskId = syncSelectedTaskIdWithHotTasks(hotTaskIds, selectedTaskId)
  if (!syncedSelectedTaskId) {
    return undefined
  }

  const currentIndex = hotTaskIds.indexOf(syncedSelectedTaskId)
  const nextIndex = direction === 'next'
    ? Math.min(currentIndex + 1, hotTaskIds.length - 1)
    : Math.max(currentIndex - 1, 0)

  return hotTaskIds[nextIndex]
}

function getHotTaskIds(report: RunReport): string[] {
  return toHotTaskIds(buildWatchViewModel(report, HOT_TASK_RESOLVED_RUN, { stateRoot: '' }).hotTasks)
}

export function createInitialWatchUiState(): WatchUiState {
  return {
    paused: false,
    selectedTaskId: undefined,
    hotTaskIds: [],
    detailMode: 'combined',
    focusedPane: 'tasks',
    detailsScrollOffset: 0,
    lastActionMessage: null,
    canRetrySelectedTask: false,
    canAbortRun: false,
    palette: {
      open: false,
      query: '',
      highlightedIndex: 0
    }
  }
}

export function clampDetailsScrollOffset(offset: number, maxOffset: number): number {
  if (!Number.isFinite(offset)) {
    return 0
  }

  const normalizedOffset = Math.trunc(offset)
  return Math.max(0, Math.min(normalizedOffset, Math.max(0, maxOffset)))
}

export function syncDetailsScrollOffset(
  currentOffset: number,
  previousSelectedTaskId: string | undefined,
  nextSelectedTaskId: string | undefined,
  maxOffset: number
): number {
  if (previousSelectedTaskId !== nextSelectedTaskId) {
    return 0
  }

  return clampDetailsScrollOffset(currentOffset, maxOffset)
}

function moveDetailsScrollOffset(
  currentOffset: number,
  action: Extract<WatchKeyAction, 'details-scroll-up' | 'details-scroll-down' | 'details-page-up' | 'details-page-down' | 'details-scroll-top' | 'details-scroll-bottom'>,
  maxOffset: number
): number {
  switch (action) {
    case 'details-scroll-up':
      return clampDetailsScrollOffset(currentOffset - 1, maxOffset)
    case 'details-scroll-down':
      return clampDetailsScrollOffset(currentOffset + 1, maxOffset)
    case 'details-page-up':
      return clampDetailsScrollOffset(currentOffset - DETAILS_PAGE_SCROLL_STEP, maxOffset)
    case 'details-page-down':
      return clampDetailsScrollOffset(currentOffset + DETAILS_PAGE_SCROLL_STEP, maxOffset)
    case 'details-scroll-top':
      return 0
    case 'details-scroll-bottom':
      return maxOffset
  }
}

function formatFocusedPaneLabel(focusedPane: WatchPane): 'Workers' | 'Tasks' | 'Details' | 'Events' {
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

export function moveFocusedPane(focusedPane: WatchPane): WatchPane {
  const currentIndex = WATCH_PANES.indexOf(focusedPane)
  return WATCH_PANES[(currentIndex + 1) % WATCH_PANES.length]!
}

function resolveFocusedPaneFromAction(action: WatchKeyAction, currentPane: WatchPane): WatchPane {
  switch (action) {
    case 'focus-next':
      return moveFocusedPane(currentPane)
    case 'focus-workers':
      return 'workers'
    case 'focus-tasks':
      return 'tasks'
    case 'focus-details':
      return 'details'
    case 'focus-events':
      return 'events'
    default:
      return currentPane
  }
}

export function syncSelectedTaskId(report: RunReport, selectedTaskId?: string): string | undefined {
  return syncSelectedTaskIdWithHotTasks(getHotTaskIds(report), selectedTaskId)
}

export function moveSelectedTaskId(
  report: RunReport,
  selectedTaskId: string | undefined,
  direction: WatchSelectionDirection
): string | undefined {
  return moveSelectedTaskIdWithHotTasks(getHotTaskIds(report), selectedTaskId, direction)
}

export function resolveWatchKeyAction(
  input: string,
  key?: { ctrl?: boolean; name?: string },
  focusedPane: WatchPane = 'tasks'
): WatchKeyAction {
  if (key?.ctrl && key.name === 'c') {
    return 'quit'
  }

  if (key?.name === 'q' || input === 'q') {
    return 'quit'
  }

  if (key?.name === 'r' || input === 'r') {
    return 'refresh'
  }

  if (key?.name === 'p' || input === 'p') {
    return 'toggle-pause'
  }

  if (key?.name === 'tab' || input === '\t') {
    return 'focus-next'
  }

  if (input === '1') {
    return 'focus-workers'
  }

  if (input === '2') {
    return 'focus-tasks'
  }

  if (input === '3') {
    return 'focus-details'
  }

  if (input === '4') {
    return 'focus-events'
  }

  if (key?.name === 'up' || input === 'k') {
    if (focusedPane === 'tasks') {
      return 'select-prev'
    }

    if (focusedPane === 'details') {
      return 'details-scroll-up'
    }

    return 'noop'
  }

  if (key?.name === 'down' || input === 'j') {
    if (focusedPane === 'tasks') {
      return 'select-next'
    }

    if (focusedPane === 'details') {
      return 'details-scroll-down'
    }

    return 'noop'
  }

  if (focusedPane === 'details' && key?.ctrl && key.name === 'u') {
    return 'details-page-up'
  }

  if (focusedPane === 'details' && key?.ctrl && key.name === 'd') {
    return 'details-page-down'
  }

  if (focusedPane === 'details' && input === 'g') {
    return 'details-scroll-top'
  }

  if (focusedPane === 'details' && input === 'G') {
    return 'details-scroll-bottom'
  }

  if (input === 'x') {
    return 'retry-selected-task'
  }

  if (input === 'A') {
    return 'abort-run'
  }

  if (input === '/') {
    return 'open-command-palette'
  }

  return 'noop'
}

function buildPaletteActions(options: WatchTuiOptions, uiState: WatchUiState) {
  const viewModel = loadWatchViewModel({
    ...options,
    selectedTaskId: uiState.selectedTaskId
  })
  const sessionStatus = options.attachSession?.getStatus() ?? null
  const runStatus =
    sessionStatus === 'running'
      ? 'RUNNING'
      : sessionStatus === 'completed'
        ? 'COMPLETED'
        : sessionStatus === 'failed'
          ? 'FAILED'
          : viewModel.summary.overallStatus
  const actions = buildWatchCommands({
    focusedPane: uiState.focusedPane,
    runDirectory: options.runDirectory ?? null,
    runStatus,
    selectedTask: viewModel.selectedTask
      ? { taskId: viewModel.selectedTask.taskId, status: viewModel.selectedTask.status }
      : null
  })
  const filteredActions = filterWatchCommands(actions, uiState.palette.query)
  const highlightedIndex = Math.max(0, Math.min(uiState.palette.highlightedIndex, Math.max(filteredActions.length - 1, 0)))
  return {
    viewModel,
    actions: filteredActions,
    highlightedIndex
  }
}

function buildPaletteRenderState(options: WatchTuiOptions, uiState: WatchUiState): RenderPaletteState | undefined {
  if (!uiState.palette.open) {
    return undefined
  }

  const { actions, highlightedIndex } = buildPaletteActions(options, uiState)
  return {
    query: uiState.palette.query,
    actions: actions.map((action, index) => ({
      label: action.label,
      enabled: action.enabled,
      selected: index === highlightedIndex,
      reason: action.reason
    }))
  }
}

type RenderPaletteState = {
  query: string
  actions: Array<{ label: string; enabled: boolean; selected: boolean; reason?: string }>
}

async function dispatchPaletteCommand(
  command: WatchDispatchedCommand,
  options: WatchTuiOptions,
  lockedOptions: WatchTuiOptions,
  uiState: WatchUiState
): Promise<WatchUiState> {
  if (command.kind === 'refresh') {
    return {
      ...uiState,
      lastActionMessage: null,
      palette: {
        open: false,
        query: '',
        highlightedIndex: 0
      }
    }
  }

  if (command.kind === 'focus-pane') {
    return {
      ...uiState,
      focusedPane: command.pane,
      lastActionMessage: null,
      palette: {
        open: false,
        query: '',
        highlightedIndex: 0
      }
    }
  }

  return dispatchRuntimeControlCommand(command.command, options, lockedOptions, uiState)
}

async function dispatchRuntimeControlCommand(
  command: Parameters<typeof appendControlCommand>[1],
  options: WatchTuiOptions,
  lockedOptions: WatchTuiOptions,
  uiState: WatchUiState
): Promise<WatchUiState> {
  if (command.type === 'retry-task') {
    return handleControlAction('retry-selected-task', options, lockedOptions, uiState)
  }

  if (command.type === 'abort-run') {
    return handleControlAction('abort-run', options, lockedOptions, uiState)
  }

  if (command.type === 'reroute-task') {
    if (!lockedOptions.runDirectory) {
      return {
        ...uiState,
        lastActionMessage: '当前会话未绑定运行目录，无法 reroute 任务'
      }
    }

    try {
      const viewModel = loadWatchViewModel({
        ...lockedOptions,
        selectedTaskId: uiState.selectedTaskId
      })

      if (!viewModel.selectedTask || viewModel.selectedTask.status !== 'failed') {
        return {
          ...uiState,
          lastActionMessage: '仅支持 reroute 状态为 failed 的任务'
        }
      }

      await appendControlCommand(lockedOptions.runDirectory, {
        ...command,
        id: randomUUID(),
        taskId: viewModel.selectedTask.taskId,
        createdAt: new Date().toISOString()
      })

      return {
        ...uiState,
        lastActionMessage: `queued reroute for ${viewModel.selectedTask.taskId} -> ${command.targetRole}`,
        palette: {
          open: false,
          query: '',
          highlightedIndex: 0
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ...uiState,
        lastActionMessage: `reroute 命令写入失败: ${message}`
      }
    }
  }

  return uiState
}

export function enterWatchViewport(): string {
  return '\x1B[?1049h\x1B[?25l'
}

export function exitWatchViewport(): string {
  return '\x1B[?25h\x1B[?1049l'
}

export function buildWatchFrame(screen: string): string {
  return `\x1B[H\x1B[J${screen}`
}

export function composeWatchFrame(screen: string, footer: string): string {
  return `${buildWatchFrame(screen)}\n${footer}\n`
}

export function createWatchRenderCache(): WatchRenderCache {
  return {
    lastFrame: null,
    lastSessionStatus: null
  }
}

function shouldForceWatchRender(reason: WatchRenderReason): boolean {
  return reason === 'initial'
    || reason === 'refresh'
    || reason === 'selection-change'
    || reason === 'details-scroll'
    || reason === 'pause-toggle'
    || reason === 'pane-focus-change'
    || reason === 'session-state-change'
}

export function shouldWriteWatchFrame(cache: WatchRenderCache, nextFrame: string, reason: WatchRenderReason): boolean {
  return shouldForceWatchRender(reason) || cache.lastFrame !== nextFrame
}

function renderOnce(
  options: WatchTuiOptions,
  uiState: WatchUiState,
  cache: WatchRenderCache,
  reason: WatchRenderReason
): WatchUiState {
  const baseViewModel = loadWatchViewModel({
    ...options,
    selectedTaskId: uiState.selectedTaskId
  })
  const hotTaskIds = toHotTaskIds(baseViewModel.hotTasks)
  const selectedTaskId = syncSelectedTaskIdWithHotTasks(hotTaskIds, uiState.selectedTaskId)
  const viewModel = selectedTaskId === baseViewModel.selectedTask?.taskId
    ? baseViewModel
    : loadWatchViewModel({
        ...options,
        selectedTaskId
      })
  const detailsScrollOffset = syncDetailsScrollOffset(
    uiState.detailsScrollOffset,
    uiState.selectedTaskId,
    selectedTaskId,
    getMaxDetailsScrollOffset(viewModel)
  )
  const sessionStatus = options.attachSession?.getStatus() ?? null
  const sessionStatusChanged = cache.lastSessionStatus !== null && sessionStatus !== cache.lastSessionStatus
  const canRetrySelectedTask = Boolean(
    baseViewModel.selectedTask && baseViewModel.selectedTask.status === 'failed' && baseViewModel.resolvedRun.runDirectory
  )
  const isRunRunning =
    (sessionStatus === 'running')
    || (!sessionStatus && baseViewModel.summary.overallStatus === 'RUNNING')
  const canAbortRun = Boolean(baseViewModel.resolvedRun.runDirectory && isRunRunning)
  const footer = sessionStatus === 'completed'
    ? '[run completed] [q] quit  [r] refresh'
    : sessionStatus === 'failed'
      ? '[run failed] [q] quit  [r] refresh'
      : options.attachSession
        ? '[run attached] [q] close tui  [r] refresh'
        : uiState.paused
        ? '[watch paused]'
        : '[watch auto-refresh enabled]'
  const nextFrame = composeWatchFrame(
    renderWatchScreen(viewModel, {
      focusedPane: uiState.focusedPane,
      detailsScrollOffset,
      canRetrySelectedTask,
      canAbortRun,
      lastActionMessage: uiState.lastActionMessage ?? undefined,
      commandPalette: buildPaletteRenderState(options, uiState)
    }),
    footer
  )
  const effectiveReason = sessionStatusChanged ? 'session-state-change' : reason

  if (shouldWriteWatchFrame(cache, nextFrame, effectiveReason)) {
    process.stdout.write(nextFrame)
    cache.lastFrame = nextFrame
  }
  cache.lastSessionStatus = sessionStatus

  return {
    ...uiState,
    selectedTaskId,
    hotTaskIds,
    detailsScrollOffset,
    canRetrySelectedTask,
    canAbortRun
  }
}

async function handleControlAction(
  action: WatchKeyAction,
  options: WatchTuiOptions,
  lockedOptions: WatchTuiOptions,
  uiState: WatchUiState
): Promise<WatchUiState> {
  if (action === 'retry-selected-task') {
    if (!lockedOptions.runDirectory) {
      return {
        ...uiState,
        lastActionMessage: '当前会话未绑定运行目录，无法重试任务'
      }
    }

    try {
      const viewModel = loadWatchViewModel({
        ...lockedOptions,
        selectedTaskId: uiState.selectedTaskId
      })

      if (!viewModel.selectedTask || viewModel.selectedTask.status !== 'failed') {
        return {
          ...uiState,
          lastActionMessage: '仅支持重试状态为 failed 的任务'
        }
      }

      await appendControlCommand(lockedOptions.runDirectory, {
        id: randomUUID(),
        type: 'retry-task',
        taskId: viewModel.selectedTask.taskId,
        createdAt: new Date().toISOString()
      })

      return {
        ...uiState,
        lastActionMessage: `queued retry for ${viewModel.selectedTask.taskId}`
      }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ...uiState,
        lastActionMessage: `重试任务命令写入失败: ${message}`
      }
    }
  }

  if (action === 'abort-run') {
    if (!lockedOptions.runDirectory) {
      return {
        ...uiState,
        lastActionMessage: '当前会话未绑定运行目录，无法中止运行'
      }
    }

    const sessionStatus = options.attachSession?.getStatus() ?? null
    if (sessionStatus && sessionStatus !== 'running') {
      return {
        ...uiState,
        lastActionMessage: '运行已结束，忽略 abort 请求'
      }
    }

    try {
      const viewModel = loadWatchViewModel({
        ...lockedOptions,
        selectedTaskId: uiState.selectedTaskId
      })

      const isRunning =
        (sessionStatus === 'running')
        || (!sessionStatus && viewModel.summary.overallStatus === 'RUNNING')

      if (!isRunning) {
        return {
          ...uiState,
          lastActionMessage: '运行已进入终态，忽略 abort 请求'
        }
      }

      await appendControlCommand(lockedOptions.runDirectory, {
        id: randomUUID(),
        type: 'abort-run',
        createdAt: new Date().toISOString()
      })

      return {
        ...uiState,
        lastActionMessage: 'abort requested'
      }
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        ...uiState,
        lastActionMessage: `中止运行命令写入失败: ${message}`
      }
    }
  }

  return uiState
}

export async function handleWatchControlActionForTest(
  action: WatchKeyAction,
  options: WatchTuiOptions,
  uiState: WatchUiState
): Promise<WatchUiState> {
  const lockedOptions = lockWatchTarget(options)
  return handleControlAction(action, options, lockedOptions, uiState)
}

export async function executePaletteCommandForTest(
  action: WatchCommandAction,
  options: WatchTuiOptions,
  uiState: WatchUiState
): Promise<WatchUiState> {
  const lockedOptions = lockWatchTarget(options)
  if (!action.dispatch) {
    return uiState
  }
  return dispatchPaletteCommand(action.dispatch, options, lockedOptions, uiState)
}

export function lockWatchTarget(options: WatchTuiOptions): WatchStateOptions {
  const resolvedRun = resolveWatchRun(options)
  return {
    ...options,
    runDirectory: resolvedRun.runDirectory ?? undefined,
    reportPath: resolvedRun.reportPath
  }
}

export async function runWatchTui(options: WatchTuiOptions): Promise<void> {
  const capturePath = process.env.BATA_WORKFLOW_WATCH_CAPTURE_PATH

  if (capturePath) {
    writeFileSync(
      capturePath,
      JSON.stringify({
        stateRoot: options.stateRoot,
        runDirectory: options.runDirectory ?? null,
        reportPath: options.reportPath ?? null
      }),
      'utf8'
    )
    return
  }

  const lockedOptions = lockWatchTarget(options)

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stdout.write(`${renderWatchScreen(loadWatchViewModel(lockedOptions))}\n`)
    return
  }

  let uiState: WatchUiState = createInitialWatchUiState()
  const renderCache = createWatchRenderCache()

  await new Promise<void>((resolve, reject) => {
    let eventCursor = 0
    let pollingEvents = false
    const refresh = (reason: WatchRenderReason) => {
      try {
        uiState = renderOnce(lockedOptions, uiState, renderCache, reason)
      }
      catch (error) {
        cleanup()
        reject(error)
      }
    }

    const cleanup = () => {
      clearInterval(timer)
      process.stdin.off('keypress', onKeypress)
      if (typeof process.stdin.setRawMode === 'function') {
        process.stdin.setRawMode(false)
      }
      process.stdin.pause()
      process.stdout.write(exitWatchViewport())
    }

    const onKeypress = async (input: string, key?: { ctrl?: boolean; name?: string }) => {
      if (uiState.palette.open) {
        if (key?.name === 'escape') {
          uiState = {
            ...uiState,
            palette: {
              open: false,
              query: '',
              highlightedIndex: 0
            },
            lastActionMessage: null
          }
          refresh('refresh')
          return
        }

        if (key?.name === 'backspace') {
          uiState = {
            ...uiState,
            palette: {
              ...uiState.palette,
              query: uiState.palette.query.slice(0, -1),
              highlightedIndex: 0
            }
          }
          refresh('refresh')
          return
        }

        if (key?.name === 'return' || key?.name === 'enter') {
          const { actions, highlightedIndex } = buildPaletteActions(lockedOptions, uiState)
          const selectedAction = actions[highlightedIndex]
          if (selectedAction?.enabled && selectedAction.dispatch) {
            uiState = await dispatchPaletteCommand(selectedAction.dispatch, options, lockedOptions, uiState)
          }
          else {
            uiState = {
              ...uiState,
              lastActionMessage: selectedAction?.reason ?? '没有可执行的命令'
            }
          }
          refresh('refresh')
          return
        }

        if (key?.name === 'up' || input === 'k') {
          uiState = {
            ...uiState,
            palette: {
              ...uiState.palette,
              highlightedIndex: Math.max(0, uiState.palette.highlightedIndex - 1)
            }
          }
          refresh('refresh')
          return
        }

        if (key?.name === 'down' || input === 'j') {
          const { actions } = buildPaletteActions(lockedOptions, uiState)
          uiState = {
            ...uiState,
            palette: {
              ...uiState.palette,
              highlightedIndex: Math.min(actions.length - 1, uiState.palette.highlightedIndex + 1)
            }
          }
          refresh('refresh')
          return
        }

        if (input && input.length === 1 && !key?.ctrl) {
          uiState = {
            ...uiState,
            palette: {
              ...uiState.palette,
              query: `${uiState.palette.query}${input}`,
              highlightedIndex: 0
            }
          }
          refresh('refresh')
        }
        return
      }

      const action = resolveWatchKeyAction(input, key, uiState.focusedPane)
      if (action === 'quit') {
        cleanup()
        resolve()
        return
      }

      if (action === 'toggle-pause') {
        uiState = {
          ...uiState,
          paused: !uiState.paused,
          lastActionMessage: null
        }
        refresh('pause-toggle')
        return
      }

      if (action === 'select-prev' || action === 'select-next') {
        const nextSelectedTaskId = moveSelectedTaskIdWithHotTasks(
          uiState.hotTaskIds,
          uiState.selectedTaskId,
          action === 'select-next' ? 'next' : 'prev'
        )
        uiState = {
          ...uiState,
          selectedTaskId: nextSelectedTaskId,
          lastActionMessage: null,
          detailsScrollOffset: syncDetailsScrollOffset(
            uiState.detailsScrollOffset,
            uiState.selectedTaskId,
            nextSelectedTaskId,
            Number.MAX_SAFE_INTEGER
          )
        }
        refresh('selection-change')
        return
      }

      if (
        action === 'details-scroll-up'
        || action === 'details-scroll-down'
        || action === 'details-page-up'
        || action === 'details-page-down'
        || action === 'details-scroll-top'
        || action === 'details-scroll-bottom'
      ) {
        const scrollViewModel = loadWatchViewModel({
          ...lockedOptions,
          selectedTaskId: uiState.selectedTaskId
        })
        const nextDetailsScrollOffset = moveDetailsScrollOffset(
          uiState.detailsScrollOffset,
          action,
          getMaxDetailsScrollOffset(scrollViewModel)
        )

        if (nextDetailsScrollOffset !== uiState.detailsScrollOffset) {
          uiState = {
            ...uiState,
            detailsScrollOffset: nextDetailsScrollOffset,
            lastActionMessage: null
          }
          refresh('details-scroll')
        }
        return
      }

      if (
        action === 'focus-next'
        || action === 'focus-workers'
        || action === 'focus-tasks'
        || action === 'focus-details'
        || action === 'focus-events'
      ) {
        const nextFocusedPane = resolveFocusedPaneFromAction(action, uiState.focusedPane)
        if (nextFocusedPane !== uiState.focusedPane) {
          uiState = {
            ...uiState,
            focusedPane: nextFocusedPane,
            lastActionMessage: null
          }
          refresh('pane-focus-change')
        }
        return
      }

      if (action === 'retry-selected-task' || action === 'abort-run') {
        uiState = await handleControlAction(action, options, lockedOptions, uiState)
        refresh('refresh')
        return
      }

      if (action === 'open-command-palette') {
        uiState = {
          ...uiState,
          palette: {
            open: true,
            query: '',
            highlightedIndex: 0
          },
          lastActionMessage: null
        }
        refresh('refresh')
        return
      }

      if (action === 'refresh') {
        uiState = {
          ...uiState,
          lastActionMessage: null
        }
        refresh('refresh')
      }
    }

    const pollEvents = async () => {
      if (uiState.paused || pollingEvents) {
        return
      }

      if (!lockedOptions.runDirectory) {
        refresh('timer')
        return
      }

      pollingEvents = true
      try {
        const result = await readRuntimeEventsSince(lockedOptions.runDirectory, eventCursor)
        eventCursor = result.nextCursor
        if (result.events.length > 0) {
          refresh('event-stream')
        }
      } finally {
        pollingEvents = false
      }
    }

    const timer = setInterval(() => {
      void pollEvents()
    }, 250)

    emitKeypressEvents(process.stdin)
    process.stdout.write(enterWatchViewport())
    if (typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(true)
    }
    process.stdin.on('keypress', onKeypress)
    process.stdin.resume()
    refresh('initial')
    if (lockedOptions.runDirectory) {
      void readRuntimeEventsSince(lockedOptions.runDirectory, 0).then((result) => {
        eventCursor = result.nextCursor
      }).catch(() => {
        eventCursor = 0
      })
    }
  })
}
