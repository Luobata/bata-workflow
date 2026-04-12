import { writeFileSync } from 'node:fs'
import process from 'node:process'
import { emitKeypressEvents } from 'node:readline'

import type { RunReport } from '../domain/types.js'
import { renderWatchScreen } from './render.js'
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
}

export type WatchKeyAction = 'quit' | 'refresh' | 'toggle-pause' | 'select-prev' | 'select-next' | 'noop'

export type WatchDetailMode = 'combined' | 'overview' | 'collaboration'

export type WatchUiState = {
  paused: boolean
  selectedTaskId?: string
  hotTaskIds: string[]
  detailMode: WatchDetailMode
}

type WatchSelectionDirection = 'prev' | 'next'

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
    detailMode: 'combined'
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

export function resolveWatchKeyAction(input: string, key?: { ctrl?: boolean; name?: string }): WatchKeyAction {
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

  if (key?.name === 'up' || input === 'k') {
    return 'select-prev'
  }

  if (key?.name === 'down' || input === 'j') {
    return 'select-next'
  }

  return 'noop'
}

function clearScreen(): void {
  process.stdout.write('\x1bc')
}

function renderOnce(options: WatchTuiOptions, uiState: WatchUiState): WatchUiState {
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

  clearScreen()
  process.stdout.write(`${renderWatchScreen(viewModel)}\n`)
  process.stdout.write(uiState.paused ? '[watch paused]\n' : '[watch auto-refresh enabled]\n')

  return {
    ...uiState,
    selectedTaskId,
    hotTaskIds
  }
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
  const capturePath = process.env.HARNESS_WATCH_CAPTURE_PATH

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

  await new Promise<void>((resolve, reject) => {
    const refresh = () => {
      try {
        uiState = renderOnce(lockedOptions, uiState)
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
      process.stdout.write('\n')
    }

    const onKeypress = (input: string, key?: { ctrl?: boolean; name?: string }) => {
      const action = resolveWatchKeyAction(input, key)
      if (action === 'quit') {
        cleanup()
        resolve()
        return
      }

      if (action === 'toggle-pause') {
        uiState = {
          ...uiState,
          paused: !uiState.paused
        }
        refresh()
        return
      }

      if (action === 'select-prev' || action === 'select-next') {
        uiState = {
          ...uiState,
          selectedTaskId: moveSelectedTaskIdWithHotTasks(
            uiState.hotTaskIds,
            uiState.selectedTaskId,
            action === 'select-next' ? 'next' : 'prev'
          )
        }
        refresh()
        return
      }

      if (action === 'refresh') {
        refresh()
      }
    }

    const timer = setInterval(() => {
      if (!uiState.paused) {
        refresh()
      }
    }, 1000)

    emitKeypressEvents(process.stdin)
    if (typeof process.stdin.setRawMode === 'function') {
      process.stdin.setRawMode(true)
    }
    process.stdin.on('keypress', onKeypress)
    process.stdin.resume()
    refresh()
  })
}
