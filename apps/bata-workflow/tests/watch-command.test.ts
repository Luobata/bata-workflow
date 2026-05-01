import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { RunReport } from '../src/domain/types.js'
import { persistRunReport } from '../src/runtime/state-store.js'
import { buildWatchCommands, filterWatchCommands } from '../src/tui/commands.js'
import { renderWatchScreen } from '../src/tui/render.js'
import { loadWatchViewModel } from '../src/tui/watch-state.js'
import * as watchModule from '../src/tui/watch.js'
import {
  buildWatchFrame,
  composeWatchFrame,
  createWatchRenderCache,
  createInitialWatchUiState,
  enterWatchViewport,
  exitWatchViewport,
  lockWatchTarget,
  moveFocusedPane,
  moveSelectedTaskId,
    resolveWatchKeyAction,
    shouldWriteWatchFrame,
    syncSelectedTaskId,
    handleWatchControlActionForTest,
    executePaletteCommandForTest
} from '../src/tui/watch.js'

const appRoot = resolve(import.meta.dirname, '..')
const repoRoot = resolve(appRoot, '..', '..')
const cliPath = resolve(appRoot, 'src/cli/index.ts')
const tsxCliPath = resolve(appRoot, 'node_modules/tsx/dist/cli.mjs')
const stateRoot = resolve(repoRoot, '.bata-workflow', 'state')

type WatchCapture = {
  stateRoot: string
  runDirectory: string | null
  reportPath: string | null
}

function createMinimalReport(goal: string): RunReport {
  return {
    goal,
    plan: {
      goal,
      summary: `${goal} summary`,
      tasks: []
    },
    assignments: [],
    batches: [],
    runtime: {
      maxConcurrency: 1,
      workers: [],
      batches: [],
      completedTaskIds: [],
      pendingTaskIds: [],
      readyTaskIds: [],
      inProgressTaskIds: [],
      failedTaskIds: [],
      dynamicTaskStats: {
        generatedTaskCount: 0,
        generatedTaskIds: [],
        generatedTaskCountBySourceTaskId: {}
      },
      loopSummaries: [],
      events: [],
      mailbox: [],
      taskStates: []
    },
    results: [],
    summary: {
      generatedTaskCount: 0,
      loopCount: 0,
      loopedSourceTaskIds: [],
      failedTaskCount: 0,
      completedTaskCount: 0,
      retryTaskCount: 0
    }
  }
}

function createTaskReport(goal: string): RunReport {
  return {
    goal,
    plan: {
      goal,
      summary: `${goal} summary`,
      tasks: [
        {
          id: 'task-1',
          title: 'First hot task',
          description: 'first task',
          role: 'implementer',
          taskType: 'coding',
          dependsOn: [],
          acceptanceCriteria: [],
          skills: [],
          status: 'ready',
          maxAttempts: 2
        },
        {
          id: 'task-2',
          title: 'Second hot task',
          description: 'second task',
          role: 'reviewer',
          taskType: 'code-review',
          dependsOn: [],
          acceptanceCriteria: [],
          skills: [],
          status: 'in_progress',
          maxAttempts: 2
        },
        {
          id: 'task-3',
          title: 'Third hot task',
          description: 'third task',
          role: 'tester',
          taskType: 'testing',
          dependsOn: [],
          acceptanceCriteria: [],
          skills: [],
          status: 'failed',
          maxAttempts: 2
        },
        {
          id: 'task-4',
          title: 'Pending task',
          description: 'pending task',
          role: 'planner',
          taskType: 'planning',
          dependsOn: [],
          acceptanceCriteria: [],
          skills: [],
          status: 'pending',
          maxAttempts: 2
        }
      ]
    },
    assignments: [],
    batches: [],
    runtime: {
      maxConcurrency: 1,
      workers: [],
      batches: [],
      completedTaskIds: [],
      pendingTaskIds: ['task-4'],
      readyTaskIds: ['task-1'],
      inProgressTaskIds: ['task-2'],
      failedTaskIds: ['task-3'],
      dynamicTaskStats: {
        generatedTaskCount: 0,
        generatedTaskIds: [],
        generatedTaskCountBySourceTaskId: {}
      },
      loopSummaries: [],
      events: [],
      mailbox: [],
      taskStates: [
        {
          taskId: 'task-1',
          status: 'ready',
          claimedBy: null,
          attempts: 0,
          maxAttempts: 2,
          lastError: null,
          attemptHistory: [],
          workerHistory: [],
          failureTimestamps: [],
          lastClaimedAt: null,
          releasedAt: null,
          nextAttemptAt: null,
          lastUpdatedAt: '2026-04-12T10:00:00.000Z'
        },
        {
          taskId: 'task-2',
          status: 'in_progress',
          claimedBy: 'W1',
          attempts: 1,
          maxAttempts: 2,
          lastError: null,
          attemptHistory: [],
          workerHistory: ['W1'],
          failureTimestamps: [],
          lastClaimedAt: '2026-04-12T10:02:00.000Z',
          releasedAt: null,
          nextAttemptAt: null,
          lastUpdatedAt: '2026-04-12T10:03:00.000Z'
        },
        {
          taskId: 'task-3',
          status: 'failed',
          claimedBy: null,
          attempts: 2,
          maxAttempts: 2,
          lastError: 'boom',
          attemptHistory: [],
          workerHistory: ['W1'],
          failureTimestamps: ['2026-04-12T10:04:00.000Z'],
          lastClaimedAt: '2026-04-12T10:04:00.000Z',
          releasedAt: '2026-04-12T10:04:30.000Z',
          nextAttemptAt: null,
          lastUpdatedAt: '2026-04-12T10:05:00.000Z'
        },
        {
          taskId: 'task-4',
          status: 'pending',
          claimedBy: null,
          attempts: 0,
          maxAttempts: 2,
          lastError: null,
          attemptHistory: [],
          workerHistory: [],
          failureTimestamps: [],
          lastClaimedAt: null,
          releasedAt: null,
          nextAttemptAt: null,
          lastUpdatedAt: '2026-04-12T09:59:00.000Z'
        }
      ]
    },
    results: [],
    summary: {
      generatedTaskCount: 0,
      loopCount: 0,
      loopedSourceTaskIds: [],
      failedTaskCount: 1,
      completedTaskCount: 0,
      retryTaskCount: 0
    }
  }
}

describe('watch command', () => {
  it('watch 视口控制序列使用备用屏且避免整终端 reset', () => {
    expect(enterWatchViewport()).toContain('\u001B[?1049h')
    expect(enterWatchViewport()).toContain('\u001B[?25l')
    expect(exitWatchViewport()).toContain('\u001B[?25h')
    expect(exitWatchViewport()).toContain('\u001B[?1049l')
    expect(buildWatchFrame('frame body')).toContain('\u001B[H\u001B[J')
    expect(buildWatchFrame('frame body')).not.toContain('\u001Bc')
  })

  it('timer 刷新时若 frame 未变化，则跳过 stdout 写入', () => {
    const cache = createWatchRenderCache()
    const frame = composeWatchFrame('screen', '[watch auto-refresh enabled]')

    expect(shouldWriteWatchFrame(cache, frame, 'timer')).toBe(true)
    cache.lastFrame = frame
    expect(shouldWriteWatchFrame(cache, frame, 'timer')).toBe(false)
  })

  it('手动 refresh 与选择变化即使 frame 未变化也会强制重绘', () => {
    const cache = createWatchRenderCache()
    const frame = composeWatchFrame('screen', '[watch auto-refresh enabled]')
    cache.lastFrame = frame

    expect(shouldWriteWatchFrame(cache, frame, 'refresh')).toBe(true)
    expect(shouldWriteWatchFrame(cache, frame, 'selection-change')).toBe(true)
    expect(shouldWriteWatchFrame(cache, frame, 'details-scroll')).toBe(true)
  })

  it('pane focus 切换即使 frame 未变化也会强制重绘', () => {
    const cache = createWatchRenderCache()
    const frame = composeWatchFrame('screen', '[watch auto-refresh enabled]')
    cache.lastFrame = frame

    expect(shouldWriteWatchFrame(cache, frame, 'pane-focus-change')).toBe(true)
  })

  it('attach session 状态变化即使 frame 未变化也会强制重绘', () => {
    const cache = createWatchRenderCache()
    const frame = composeWatchFrame('screen', '[run completed] [q] quit  [r] refresh')

    cache.lastFrame = frame
    expect(shouldWriteWatchFrame(cache, frame, 'session-state-change')).toBe(true)
  })

  it('pause toggle 会因为 footer 变化而强制重绘', () => {
    const cache = createWatchRenderCache()
    const activeFrame = composeWatchFrame('screen', '[watch auto-refresh enabled]')
    const pausedFrame = composeWatchFrame('screen', '[watch paused]')

    cache.lastFrame = activeFrame
    expect(shouldWriteWatchFrame(cache, pausedFrame, 'pause-toggle')).toBe(true)
  })

  it('初始 UI 状态默认使用 combined detailMode', () => {
    expect(createInitialWatchUiState()).toEqual({
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
    })
  })

  it('支持循环切换 focusedPane', () => {
    expect(moveFocusedPane('workers')).toBe('tasks')
    expect(moveFocusedPane('tasks')).toBe('details')
    expect(moveFocusedPane('details')).toBe('events')
    expect(moveFocusedPane('events')).toBe('workers')
  })

  it('解析最小按键交互', () => {
    expect(resolveWatchKeyAction('q')).toBe('quit')
    expect(resolveWatchKeyAction('r')).toBe('refresh')
    expect(resolveWatchKeyAction('p')).toBe('toggle-pause')
    expect(resolveWatchKeyAction('\t')).toBe('focus-next')
    expect(resolveWatchKeyAction('', { name: 'tab' })).toBe('focus-next')
    expect(resolveWatchKeyAction('1')).toBe('focus-workers')
    expect(resolveWatchKeyAction('2')).toBe('focus-tasks')
    expect(resolveWatchKeyAction('3')).toBe('focus-details')
    expect(resolveWatchKeyAction('4')).toBe('focus-events')
    expect(resolveWatchKeyAction('', { name: 'up' })).toBe('select-prev')
    expect(resolveWatchKeyAction('', { name: 'down' })).toBe('select-next')
    expect(resolveWatchKeyAction('k')).toBe('select-prev')
    expect(resolveWatchKeyAction('j')).toBe('select-next')
    expect(resolveWatchKeyAction('k', undefined, 'workers')).toBe('noop')
    expect(resolveWatchKeyAction('j', undefined, 'details')).toBe('details-scroll-down')
    expect(resolveWatchKeyAction('', { name: 'down' }, 'events')).toBe('noop')
    expect(resolveWatchKeyAction('q', undefined, 'workers')).toBe('quit')
    expect(resolveWatchKeyAction('r', undefined, 'details')).toBe('refresh')
    expect(resolveWatchKeyAction('p', undefined, 'events')).toBe('toggle-pause')
    expect(resolveWatchKeyAction('', { ctrl: true, name: 'c' })).toBe('quit')
    expect(resolveWatchKeyAction('x')).toBe('retry-selected-task')
    expect(resolveWatchKeyAction('/')).toBe('open-command-palette')
  })

  it('command palette 会按上下文过滤动作并支持简单 query', () => {
    const commands = buildWatchCommands({
      focusedPane: 'tasks',
      runDirectory: '/tmp/run',
      runStatus: 'RUNNING',
      selectedTask: {
        taskId: 'task-1',
        status: 'failed'
      }
    })

    expect(commands.some((command) => command.id === 'abort-run' && command.enabled)).toBe(true)
    expect(commands.some((command) => command.id === 'reroute-selected-task-reviewer' && command.enabled)).toBe(true)

    const filtered = filterWatchCommands(commands, 'planner')
    expect(filtered.map((command) => command.id)).toEqual(['reroute-selected-task-planner'])
  })

  it('palette 执行 reroute 动作时会写入 reroute-task 控制命令', async () => {
    const tempStateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-palette-reroute-'))
    const persisted = persistRunReport(
      tempStateRoot,
      createTaskReport('palette reroute goal'),
      resolve(tempStateRoot, 'runs', 'run-palette-reroute')
    )
    const viewModel = loadWatchViewModel({ stateRoot: tempStateRoot, reportPath: persisted.reportPath })
    const commands = buildWatchCommands({
      focusedPane: 'tasks',
      runDirectory: persisted.runDirectory,
      runStatus: 'RUNNING',
      selectedTask: viewModel.selectedTask
        ? { taskId: viewModel.selectedTask.taskId, status: viewModel.selectedTask.status }
        : null
    })
    const rerouteCommand = commands.find((command) => command.id === 'reroute-selected-task-reviewer')
    expect(rerouteCommand?.enabled).toBe(true)

    const updatedState = await executePaletteCommandForTest(rerouteCommand!, {
      stateRoot: tempStateRoot,
      runDirectory: persisted.runDirectory
    }, {
      ...createInitialWatchUiState(),
      selectedTaskId: viewModel.selectedTask?.taskId,
      palette: {
        open: true,
        query: 'reviewer',
        highlightedIndex: 0
      }
    })

    const controlPath = resolve(persisted.runDirectory, 'control.ndjson')
    const lines = readFileSync(controlPath, 'utf8').trim().split('\n').filter(Boolean)
    const command = JSON.parse(lines.at(-1)!) as { type: string; taskId?: string; targetRole?: string }
    expect(command.type).toBe('reroute-task')
    expect(command.taskId).toBe(viewModel.selectedTask?.taskId)
    expect(command.targetRole).toBe('reviewer')
    expect(updatedState.lastActionMessage).toContain('queued reroute')
  })

  it('command palette 打开时会渲染动作列表', () => {
    const tempStateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-palette-render-'))
    const persisted = persistRunReport(
      tempStateRoot,
      createTaskReport('palette render goal'),
      resolve(tempStateRoot, 'runs', 'run-palette-render')
    )
    const viewModel = loadWatchViewModel({ stateRoot: tempStateRoot, reportPath: persisted.reportPath })

    const rendered = renderWatchScreen(viewModel, {
      commandPalette: {
        query: 'reroute',
        actions: [
          {
            label: 'Reroute selected task -> reviewer',
            enabled: true,
            selected: true
          },
          {
            label: 'Reroute selected task -> planner',
            enabled: true,
            selected: false
          }
        ]
      }
    })

    expect(rendered).toContain('Command Palette')
    expect(rendered).toContain('Query: reroute')
    expect(rendered).toContain('> Reroute selected task -> reviewer')
  })

  it('focus 在 details pane 时解析详情滚动按键', () => {
    expect(resolveWatchKeyAction('k', undefined, 'details')).toBe('details-scroll-up')
    expect(resolveWatchKeyAction('j', undefined, 'details')).toBe('details-scroll-down')
    expect(resolveWatchKeyAction('', { name: 'up' }, 'details')).toBe('details-scroll-up')
    expect(resolveWatchKeyAction('', { name: 'down' }, 'details')).toBe('details-scroll-down')
    expect(resolveWatchKeyAction('', { ctrl: true, name: 'u' }, 'details')).toBe('details-page-up')
    expect(resolveWatchKeyAction('', { ctrl: true, name: 'd' }, 'details')).toBe('details-page-down')
    expect(resolveWatchKeyAction('g', undefined, 'details')).toBe('details-scroll-top')
    expect(resolveWatchKeyAction('G', undefined, 'details')).toBe('details-scroll-bottom')
  })

  it('focus 不在 details pane 时详情滚动按键不会影响 details offset', () => {
    expect(resolveWatchKeyAction('k', undefined, 'workers')).toBe('noop')
    expect(resolveWatchKeyAction('j', undefined, 'events')).toBe('noop')
    expect(resolveWatchKeyAction('', { ctrl: true, name: 'u' }, 'tasks')).toBe('noop')
    expect(resolveWatchKeyAction('', { ctrl: true, name: 'd' }, 'workers')).toBe('noop')
    expect(resolveWatchKeyAction('g', undefined, 'tasks')).toBe('noop')
    expect(resolveWatchKeyAction('G', undefined, 'events')).toBe('noop')
    expect(resolveWatchKeyAction('j', undefined, 'tasks')).toBe('select-next')
    expect(resolveWatchKeyAction('k', undefined, 'tasks')).toBe('select-prev')
  })

  it('切换选择时只在当前 hotTasks 内移动', () => {
    const report = createTaskReport('selection move')
    const nextTaskId = moveSelectedTaskId(report, 'task-2', 'next')
    const previousTaskId = moveSelectedTaskId(report, 'task-2', 'prev')

    expect(nextTaskId).toBe('task-1')
    expect(previousTaskId).toBe('task-3')
    expect(moveSelectedTaskId(report, 'task-1', 'next')).toBe('task-1')
    expect(moveSelectedTaskId(report, 'task-3', 'prev')).toBe('task-3')
  })

  it('任务切换时重置 detailsScrollOffset，但普通 refresh 不重置', () => {
    const syncDetailsScrollOffset = (watchModule as Record<string, (...args: never[]) => unknown>).syncDetailsScrollOffset

    expect(syncDetailsScrollOffset?.(7, 'task-1', 'task-2', 12)).toBe(0)
    expect(syncDetailsScrollOffset?.(7, 'task-2', 'task-2', 12)).toBe(7)
    expect(syncDetailsScrollOffset?.(99, 'task-2', 'task-2', 5)).toBe(5)
  })

  it('刷新后若原选择仍在 hotTasks 中则保持选中', () => {
    const report = createTaskReport('selection keep')

    expect(syncSelectedTaskId(report, 'task-2')).toBe('task-2')
  })

  it('刷新后若原选择不在 hotTasks 中则回退到第一条', () => {
    const report = createTaskReport('selection fallback')

    expect(syncSelectedTaskId(report, 'task-4')).toBe('task-3')
    expect(syncSelectedTaskId(report, undefined)).toBe('task-3')
  })

  it('detailMode 占位不影响现有选择同步与移动行为', () => {
    const report = createTaskReport('detail mode compatibility')
    const uiState = {
      ...createInitialWatchUiState(),
      detailMode: 'combined' as const,
      selectedTaskId: 'task-2'
    }

    expect(syncSelectedTaskId(report, uiState.selectedTaskId)).toBe('task-2')
    expect(moveSelectedTaskId(report, uiState.selectedTaskId, 'next')).toBe('task-1')
    expect(resolveWatchKeyAction('p')).toBe('toggle-pause')
    expect(resolveWatchKeyAction('j')).toBe('select-next')
  })

  it('选中失败任务并绑定 runDirectory 时，按 x 会写入 retry-task 控制命令', async () => {
    const tempStateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-retry-control-'))
    const persisted = persistRunReport(
      tempStateRoot,
      createTaskReport('retry control goal'),
      resolve(tempStateRoot, 'runs', 'run-retry-control')
    )
    const viewModel = loadWatchViewModel({ stateRoot: tempStateRoot, reportPath: persisted.reportPath })

    const initialState = {
      ...createInitialWatchUiState(),
      selectedTaskId: viewModel.selectedTask?.taskId,
      hotTaskIds: viewModel.hotTasks.map((task) => task.taskId)
    }

    // 确认按键映射
    expect(resolveWatchKeyAction('x')).toBe('retry-selected-task')

    const updatedState = await handleWatchControlActionForTest('retry-selected-task', {
      stateRoot: tempStateRoot,
      runDirectory: persisted.runDirectory
    }, initialState)

    const controlPath = resolve(persisted.runDirectory, 'control.ndjson')
    expect(existsSync(controlPath)).toBe(true)

    const lines = readFileSync(controlPath, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(1)

    const command = JSON.parse(lines[0]!) as { type: string; taskId?: string; id: string; createdAt: string }
    expect(command.type).toBe('retry-task')
    expect(command.taskId).toBe(viewModel.selectedTask?.taskId)
    expect(typeof command.id).toBe('string')
    expect(typeof command.createdAt).toBe('string')
    expect(updatedState.lastActionMessage).toContain('queued retry for')
  })

  it('attach 模式下按 A 会写入 abort-run 控制命令', async () => {
    const tempStateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-abort-control-'))
    const persisted = persistRunReport(
      tempStateRoot,
      createTaskReport('abort control goal'),
      resolve(tempStateRoot, 'runs', 'run-abort-control')
    )

    const initialState = {
      ...createInitialWatchUiState()
    }

    const action = resolveWatchKeyAction('A')
    expect(action).toBe('abort-run')

    const attachSession = {
      getStatus(): 'idle' | 'running' | 'completed' | 'failed' {
        return 'running'
      }
    }

    const updatedState = await handleWatchControlActionForTest(action, {
      stateRoot: tempStateRoot,
      runDirectory: persisted.runDirectory,
      attachSession
    }, initialState)

    const controlPath = resolve(persisted.runDirectory, 'control.ndjson')
    expect(existsSync(controlPath)).toBe(true)

    const lines = readFileSync(controlPath, 'utf8').trim().split('\n').filter(Boolean)
    expect(lines.length).toBe(1)

    const command = JSON.parse(lines[0]!) as { type: string; id: string; createdAt: string }
    expect(command.type).toBe('abort-run')
    expect(typeof command.id).toBe('string')
    expect(typeof command.createdAt).toBe('string')
    expect(updatedState.lastActionMessage).toBe('abort requested')
  })

  it('非 failed 任务按 x 不会写入控制命令', async () => {
    const tempStateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-retry-non-failed-'))
    const persisted = persistRunReport(
      tempStateRoot,
      createTaskReport('retry non failed control goal'),
      resolve(tempStateRoot, 'runs', 'run-retry-non-failed')
    )
    const viewModel = loadWatchViewModel({ stateRoot: tempStateRoot, reportPath: persisted.reportPath })

    const nonFailedTask = viewModel.hotTasks.find((task) => task.status !== 'failed')
    expect(nonFailedTask).toBeDefined()

    const initialState = {
      ...createInitialWatchUiState(),
      selectedTaskId: nonFailedTask!.taskId,
      hotTaskIds: viewModel.hotTasks.map((task) => task.taskId)
    }

    const updatedState = await handleWatchControlActionForTest('retry-selected-task', {
      stateRoot: tempStateRoot,
      runDirectory: persisted.runDirectory
    }, initialState)

    const controlPath = resolve(persisted.runDirectory, 'control.ndjson')
    expect(existsSync(controlPath)).toBe(false)
    expect(updatedState.lastActionMessage).toBe('仅支持重试状态为 failed 的任务')
  })

  it('run 已终态时按 A 不会写入 abort-run 控制命令', async () => {
    const tempStateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-abort-terminal-'))
    const persisted = persistRunReport(
      tempStateRoot,
      createMinimalReport('abort terminal control goal'),
      resolve(tempStateRoot, 'runs', 'run-abort-terminal')
    )

    const initialState = {
      ...createInitialWatchUiState()
    }

    const action = resolveWatchKeyAction('A')
    expect(action).toBe('abort-run')

    const attachSession = {
      getStatus(): 'idle' | 'running' | 'completed' | 'failed' {
        return 'completed'
      }
    }

    const updatedState = await handleWatchControlActionForTest(action, {
      stateRoot: tempStateRoot,
      runDirectory: persisted.runDirectory,
      attachSession
    }, initialState)

    const controlPath = resolve(persisted.runDirectory, 'control.ndjson')
    expect(existsSync(controlPath)).toBe(false)
    expect(updatedState.lastActionMessage).toBe('运行已结束，忽略 abort 请求')
  })

  it('切换 pane 不会丢失当前 selectedTaskId', () => {
    const uiState = {
      ...createInitialWatchUiState(),
      selectedTaskId: 'task-2',
      hotTaskIds: ['task-3', 'task-2', 'task-1'],
      focusedPane: 'tasks' as const
    }

    const switchedPaneState = {
      ...uiState,
      focusedPane: 'details' as const
    }

    expect(switchedPaneState.selectedTaskId).toBe('task-2')
    expect(resolveWatchKeyAction('j', undefined, switchedPaneState.focusedPane)).toBe('details-scroll-down')

    const backToTasksState = {
      ...switchedPaneState,
      focusedPane: 'tasks' as const
    }

    expect(backToTasksState.selectedTaskId).toBe('task-2')
    expect(resolveWatchKeyAction('j', undefined, backToTasksState.focusedPane)).toBe('select-next')
  })

  it('watch 渲染会显示当前 pane focus，并保持 renderWatchScreen(viewModel) 兼容', () => {
    const tempStateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-focus-render-'))
    const persisted = persistRunReport(
      tempStateRoot,
      createTaskReport('focus render goal'),
      resolve(tempStateRoot, 'runs', 'run-focus-render')
    )
    const viewModel = loadWatchViewModel({ stateRoot: tempStateRoot, reportPath: persisted.reportPath })

    const legacyRendered = renderWatchScreen(viewModel)
    const focusedRendered = renderWatchScreen(viewModel, { focusedPane: 'details' })

    expect(legacyRendered).toContain('Focus: Tasks')
    expect(legacyRendered).toContain('[↑/k] prev  [↓/j] next  (tasks pane)')
    expect(focusedRendered).toContain('Focus: Details')
    expect(focusedRendered).toContain('Task Details (focused)')
    expect(focusedRendered).toContain('Workers (unfocused)')
    expect(focusedRendered).toContain('[↑/k] up  [↓/j] down  [Ctrl+u/Ctrl+d] page  [g/G] top/bottom  (details pane)')
  })

  it('details pane 内容被裁剪时显示 more 提示，并支持基于 offset 滚动', () => {
    const tempStateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-details-scroll-render-'))
    const persisted = persistRunReport(
      tempStateRoot,
      createTaskReport('details scroll render goal'),
      resolve(tempStateRoot, 'runs', 'run-details-scroll-render')
    )
    const viewModel = loadWatchViewModel({ stateRoot: tempStateRoot, reportPath: persisted.reportPath })

    const topRendered = renderWatchScreen(viewModel, { focusedPane: 'details', detailsScrollOffset: 0 } as never)
    const scrolledRendered = renderWatchScreen(viewModel, { focusedPane: 'details', detailsScrollOffset: 2 } as never)

    expect(topRendered).toContain('Task Details (focused)')
    expect(topRendered).toContain('↓ more')
    expect(topRendered).not.toContain('↑ more')
    expect(scrolledRendered).toContain('↑ more')
    expect(scrolledRendered).toContain('↓ more')
    expect(scrolledRendered).not.toBe(topRendered)
  })

  it('切换到非 details pane 时仍保持 details viewport 裁剪与滚动位置', () => {
    const tempStateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-details-scroll-pane-switch-'))
    const persisted = persistRunReport(
      tempStateRoot,
      createTaskReport('details scroll pane switch goal'),
      resolve(tempStateRoot, 'runs', 'run-details-scroll-pane-switch')
    )
    const viewModel = loadWatchViewModel({ stateRoot: tempStateRoot, reportPath: persisted.reportPath })

    const tasksTopRendered = renderWatchScreen(viewModel, { focusedPane: 'tasks', detailsScrollOffset: 0 } as never)
    const tasksScrolledRendered = renderWatchScreen(viewModel, { focusedPane: 'tasks', detailsScrollOffset: 2 } as never)

    expect(tasksTopRendered).toContain('↓ more')
    expect(tasksTopRendered).not.toContain('↑ more')
    expect(tasksScrolledRendered).toContain('↑ more')
    expect(tasksScrolledRendered).toContain('↓ more')
    expect(tasksScrolledRendered).not.toBe(tasksTopRendered)
  })

  it('帮助文案会随 focused pane 切换任务导航与详情滚动提示', () => {
    const tempStateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-help-line-'))
    const persisted = persistRunReport(
      tempStateRoot,
      createTaskReport('help line goal'),
      resolve(tempStateRoot, 'runs', 'run-help-line')
    )
    const viewModel = loadWatchViewModel({ stateRoot: tempStateRoot, reportPath: persisted.reportPath })

    const tasksRendered = renderWatchScreen(viewModel)
    const detailsRendered = renderWatchScreen(viewModel, { focusedPane: 'details' })

    expect(tasksRendered).toContain('[↑/k] prev  [↓/j] next  (tasks pane)')
    expect(tasksRendered).not.toContain('[↑/k] up  [↓/j] down  [Ctrl+u/Ctrl+d] page  [g/G] top/bottom  (details pane)')
    expect(detailsRendered).toContain('[↑/k] up  [↓/j] down  [Ctrl+u/Ctrl+d] page  [g/G] top/bottom  (details pane)')
    expect(detailsRendered).not.toContain('[↑/k] prev  [↓/j] next  (tasks pane)')
  })

  it('启动 watch 时会锁定本次观察目标', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-lock-'))
    const first = persistRunReport(stateRoot, createMinimalReport('first watch goal'), resolve(stateRoot, 'runs', 'run-first'))
    const latest = persistRunReport(stateRoot, createMinimalReport('latest watch goal'), resolve(stateRoot, 'runs', 'run-latest'))

    expect(lockWatchTarget({ stateRoot })).toEqual({
      stateRoot,
      runDirectory: latest.runDirectory,
      reportPath: latest.reportPath
    })
    expect(lockWatchTarget({ stateRoot, runDirectory: first.runDirectory, reportPath: latest.reportPath })).toEqual({
      stateRoot,
      runDirectory: latest.runDirectory,
      reportPath: latest.reportPath
    })
  })

  it('识别 watch 命令并把 runDirectory/reportPath 透传给 watch tui', () => {
    const workspace = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-command-'))
    const capturePath = resolve(workspace, 'watch-capture.json')

    const result = spawnSync(
      process.execPath,
      [tsxCliPath, cliPath, 'watch', '--runDirectory', '/tmp/bata-workflow-run', '--reportPath=/tmp/bata-workflow-report.json'],
      {
        cwd: appRoot,
        encoding: 'utf8',
        env: { ...process.env, BATA_WORKFLOW_WATCH_CAPTURE_PATH: capturePath }
      }
    )

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')

    const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as WatchCapture
    expect(capture).toEqual({
      stateRoot,
      runDirectory: '/tmp/bata-workflow-run',
      reportPath: '/tmp/bata-workflow-report.json'
    })
  })

  it('无目标输入时也会进入 watch 分支而不是报缺少 goal', () => {
    const workspace = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-command-empty-'))
    const capturePath = resolve(workspace, 'watch-capture.json')

    const result = spawnSync(process.execPath, [tsxCliPath, cliPath, 'watch'], {
      cwd: appRoot,
      encoding: 'utf8',
      env: { ...process.env, BATA_WORKFLOW_WATCH_CAPTURE_PATH: capturePath }
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(existsSync(capturePath)).toBe(true)

    const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as WatchCapture
    expect(capture).toEqual({
      stateRoot,
      runDirectory: null,
      reportPath: null
    })
  })

  it('run --attach 会进入 watch tui 而不是普通输出路径', () => {
    const workspace = mkdtempSync(resolve(tmpdir(), 'bata-workflow-run-attach-command-'))
    const capturePath = resolve(workspace, 'watch-capture.json')

    const result = spawnSync(process.execPath, [tsxCliPath, cliPath, 'run', '--attach', '梳理登录链路现状'], {
      cwd: appRoot,
      encoding: 'utf8',
      env: { ...process.env, BATA_WORKFLOW_WATCH_CAPTURE_PATH: capturePath }
    })

    expect(result.status).toBe(0)
    expect(existsSync(capturePath)).toBe(true)

    const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as WatchCapture
    expect(capture.stateRoot).toBe(stateRoot)
    expect(capture.runDirectory).toContain('.bata-workflow/state/runs/')
    expect(capture.reportPath).toBeNull()
  })

  it('误写重复 run 子命令时仍会进入 attach watch tui 且忽略多余 run', () => {
    const workspace = mkdtempSync(resolve(tmpdir(), 'bata-workflow-run-duplicate-command-'))
    const capturePath = resolve(workspace, 'watch-capture.json')

    const result = spawnSync(process.execPath, [tsxCliPath, cliPath, 'run', 'run', '--attach', '理解当前项目'], {
      cwd: appRoot,
      encoding: 'utf8',
      env: { ...process.env, BATA_WORKFLOW_WATCH_CAPTURE_PATH: capturePath }
    })

    expect(result.status).toBe(0)
    expect(existsSync(capturePath)).toBe(true)

    const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as WatchCapture
    expect(capture.runDirectory).toContain('.bata-workflow/state/runs/')
    expect(basename(capture.runDirectory ?? '')).not.toMatch(/-run(?:-|$)/)
    expect(capture.reportPath).toBeNull()
  })

  it('误写 --atach 时会兼容为 --attach 并进入 watch tui', () => {
    const workspace = mkdtempSync(resolve(tmpdir(), 'bata-workflow-run-attach-typo-'))
    const capturePath = resolve(workspace, 'watch-capture.json')

    const result = spawnSync(process.execPath, [tsxCliPath, cliPath, 'run', 'run', '--atach', '理解当前项目'], {
      cwd: appRoot,
      encoding: 'utf8',
      env: { ...process.env, BATA_WORKFLOW_WATCH_CAPTURE_PATH: capturePath }
    })

    expect(result.status).toBe(0)
    expect(existsSync(capturePath)).toBe(true)

    const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as WatchCapture
    expect(capture.runDirectory).toContain('.bata-workflow/state/runs/')
    expect(basename(capture.runDirectory ?? '')).not.toMatch(/-run(?:-|$)/)
    expect(capture.reportPath).toBeNull()
  })

  it('reportPath 不存在时返回明确错误', () => {
    const missingReportPath = resolve(mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-missing-report-')), 'missing-report.json')

    const result = spawnSync(process.execPath, [tsxCliPath, cliPath, 'watch', '--reportPath', missingReportPath], {
      cwd: appRoot,
      encoding: 'utf8'
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(`未找到运行报告: ${missingReportPath}`)
  })

  it('在非 TTY 环境下会输出 watch 视图', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-render-'))
    const persisted = persistRunReport(stateRoot, createMinimalReport('render watch goal'), resolve(stateRoot, 'runs', 'run-render'))

    const result = spawnSync(process.execPath, [tsxCliPath, cliPath, 'watch', '--reportPath', persisted.reportPath], {
      cwd: appRoot,
      encoding: 'utf8'
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Status: COMPLETED')
    expect(result.stdout).toContain('Workers')
    expect(result.stdout).toContain('Team Activity')
  })
})
