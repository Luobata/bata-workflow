import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { RunReport } from '../src/domain/types.js'
import { persistRunReport } from '../src/runtime/state-store.js'
import {
  createInitialWatchUiState,
  lockWatchTarget,
  moveSelectedTaskId,
  resolveWatchKeyAction,
  syncSelectedTaskId
} from '../src/tui/watch.js'

const repoRoot = resolve(import.meta.dirname, '..')
const cliPath = resolve(repoRoot, 'src/cli/index.ts')
const tsxCliPath = resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs')
const stateRoot = resolve(repoRoot, '.harness/state')

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
  it('初始 UI 状态默认使用 combined detailMode', () => {
    expect(createInitialWatchUiState()).toEqual({
      paused: false,
      selectedTaskId: undefined,
      hotTaskIds: [],
      detailMode: 'combined'
    })
  })

  it('解析最小按键交互', () => {
    expect(resolveWatchKeyAction('q')).toBe('quit')
    expect(resolveWatchKeyAction('r')).toBe('refresh')
    expect(resolveWatchKeyAction('p')).toBe('toggle-pause')
    expect(resolveWatchKeyAction('', { name: 'up' })).toBe('select-prev')
    expect(resolveWatchKeyAction('', { name: 'down' })).toBe('select-next')
    expect(resolveWatchKeyAction('k')).toBe('select-prev')
    expect(resolveWatchKeyAction('j')).toBe('select-next')
    expect(resolveWatchKeyAction('', { ctrl: true, name: 'c' })).toBe('quit')
    expect(resolveWatchKeyAction('x')).toBe('noop')
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

  it('启动 watch 时会锁定本次观察目标', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'harness-watch-lock-'))
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
    const workspace = mkdtempSync(resolve(tmpdir(), 'harness-watch-command-'))
    const capturePath = resolve(workspace, 'watch-capture.json')

    const result = spawnSync(
      process.execPath,
      [tsxCliPath, cliPath, 'watch', '--runDirectory', '/tmp/harness-run', '--reportPath=/tmp/harness-report.json'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: { ...process.env, HARNESS_WATCH_CAPTURE_PATH: capturePath }
      }
    )

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')

    const capture = JSON.parse(readFileSync(capturePath, 'utf8')) as WatchCapture
    expect(capture).toEqual({
      stateRoot,
      runDirectory: '/tmp/harness-run',
      reportPath: '/tmp/harness-report.json'
    })
  })

  it('无目标输入时也会进入 watch 分支而不是报缺少 goal', () => {
    const workspace = mkdtempSync(resolve(tmpdir(), 'harness-watch-command-empty-'))
    const capturePath = resolve(workspace, 'watch-capture.json')

    const result = spawnSync(process.execPath, [tsxCliPath, cliPath, 'watch'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, HARNESS_WATCH_CAPTURE_PATH: capturePath }
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

  it('reportPath 不存在时返回明确错误', () => {
    const missingReportPath = resolve(mkdtempSync(resolve(tmpdir(), 'harness-watch-missing-report-')), 'missing-report.json')

    const result = spawnSync(process.execPath, [tsxCliPath, cliPath, 'watch', '--reportPath', missingReportPath], {
      cwd: repoRoot,
      encoding: 'utf8'
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(`未找到运行报告: ${missingReportPath}`)
  })

  it('在非 TTY 环境下会输出 watch 视图', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'harness-watch-render-'))
    const persisted = persistRunReport(stateRoot, createMinimalReport('render watch goal'), resolve(stateRoot, 'runs', 'run-render'))

    const result = spawnSync(process.execPath, [tsxCliPath, cliPath, 'watch', '--reportPath', persisted.reportPath], {
      cwd: repoRoot,
      encoding: 'utf8'
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain('Status: COMPLETED')
    expect(result.stdout).toContain('Workers')
    expect(result.stdout).toContain('Recent Events')
  })
})
