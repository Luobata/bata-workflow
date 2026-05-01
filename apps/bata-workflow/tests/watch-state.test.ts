import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { DispatchAssignment, Plan, RunReport, Task } from '../src/domain/types.js'
import { createTaskQueue } from '../src/runtime/task-queue.js'
import { persistRunReport } from '../src/runtime/state-store.js'
import { renderWatchScreen } from '../src/tui/render.js'
import { loadWatchViewModel } from '../src/tui/watch-state.js'

function createTask(
  id: string,
  title: string,
  status: Task['status'],
  patch: Partial<Task> = {}
): Task {
  return {
    id,
    title,
    description: `${title} description`,
    role: patch.role ?? 'coder',
    taskType: patch.taskType ?? 'coding',
    dependsOn: patch.dependsOn ?? [],
    acceptanceCriteria: patch.acceptanceCriteria ?? [],
    skills: patch.skills ?? [],
    status,
    maxAttempts: patch.maxAttempts ?? 3,
    failurePolicy: patch.failurePolicy,
    generatedFromTaskId: patch.generatedFromTaskId ?? null
  }
}

function createAssignment(task: Task): DispatchAssignment {
  return {
    task,
    modelResolution: {
      model: `${task.role}-model`,
      source: 'role',
      reason: 'test'
    },
    executionTarget: {
      backend: 'coco',
      model: `${task.role}-model`,
      source: 'role',
      reason: 'test',
      transport: 'auto'
    },
    roleDefinition: {
      name: task.role,
      description: `${task.role} role`,
      defaultTaskTypes: [task.taskType],
      defaultSkills: []
    },
    fallback: null,
    remediation: null
  }
}

function createMailboxMessage(
  messageId: string,
  taskId: string,
  direction: 'inbound' | 'outbound',
  content: string,
  createdAt: string,
  workerId = 'W1'
) {
  return {
    messageId,
    workerId,
    taskId,
    direction,
    content,
    createdAt
  }
}

function createReport(goal: string): RunReport {
  const tasks: Task[] = [
    createTask('T1', 'Handle failure', 'failed', {
      role: 'tester',
      dependsOn: ['T6'],
      generatedFromTaskId: 'T0'
    }),
    createTask('T2', 'Implement feature', 'in_progress'),
    createTask('T3', 'Review queue', 'ready'),
    createTask('T4', 'Ship patch', 'completed'),
    createTask('T5', 'Write notes', 'completed'),
    createTask('T6', 'Backlog cleanup', 'pending', { dependsOn: ['T3'] })
  ]
  const assignments = tasks.map(createAssignment)
  const plan: Plan = {
    goal,
    summary: `${goal} summary`,
    tasks
  }

  return {
    goal,
    plan,
    assignments,
    batches: [{ batchId: 'B1', taskIds: tasks.map((task) => task.id) }],
    runtime: {
      maxConcurrency: 3,
      workers: [
        {
          workerId: 'W1',
          slotId: 1,
          tmux: {
            paneId: '%12',
            sessionName: 'tmux-run-a:1',
            mode: 'dedicated-window',
            paneIndex: 0,
            title: 'slot-1'
          },
          role: 'coder',
          taskId: 'T2',
          model: 'coder-model',
          status: 'running',
          lastHeartbeatAt: '2026-04-12T10:04:00.000Z'
        },
        {
          workerId: 'W2',
          slotId: 2,
          tmux: {
            paneId: '%13',
            sessionName: 'tmux-run-a:1',
            mode: 'dedicated-window',
            paneIndex: 1,
            title: 'slot-2'
          },
          role: null,
          taskId: null,
          model: null,
          status: 'idle',
          lastHeartbeatAt: null
        }
      ],
      batches: [{ batchId: 'B1', taskIds: tasks.map((task) => task.id) }],
      completedTaskIds: ['T4', 'T5'],
      pendingTaskIds: ['T6'],
      readyTaskIds: ['T3'],
      inProgressTaskIds: ['T2'],
      failedTaskIds: ['T1'],
      dynamicTaskStats: {
        generatedTaskCount: 2,
        generatedTaskIds: ['T4_FIX_1', 'T4_VERIFY_1'],
        generatedTaskCountBySourceTaskId: { T4: 2 }
      },
      loopSummaries: [],
      events: [
        { type: 'batch-start', batchId: 'B1', detail: 'batch started', createdAt: '2026-04-12T10:00:00.000Z' },
        { type: 'task-start', batchId: 'B1', taskId: 'T2', detail: 'task started', createdAt: '2026-04-12T10:04:00.000Z' },
        { type: 'task-failed', batchId: 'B1', taskId: 'T1', detail: 'task failed', createdAt: '2026-04-12T10:03:00.000Z' },
        { type: 'task-complete', batchId: 'B1', taskId: 'T4', detail: 'task completed', createdAt: '2026-04-12T10:05:00.000Z' },
        { type: 'task-generated', batchId: 'B1', taskId: 'T4_FIX_1', detail: 'generated remediation task', createdAt: '2026-04-12T10:05:30.000Z' }
      ],
      mailbox: [],
      taskStates: [
        {
          taskId: 'T1',
          status: 'failed',
          claimedBy: null,
          attempts: 2,
          maxAttempts: 3,
          lastError: 'network timeout',
          attemptHistory: [
            {
              attempt: 1,
              workerId: 'W1',
              startedAt: '2026-04-12T10:00:00.000Z',
              finishedAt: '2026-04-12T10:01:00.000Z',
              status: 'failed'
            },
            {
              attempt: 2,
              workerId: 'W1',
              startedAt: '2026-04-12T10:02:00.000Z',
              finishedAt: '2026-04-12T10:03:00.000Z',
              status: 'failed'
            }
          ],
          workerHistory: ['W1'],
          failureTimestamps: ['2026-04-12T10:03:00.000Z'],
          lastClaimedAt: '2026-04-12T10:02:00.000Z',
          releasedAt: '2026-04-12T10:03:00.000Z',
          nextAttemptAt: null,
          lastUpdatedAt: '2026-04-12T10:03:00.000Z'
        },
        {
          taskId: 'T2',
          status: 'in_progress',
          claimedBy: 'W1',
          attempts: 1,
          maxAttempts: 3,
          lastError: null,
          attemptHistory: [
            {
              attempt: 1,
              workerId: 'W1',
              startedAt: '2026-04-12T10:04:00.000Z',
              finishedAt: null,
              status: 'in_progress'
            }
          ],
          workerHistory: ['W1'],
          failureTimestamps: [],
          lastClaimedAt: '2026-04-12T10:04:00.000Z',
          releasedAt: null,
          nextAttemptAt: null,
          lastUpdatedAt: '2026-04-12T10:04:00.000Z'
        },
        {
          taskId: 'T3',
          status: 'ready',
          claimedBy: null,
          attempts: 0,
          maxAttempts: 3,
          lastError: null,
          attemptHistory: [],
          workerHistory: [],
          failureTimestamps: [],
          lastClaimedAt: null,
          releasedAt: null,
          nextAttemptAt: null,
          lastUpdatedAt: '2026-04-12T10:02:30.000Z'
        },
        {
          taskId: 'T4',
          status: 'completed',
          claimedBy: null,
          attempts: 1,
          maxAttempts: 3,
          lastError: null,
          attemptHistory: [
            {
              attempt: 1,
              workerId: 'W2',
              startedAt: '2026-04-12T10:04:30.000Z',
              finishedAt: '2026-04-12T10:05:00.000Z',
              status: 'completed'
            }
          ],
          workerHistory: ['W2'],
          failureTimestamps: [],
          lastClaimedAt: '2026-04-12T10:04:30.000Z',
          releasedAt: '2026-04-12T10:05:00.000Z',
          nextAttemptAt: null,
          lastUpdatedAt: '2026-04-12T10:05:00.000Z'
        },
        {
          taskId: 'T5',
          status: 'completed',
          claimedBy: null,
          attempts: 1,
          maxAttempts: 3,
          lastError: null,
          attemptHistory: [
            {
              attempt: 1,
              workerId: 'W2',
              startedAt: '2026-04-12T09:00:00.000Z',
              finishedAt: '2026-04-12T09:01:00.000Z',
              status: 'completed'
            }
          ],
          workerHistory: ['W2'],
          failureTimestamps: [],
          lastClaimedAt: '2026-04-12T09:00:00.000Z',
          releasedAt: '2026-04-12T09:01:00.000Z',
          nextAttemptAt: null,
          lastUpdatedAt: '2026-04-12T09:01:00.000Z'
        },
        {
          taskId: 'T6',
          status: 'pending',
          claimedBy: null,
          attempts: 0,
          maxAttempts: 3,
          lastError: null,
          attemptHistory: [],
          workerHistory: [],
          failureTimestamps: [],
          lastClaimedAt: null,
          releasedAt: null,
          nextAttemptAt: null,
          lastUpdatedAt: null
        }
      ]
    },
    results: [
      {
        taskId: 'T5',
        role: 'coder',
        model: 'coder-model',
        summary: 'notes done',
        status: 'completed',
        attempt: 1
      },
      {
        taskId: 'T4',
        role: 'coder',
        model: 'coder-model',
        summary: 'patch shipped',
        status: 'completed',
        attempt: 1
      },
      {
        taskId: 'T1',
        role: 'coder',
        model: 'coder-model',
        summary: 'failed after retry',
        status: 'failed',
        attempt: 2
      }
    ],
    summary: {
      generatedTaskCount: 2,
      loopCount: 1,
      loopedSourceTaskIds: ['T4'],
      failedTaskCount: 1,
      completedTaskCount: 2,
      retryTaskCount: 1
    }
  }
}

describe('watch state', () => {
  it('selectedTask 与 hotTasks 会暴露 phase，并在详情区渲染 Phase', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-phase-'))
    const report = createReport('phase watch goal')
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-phase'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T2' })

    expect((viewModel.selectedTask as { phase?: string } | null)?.phase).toBe('running')
    expect((viewModel.hotTasks.find((task) => task.taskId === 'T2') as { phase?: string } | undefined)?.phase).toBe('running')

    const rendered = renderWatchScreen(viewModel)
    expect(rendered).toContain('Phase')
    expect(rendered).toContain('running')
  })

  it('在 report 尚未落盘时也能从 queue 快照加载运行中视图', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-live-'))
    const runDirectory = resolve(stateRoot, 'runs', 'run-live')
    const blockedTask = createTask('T2', 'Blocked downstream', 'pending', { dependsOn: ['T1'] })
    const plan: Plan = {
      goal: 'live watch goal',
      summary: 'live watch summary',
      tasks: [createTask('T1', 'Fail upstream', 'failed', { maxAttempts: 1 }), blockedTask]
    }
    const assignments = plan.tasks.map(createAssignment)
    assignments[0]!.task.maxAttempts = 1

    const queue = createTaskQueue({
      runDirectory,
      goal: plan.goal,
      plan,
      assignments,
      batches: [{ batchId: 'B1', taskIds: ['T1', 'T2'] }],
      workerPool: { maxConcurrency: 1 }
    })
    expect(queue.claimNextTask('W1')?.taskId).toBe('T1')
    queue.transitionTask('T1', 'failed', {
      finalizeAttempt: 'failed',
      result: {
        taskId: 'T1',
        role: 'coder',
        model: 'coder-model',
        summary: 'timeout after 120000ms',
        status: 'failed',
        attempt: 1
      }
    })
    queue.releaseTask('T1')

    const viewModel = loadWatchViewModel({ stateRoot, runDirectory })
    expect(viewModel.summary.goal).toBe('live watch goal')
    expect(viewModel.summary.failedTaskCount).toBe(1)
    expect(viewModel.summary.pendingTaskCount).toBe(0)
    expect(viewModel.hotTasks.map((task) => `${task.taskId}:${task.status}`)).toContain('T2:blocked')
    expect(renderWatchScreen(viewModel)).toContain('blocked')
  })

  it('聚合 watch 视图模型并应用热点排序、worker 占位与 recent event 裁剪', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-'))
    const report = createReport('watch latest goal')
    const persisted = persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-a'))

    const viewModel = loadWatchViewModel({ stateRoot, recentEventLimit: 3 })

    expect(viewModel.resolvedRun).toEqual({
      runDirectory: persisted.runDirectory,
      reportPath: persisted.reportPath
    })
    expect(viewModel.summary).toMatchObject({
      runLabel: 'run-a',
      goal: 'watch latest goal',
      overallStatus: 'RUNNING',
      batchProgress: '0/1',
      tmuxSessionLabel: 'tmux-run-a:1',
      totalTaskCount: 6,
      completedTaskCount: 2,
      failedTaskCount: 1,
      inProgressTaskCount: 1,
      readyTaskCount: 1,
      pendingTaskCount: 1,
      generatedTaskCount: 2,
      retryTaskCount: 1,
      loopCount: 1
    })
    expect(viewModel.hotTasks.map((task) => task.taskId)).toEqual(['T1', 'T2', 'T3', 'T4', 'T5'])
    expect(viewModel.workers).toHaveLength(3)
    expect(viewModel.workers[0]).toMatchObject({
      workerId: 'W1',
      scopeLabel: 'W1/S1/%12',
      roleLabel: 'coder',
      taskId: 'T2',
      taskTitle: 'Implement feature',
      modelLabel: 'coder-model',
      heartbeatLabel: '2026-04-12T10:04:00.000Z',
      paneLabel: '%12',
      tmuxSessionLabel: 'tmux-run-a:1',
      isPlaceholder: false
    })
    expect(viewModel.workers[1]).toMatchObject({
      workerId: 'W2',
      scopeLabel: 'W2/S2/%13',
      roleLabel: '--',
      taskTitle: '--',
      modelLabel: '--',
      heartbeatLabel: '--',
      paneLabel: '%13',
      tmuxSessionLabel: 'tmux-run-a:1',
      isPlaceholder: false
    })
    expect(viewModel.workers[2]).toMatchObject({
      workerId: 'W3',
      scopeLabel: 'W3',
      roleLabel: '--',
      taskTitle: '--',
      modelLabel: '--',
      heartbeatLabel: '--',
      paneLabel: '--',
      tmuxSessionLabel: '--',
      isPlaceholder: true
    })
    expect(viewModel.recentEvents).toHaveLength(3)
    expect(viewModel.recentEvents.map((event) => event.type)).toEqual(['task-generated', 'task-complete', 'task-start'])
    expect(viewModel.recentEvents.map((event) => event.createdAt)).toEqual([
      '2026-04-12T10:05:30.000Z',
      '2026-04-12T10:05:00.000Z',
      '2026-04-12T10:04:00.000Z'
    ])

    const rendered = renderWatchScreen(viewModel)
    expect(rendered).toContain('Workers')
    expect(rendered).toContain('Hot Tasks')
    expect(rendered).toContain('Task Details')
    expect(rendered).toContain('Team Activity')
    expect(rendered).toContain('Status: RUNNING')
    expect(rendered).toContain('>')
    expect(rendered).toContain('W1/S1/%12')
    expect(rendered).toContain('Pane: %12')
    expect(rendered).toContain('> T1       coding       failed')
    expect(rendered).toContain('Task ID:')
    expect(rendered).toContain('Last Error:')
    expect(rendered).toContain('Depends On:')
    expect(rendered).toContain('[↑/k] prev  [↓/j] next')
  })

  it('recentEvents 会按 createdAt 合并 runtime events 与 mailbox 活动流', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-activity-'))
    const report = createReport('activity goal')
    report.runtime.mailbox = [
      createMailboxMessage('M1', 'T2', 'outbound', 'implemented handoff notes', '2026-04-12T10:04:45.000Z', 'W1'),
      createMailboxMessage('M2', 'T4', 'inbound', 'claim task T4', '2026-04-12T10:05:15.000Z', 'W2')
    ]
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-activity'))

    const viewModel = loadWatchViewModel({ stateRoot, recentEventLimit: 4 })

    expect(viewModel.recentEvents.map((event) => ({ source: event.source, type: event.type, taskId: event.taskId }))).toEqual([
      { source: 'event', type: 'task-generated', taskId: 'T4_FIX_1' },
      { source: 'mailbox', type: 'mailbox:inbound', taskId: 'T4' },
      { source: 'event', type: 'task-complete', taskId: 'T4' },
      { source: 'mailbox', type: 'mailbox:outbound', taskId: 'T2' }
    ])

    const rendered = renderWatchScreen(viewModel)
    expect(rendered).toContain('Team Activity')
    expect(rendered).toContain('mailbox:inbound')
    expect(rendered).toContain('implemented handoff notes')
  })

  it('slotCount 大于 maxConcurrency 时 Workers 仍展示完整 slot/pane 池', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-slots-'))
    const report = createReport('slot visibility goal')
    report.runtime.maxConcurrency = 1
    report.runtime.workers = [
      report.runtime.workers[0]!,
      report.runtime.workers[1]!,
      {
        workerId: 'W3',
        slotId: 3,
        tmux: {
          paneId: '%14',
          sessionName: 'tmux-run-a:1',
          mode: 'dedicated-window',
          paneIndex: 2,
          title: 'slot-3'
        },
        role: null,
        taskId: null,
        model: null,
        status: 'idle',
        lastHeartbeatAt: null
      }
    ]
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-slot-visibility'))

    const viewModel = loadWatchViewModel({ stateRoot })

    expect(viewModel.workers).toHaveLength(3)
    expect(viewModel.workers.map((worker) => worker.scopeLabel)).toEqual(['W1/S1/%12', 'W2/S2/%13', 'W3/S3/%14'])
  })

  it('选中 failed task 时返回完整详情字段', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-selected-'))
    const report = createReport('selected task goal')
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-selected'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T1' })

    expect(viewModel.selectedTask).toEqual({
      taskId: 'T1',
      title: 'Handle failure',
      role: 'tester',
      taskType: 'coding',
      status: 'failed',
      phase: 'failed',
      phaseDetail: null,
      attempts: 2,
      maxAttempts: 3,
      lastError: 'network timeout',
      summary: 'failed after retry',
      dependsOn: ['T6'],
      generatedFromTaskId: 'T0',
      execution: {
        workerId: 'W1',
        slotId: 1,
        paneId: '%12',
        tmuxSessionLabel: 'tmux-run-a:1'
      },
      failureDetail: {
        latestFailureMessage: 'network timeout',
        summary: 'failed after retry',
        failedAttempts: [
          {
            attempt: 1,
            workerId: 'W1',
            startedAt: '2026-04-12T10:00:00.000Z',
            finishedAt: '2026-04-12T10:01:00.000Z',
            status: 'failed'
          },
          {
            attempt: 2,
            workerId: 'W1',
            startedAt: '2026-04-12T10:02:00.000Z',
            finishedAt: '2026-04-12T10:03:00.000Z',
            status: 'failed'
          }
        ],
        rerouteHistory: [],
        blockedDependents: []
      },
      collaboration: {
        mailbox: [],
        upstream: [
          {
            taskId: 'T6',
            role: 'coder',
            taskType: 'coding',
            status: 'pending',
            summary: null
          }
        ],
        handoffSummary: null,
        collaborationStatus: {
          hasInboundMailbox: false,
          hasOutboundMailbox: false,
          hasUpstreamSummaries: false
        }
      },
      artifacts: {
        changes: [],
        generatedFiles: [],
        notes: ['No recorded artifacts']
      }
    })
  })

  it('selectedTask 会聚合 artifacts 视图模型并在详情区渲染 Artifacts 区块', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-artifacts-'))
    const report = createReport('selected task artifacts goal')
    report.artifactsByTaskId = {
      T1: {
        taskId: 'T1',
        changes: [
          {
            path: 'src/tui/watch.ts',
            type: 'modified',
            additions: 12,
            deletions: 3
          },
          {
            path: 'tests/watch-command.test.ts',
            type: 'added',
            additions: 40,
            deletions: 0
          }
        ],
        generatedFiles: ['tests/watch-command.test.ts'],
        notes: ['Artifact snapshot is approximate because the workspace was already dirty before this task ran']
      }
    }
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-artifacts'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T1' })
    expect(viewModel.selectedTask?.artifacts).toEqual({
      changes: [
        {
          path: 'src/tui/watch.ts',
          type: 'modified',
          stats: '+12 -3'
        },
        {
          path: 'tests/watch-command.test.ts',
          type: 'added',
          stats: '+40 -0'
        }
      ],
      generatedFiles: ['tests/watch-command.test.ts'],
      notes: ['Artifact snapshot is approximate because the workspace was already dirty before this task ran']
    })

    const rendered = renderWatchScreen(viewModel)
    expect(rendered).toContain('Artifacts')
    expect(rendered).toContain('modified src/tui/watch.ts +12 -3')
    expect(rendered).toContain('added tests/watch-command.test.ts +40 -0')
  })

  it('为失败任务聚合 rerouteHistory 与 blockedDependents', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-failure-detail-'))
    const report = createReport('selected task failure detail goal')
    report.plan.tasks = report.plan.tasks.map((task) => {
      if (task.id === 'T3') {
        return {
          ...task,
          dependsOn: ['T1'],
          status: 'blocked'
        }
      }

      if (task.id === 'T6') {
        return {
          ...task,
          dependsOn: ['T1'],
          status: 'blocked'
        }
      }

      return task
    })
    report.assignments = report.assignments.map((assignment) => ({
      ...assignment,
      task:
        assignment.task.id === 'T3'
          ? { ...assignment.task, dependsOn: ['T1'], status: 'blocked' }
          : assignment.task.id === 'T6'
            ? { ...assignment.task, dependsOn: ['T1'], status: 'blocked' }
            : assignment.task
    }))
    report.runtime.blockedTaskIds = ['T3', 'T6']
    report.runtime.readyTaskIds = []
    report.runtime.pendingTaskIds = []
    report.runtime.events = [
      ...report.runtime.events,
      {
        type: 'task-rerouted',
        batchId: 'B1',
        taskId: 'T1',
        detail: 'T1 失败后切换为 role=reviewer, model=gpt-5.4'
      }
    ]
    report.runtime.taskStates = report.runtime.taskStates.map((state) => {
      if (state.taskId === 'T3' || state.taskId === 'T6') {
        return {
          ...state,
          status: 'blocked',
          lastError: 'blocked by upstream failure',
          lastUpdatedAt: '2026-04-12T10:05:30.000Z'
        }
      }

      return state
    })
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-failure-detail'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T1' })

    expect(viewModel.selectedTask?.failureDetail).toEqual({
      latestFailureMessage: 'network timeout',
      summary: 'failed after retry',
      failedAttempts: [
        {
          attempt: 1,
          workerId: 'W1',
          startedAt: '2026-04-12T10:00:00.000Z',
          finishedAt: '2026-04-12T10:01:00.000Z',
          status: 'failed'
        },
        {
          attempt: 2,
          workerId: 'W1',
          startedAt: '2026-04-12T10:02:00.000Z',
          finishedAt: '2026-04-12T10:03:00.000Z',
          status: 'failed'
        }
      ],
      rerouteHistory: [
        {
          fromRole: 'tester',
          toRole: 'reviewer',
          reason: 'T1 失败后切换为 role=reviewer, model=gpt-5.4'
        }
      ],
      blockedDependents: [
        {
          taskId: 'T3',
          title: 'Review queue',
          status: 'blocked'
        },
        {
          taskId: 'T6',
          title: 'Backlog cleanup',
          status: 'blocked'
        }
      ]
    })
  })

  it('rerouteHistory 保留原始来源角色，并支持带空格的目标角色名', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-reroute-role-'))
    const report = createReport('selected task reroute role goal')
    report.assignments = report.assignments.map((assignment) => {
      if (assignment.task.id !== 'T1') {
        return assignment
      }

      return {
        ...assignment,
        roleDefinition: {
          ...assignment.roleDefinition,
          name: 'code reviewer'
        }
      }
    })
    report.runtime.events = [
      ...report.runtime.events,
      {
        type: 'task-rerouted',
        batchId: 'B1',
        taskId: 'T1',
        detail: 'T1 失败后切换为 role=code reviewer, model=gpt-5.4'
      }
    ]
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-reroute-role'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T1' })

    expect(viewModel.selectedTask?.role).toBe('code reviewer')
    expect(viewModel.selectedTask?.failureDetail?.rerouteHistory).toEqual([
      {
        fromRole: 'tester',
        toRole: 'code reviewer',
        reason: 'T1 失败后切换为 role=code reviewer, model=gpt-5.4'
      }
    ])
  })

  it('多次 reroute 时按链路回放来源角色', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-reroute-chain-'))
    const report = createReport('selected task reroute chain goal')
    report.runtime.events = [
      ...report.runtime.events,
      {
        type: 'task-rerouted',
        batchId: 'B1',
        taskId: 'T1',
        detail: 'T1 失败后切换为 role=reviewer, model=gpt-5.4'
      },
      {
        type: 'task-rerouted',
        batchId: 'B1',
        taskId: 'T1',
        detail: 'T1 再次失败后切换为 role=principal reviewer, model=gpt-5.4'
      }
    ]
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-reroute-chain'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T1' })

    expect(viewModel.selectedTask?.failureDetail?.rerouteHistory).toEqual([
      {
        fromRole: 'tester',
        toRole: 'reviewer',
        reason: 'T1 失败后切换为 role=reviewer, model=gpt-5.4'
      },
      {
        fromRole: 'reviewer',
        toRole: 'principal reviewer',
        reason: 'T1 再次失败后切换为 role=principal reviewer, model=gpt-5.4'
      }
    ])
  })

  it('latestFailureMessage 会归一化 event 与 mailbox 前缀', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-failure-message-'))
    const report = createReport('selected task failure message goal')
    report.runtime.taskStates = report.runtime.taskStates.map((state) => {
      if (state.taskId !== 'T1') {
        return state
      }

      return {
        ...state,
        lastError: null
      }
    })
    report.results = report.results.map((result) => {
      if (result.taskId !== 'T1') {
        return result
      }

      return {
        ...result,
        summary: 'failed after retry'
      }
    })
    report.runtime.events = report.runtime.events.map((event) => {
      if (event.type !== 'task-failed' || event.taskId !== 'T1') {
        return event
      }

      return {
        ...event,
        detail: 'W1 执行 T1 失败: timeout after 120000ms'
      }
    })
    report.runtime.mailbox = [
      createMailboxMessage('M1', 'T1', 'outbound', '执行失败: timeout after 120000ms', '2026-04-12T10:03:30.000Z')
    ]
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-failure-message'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T1' })

    expect(viewModel.selectedTask?.failureDetail?.latestFailureMessage).toBe('timeout after 120000ms')
  })

  it('latestFailureMessage 不会把普通 timeout 说明误判为失败原因', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-failure-mailbox-noise-'))
    const report = createReport('selected task failure mailbox noise goal')
    report.runtime.taskStates = report.runtime.taskStates.map((state) => {
      if (state.taskId !== 'T1') {
        return state
      }

      return {
        ...state,
        lastError: null
      }
    })
    report.results = report.results.map((result) => {
      if (result.taskId !== 'T1') {
        return result
      }

      return {
        ...result,
        summary: ''
      }
    })
    report.runtime.events = report.runtime.events.filter((event) => !(event.type === 'task-failed' && event.taskId === 'T1'))
    report.runtime.mailbox = [
      createMailboxMessage('M1', 'T1', 'outbound', '准备把 timeout 提高后再试', '2026-04-12T10:03:30.000Z')
    ]
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-failure-mailbox-noise'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T1' })

    expect(viewModel.selectedTask?.failureDetail?.latestFailureMessage).toBeNull()
  })

  it('latestFailureMessage 不会把 timeout 前缀的重试说明误判为失败原因', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-failure-mailbox-prefix-noise-'))
    const report = createReport('selected task failure mailbox prefix noise goal')
    report.runtime.taskStates = report.runtime.taskStates.map((state) => {
      if (state.taskId !== 'T1') {
        return state
      }

      return {
        ...state,
        lastError: null
      }
    })
    report.results = report.results.map((result) => {
      if (result.taskId !== 'T1') {
        return result
      }

      return {
        ...result,
        summary: ''
      }
    })
    report.runtime.events = report.runtime.events.filter((event) => !(event.type === 'task-failed' && event.taskId === 'T1'))
    report.runtime.mailbox = [
      createMailboxMessage('M1', 'T1', 'outbound', 'timeout: 120000ms -> 180000ms 后重试', '2026-04-12T10:03:30.000Z')
    ]
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-failure-mailbox-prefix-noise'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T1' })

    expect(viewModel.selectedTask?.failureDetail?.latestFailureMessage).toBeNull()
  })

  it('selectedTask 聚合最近 mailbox，并提取最新 inbound handoff 摘要', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-mailbox-'))
    const report = createReport('selected task mailbox goal')
    report.runtime.mailbox = [
      createMailboxMessage('M0', 'T9', 'outbound', 'ignore unrelated task', '2026-04-12T10:00:30.000Z'),
      createMailboxMessage('M1', 'T1', 'inbound', 'claim task T1 (attempt 1/3)', '2026-04-12T10:01:00.000Z'),
      createMailboxMessage('M2', 'T1', 'outbound', 'first draft failed', '2026-04-12T10:02:00.000Z'),
      createMailboxMessage('M3', 'T1', 'inbound', '上游已交接修复建议', '2026-04-12T10:03:00.000Z'),
      createMailboxMessage('M4', 'T1', 'outbound', '已按建议完成修复', '2026-04-12T10:04:00.000Z')
    ]
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-mailbox'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T1' })

    expect(viewModel.selectedTask?.collaboration.mailbox).toEqual([
      {
        messageId: 'M4',
        workerId: 'W1',
        taskId: 'T1',
        direction: 'outbound',
        content: '已按建议完成修复',
        createdAt: '2026-04-12T10:04:00.000Z'
      },
      {
        messageId: 'M3',
        workerId: 'W1',
        taskId: 'T1',
        direction: 'inbound',
        content: '上游已交接修复建议',
        createdAt: '2026-04-12T10:03:00.000Z'
      },
      {
        messageId: 'M2',
        workerId: 'W1',
        taskId: 'T1',
        direction: 'outbound',
        content: 'first draft failed',
        createdAt: '2026-04-12T10:02:00.000Z'
      }
    ])
    expect(viewModel.selectedTask?.collaboration.handoffSummary).toBe('上游已交接修复建议')
    expect(viewModel.selectedTask?.collaboration.collaborationStatus).toEqual({
      hasInboundMailbox: true,
      hasOutboundMailbox: true,
      hasUpstreamSummaries: false
    })
  })

  it('最新 inbound 不是交接语义时 handoffSummary 保持为空', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-non-handoff-'))
    const report = createReport('selected task non handoff goal')
    report.runtime.mailbox = [
      createMailboxMessage('M1', 'T1', 'inbound', 'claim task T1 (attempt 1/3)', '2026-04-12T10:01:00.000Z'),
      createMailboxMessage('M2', 'T1', 'outbound', 'first draft failed', '2026-04-12T10:02:00.000Z')
    ]
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-non-handoff'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T1' })

    expect(viewModel.selectedTask?.collaboration.mailbox).toHaveLength(2)
    expect(viewModel.selectedTask?.collaboration.handoffSummary).toBeNull()
    expect(viewModel.selectedTask?.collaboration.collaborationStatus).toEqual({
      hasInboundMailbox: true,
      hasOutboundMailbox: true,
      hasUpstreamSummaries: false
    })
  })

  it('更早存在交接消息但最新 inbound 不是交接时 handoffSummary 仍为空', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-stale-handoff-'))
    const report = createReport('selected task stale handoff goal')
    report.runtime.mailbox = [
      createMailboxMessage('M1', 'T1', 'inbound', '上游已交接修复建议', '2026-04-12T10:01:00.000Z'),
      createMailboxMessage('M2', 'T1', 'outbound', '收到，开始处理', '2026-04-12T10:02:00.000Z'),
      createMailboxMessage('M3', 'T1', 'inbound', '请顺手补一条日志', '2026-04-12T10:03:00.000Z')
    ]
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-stale-handoff'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T1' })

    expect(viewModel.selectedTask?.collaboration.mailbox).toHaveLength(3)
    expect(viewModel.selectedTask?.collaboration.handoffSummary).toBeNull()
  })

  it('包含建议或上游字样的普通 inbound 消息不会被误判为 handoff', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-soft-keywords-'))
    const report = createReport('selected task soft keyword goal')
    report.runtime.mailbox = [
      createMailboxMessage('M1', 'T1', 'inbound', '建议补一条日志', '2026-04-12T10:01:00.000Z'),
      createMailboxMessage('M2', 'T1', 'inbound', '上游接口还在抖动', '2026-04-12T10:02:00.000Z')
    ]
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-soft-keywords'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T1' })

    expect(viewModel.selectedTask?.collaboration.mailbox).toHaveLength(2)
    expect(viewModel.selectedTask?.collaboration.handoffSummary).toBeNull()
  })

  it('selectedTask 只聚合 dependsOn 上游任务并映射其摘要', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-upstream-'))
    const report = createReport('selected task upstream goal')
    report.plan.tasks = report.plan.tasks.map((task) => {
      if (task.id !== 'T2') {
        return task
      }

      return {
        ...task,
        dependsOn: ['T4', 'T6']
      }
    })
    report.assignments = report.assignments.map((assignment) => ({
      ...assignment,
      task:
        assignment.task.id === 'T2'
          ? {
              ...assignment.task,
              dependsOn: ['T4', 'T6']
            }
          : assignment.task
    }))
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-upstream'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T2' })

    expect(viewModel.selectedTask?.collaboration.upstream).toEqual([
      {
        taskId: 'T4',
        role: 'coder',
        taskType: 'coding',
        status: 'completed',
        summary: 'patch shipped'
      },
      {
        taskId: 'T6',
        role: 'coder',
        taskType: 'coding',
        status: 'pending',
        summary: null
      }
    ])
    expect(viewModel.selectedTask?.collaboration.collaborationStatus).toEqual({
      hasInboundMailbox: false,
      hasOutboundMailbox: false,
      hasUpstreamSummaries: true
    })
  })

  it('Task Details 渲染包含 Collaboration 区块与协作摘要', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-render-collab-'))
    const report = createReport('selected task render collaboration goal')
    report.plan.tasks = report.plan.tasks.map((task) => {
      if (task.id !== 'T2') {
        return task
      }

      return {
        ...task,
        dependsOn: ['T4', 'T6']
      }
    })
    report.assignments = report.assignments.map((assignment) => ({
      ...assignment,
      task:
        assignment.task.id === 'T2'
          ? {
              ...assignment.task,
              dependsOn: ['T4', 'T6']
            }
          : assignment.task
    }))
    report.runtime.mailbox = [
      createMailboxMessage('M1', 'T2', 'inbound', '上游已交接修复建议，需要补一条集成日志', '2026-04-12T10:01:00.000Z'),
      createMailboxMessage('M2', 'T2', 'outbound', '已接手处理，正在更新实现并补日志', '2026-04-12T10:02:00.000Z'),
      createMailboxMessage('M3', 'T2', 'outbound', '修复已完成，等待验证', '2026-04-12T10:03:00.000Z')
    ]
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-render-collaboration'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T2' })
    const rendered = renderWatchScreen(viewModel)

    expect(rendered).toContain('Collaboration')
    expect(rendered).toContain('Mailbox:')
    expect(rendered).toContain('Upstream:')
    expect(rendered).toContain('Handoff:')
    expect(rendered).toContain('Collab Status:')
    expect(rendered).toContain('outbound 修复已完成，等待验证')
    expect(rendered).toContain('outbound 已接手处理，正在更新实现')
    expect(rendered).toContain('T4/completed/patch shipped')
    expect(rendered).toContain('T6/pending/--')
    expect(rendered).toContain('上游已交接修复建议，需要补一条集成日志')
    expect(rendered).toContain('in=Y out=Y up=Y')
  })

  it('没有 mailbox 与 upstream 时返回空聚合与 false 状态', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-empty-collab-'))
    const report = createReport('selected task empty collaboration goal')
    report.plan.tasks = report.plan.tasks.map((task) => {
      if (task.id !== 'T2') {
        return task
      }

      return {
        ...task,
        dependsOn: []
      }
    })
    report.assignments = report.assignments.map((assignment) => ({
      ...assignment,
      task: assignment.task.id === 'T2' ? { ...assignment.task, dependsOn: [] } : assignment.task
    }))
    report.runtime.mailbox = []
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-empty-collaboration'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T2' })

    expect(viewModel.selectedTask?.collaboration).toEqual({
      mailbox: [],
      upstream: [],
      handoffSummary: null,
      collaborationStatus: {
        hasInboundMailbox: false,
        hasOutboundMailbox: false,
        hasUpstreamSummaries: false
      }
    })
  })

  it('Task Details 在无协作数据时渲染明确占位文本', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-render-empty-collab-'))
    const report = createReport('selected task render empty collaboration goal')
    report.plan.tasks = report.plan.tasks.map((task) => {
      if (task.id !== 'T2') {
        return task
      }

      return {
        ...task,
        dependsOn: []
      }
    })
    report.assignments = report.assignments.map((assignment) => ({
      ...assignment,
      task: assignment.task.id === 'T2' ? { ...assignment.task, dependsOn: [] } : assignment.task
    }))
    report.runtime.mailbox = []
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-render-empty-collaboration'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T2' })
    const rendered = renderWatchScreen(viewModel)

    expect(rendered).toContain('Collaboration')
    expect(rendered).toContain('Mailbox:')
    expect(rendered).toContain('Upstream:')
    expect(rendered).toContain('Handoff:')
    expect(rendered).toContain('No mailbox activity')
    expect(rendered).toContain('No upstream tasks')
    expect(rendered).toContain('No handoff summary')
    expect(rendered).toContain('in=N out=N up=N')
  })

  it('Task Details 为失败任务渲染 Failure 区块', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-render-failure-'))
    const report = createReport('selected task render failure goal')
    report.runtime.events = [
      ...report.runtime.events,
      {
        type: 'task-rerouted',
        batchId: 'B1',
        taskId: 'T1',
        detail: 'T1 失败后切换为 role=reviewer, model=gpt-5.4'
      }
    ]
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-render-failure'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T1' })
    const rendered = renderWatchScreen(viewModel)

    expect(rendered).toContain('Failure')
    expect(rendered).toContain('Latest Failure:')
    expect(rendered).toContain('Attempts:')
    expect(rendered).toContain('Reroutes:')
    expect(rendered).toContain('Blocked Dependents:')
    expect(rendered).toContain('network timeout')
    expect(rendered).toContain('W1#1/failed')
    expect(rendered).toContain('reviewer')
  })

  it('失败任务渲染时 Last Error 与 Latest Failure 保持一致', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-render-failure-consistent-'))
    const report = createReport('selected task render failure consistent goal')
    report.runtime.taskStates = report.runtime.taskStates.map((state) => {
      if (state.taskId !== 'T1') {
        return state
      }

      return {
        ...state,
        lastError: null
      }
    })
    report.runtime.events = report.runtime.events.map((event) => {
      if (event.type !== 'task-failed' || event.taskId !== 'T1') {
        return event
      }

      return {
        ...event,
        detail: 'W1 执行 T1 失败: timeout after 120000ms'
      }
    })
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-render-failure-consistent'))

    const rendered = renderWatchScreen(loadWatchViewModel({ stateRoot, selectedTaskId: 'T1' }))

    expect(rendered).toContain('Last Error: timeout after 120000ms')
    expect(rendered).toContain('Latest Failure: timeout after 120000ms')
  })

  it('Failure 区块优先展示最近的 attempt 与 reroute', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-render-failure-order-'))
    const report = createReport('selected task render failure order goal')
    report.runtime.taskStates = report.runtime.taskStates.map((state) => {
      if (state.taskId !== 'T1') {
        return state
      }

      return {
        ...state,
        attemptHistory: [
          ...state.attemptHistory,
          {
            attempt: 3,
            workerId: 'W2',
            startedAt: '2026-04-12T10:04:00.000Z',
            finishedAt: '2026-04-12T10:05:00.000Z',
            status: 'failed'
          }
        ],
        attempts: 3,
        lastError: 'latest timeout'
      }
    })
    report.runtime.events = [
      ...report.runtime.events,
      {
        type: 'task-rerouted',
        batchId: 'B1',
        taskId: 'T1',
        detail: 'T1 失败后切换为 role=reviewer, model=gpt-5.4'
      },
      {
        type: 'task-rerouted',
        batchId: 'B1',
        taskId: 'T1',
        detail: 'T1 再次失败后切换为 role=principal reviewer, model=gpt-5.4'
      }
    ]
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-render-failure-order'))

    const rendered = renderWatchScreen(loadWatchViewModel({ stateRoot, selectedTaskId: 'T1' }))
    const latestAttemptIndex = rendered.indexOf('W2#3/failed')
    const olderAttemptIndex = rendered.indexOf('W1#1/failed')
    const latestRerouteIndex = rendered.indexOf('principal reviewer')
    const olderRerouteIndex = rendered.indexOf('role=reviewer, model=gpt-5.4')

    expect(latestAttemptIndex).toBeGreaterThanOrEqual(0)
    expect(olderAttemptIndex).toBeGreaterThanOrEqual(0)
    expect(latestRerouteIndex).toBeGreaterThanOrEqual(0)
    expect(olderRerouteIndex).toBeGreaterThanOrEqual(0)
    expect(latestAttemptIndex).toBeLessThan(olderAttemptIndex)
    expect(latestRerouteIndex).toBeLessThan(olderRerouteIndex)
  })

  it('Failure 区块的 blocked dependents 最多展示前 3 条稳定结果', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-render-failure-blocked-limit-'))
    const report = createReport('selected task render failure blocked limit goal')
    const extraTasks = [
      createTask('T7', 'Blocked task 7', 'blocked', { dependsOn: ['T1'] }),
      createTask('T8', 'Blocked task 8', 'blocked', { dependsOn: ['T1'] }),
      createTask('T9', 'Blocked task 9', 'blocked', { dependsOn: ['T1'] })
    ]
    report.plan.tasks.push(...extraTasks)
    report.assignments.push(...extraTasks.map(createAssignment))
    report.runtime.blockedTaskIds = ['T3', 'T6', 'T7', 'T8', 'T9']
    report.runtime.readyTaskIds = []
    report.runtime.pendingTaskIds = []
    report.runtime.taskStates = [
      ...report.runtime.taskStates.map((state) => {
        if (state.taskId === 'T3' || state.taskId === 'T6') {
          return {
            ...state,
            status: 'blocked',
            lastError: 'blocked by upstream failure'
          }
        }

        return state
      }),
      ...extraTasks.map((task, index) => ({
        taskId: task.id,
        status: 'blocked' as const,
        claimedBy: null,
        attempts: 0,
        maxAttempts: 3,
        lastError: 'blocked by upstream failure',
        attemptHistory: [],
        workerHistory: [],
        failureTimestamps: [],
        lastClaimedAt: null,
        releasedAt: null,
        nextAttemptAt: null,
        lastUpdatedAt: `2026-04-12T10:0${6 + index}:00.000Z`
      }))
    ]
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-render-failure-blocked-limit'))

    const rendered = renderWatchScreen(loadWatchViewModel({ stateRoot, selectedTaskId: 'T1' }))

    expect(rendered).toContain('T9/blocked/Blocked task 9')
    expect(rendered).toContain('T8/blocked/Blocked task 8')
    expect(rendered).toContain('T7/blocked/Blocked task 7')
    expect(rendered).not.toContain('T3/blocked/Review queue')
    expect(rendered).not.toContain('T6/blocked/Backlog cleanup')
    expect(rendered).not.toContain('T10/blocked/')
  })

  it('已成功任务即使保留失败历史也不显示 Failure 区块', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-success-no-failure-'))
    const report = createReport('selected task success no failure goal')
    report.runtime.taskStates = report.runtime.taskStates.map((state) => {
      if (state.taskId !== 'T4') {
        return state
      }

      return {
        ...state,
        attemptHistory: [
          {
            attempt: 1,
            workerId: 'W2',
            startedAt: '2026-04-12T10:04:30.000Z',
            finishedAt: '2026-04-12T10:04:45.000Z',
            status: 'failed'
          },
          {
            attempt: 2,
            workerId: 'W2',
            startedAt: '2026-04-12T10:04:46.000Z',
            finishedAt: '2026-04-12T10:05:00.000Z',
            status: 'completed'
          }
        ],
        attempts: 2,
        lastError: null
      }
    })
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-success-no-failure'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T4' })
    const rendered = renderWatchScreen(viewModel)

    expect(viewModel.selectedTask?.failureDetail).toBeNull()
    expect(rendered).not.toContain('Failure')
  })

  it('selectedTaskId 未命中时回退到第一条 hot task', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-selected-fallback-'))
    const report = createReport('selected task fallback goal')
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-selected-fallback'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T999' })

    expect(viewModel.hotTasks[0]?.taskId).toBe('T1')
    expect(viewModel.selectedTask?.taskId).toBe('T1')
  })

  it('selectedTaskId 命中被 hotTaskLimit 截断的任务时仍返回对应详情', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-selected-outside-limit-'))
    const report = createReport('selected task outside limit goal')
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-selected-outside-limit'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T4', hotTaskLimit: 3 })

    expect(viewModel.hotTasks.map((task) => task.taskId)).toEqual(['T1', 'T2', 'T3'])
    expect(viewModel.selectedTask?.taskId).toBe('T4')
    expect(viewModel.selectedTask?.summary).toBe('patch shipped')
  })

  it('没有 hot task 时 selectedTask 为 null', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-no-hot-'))
    const report = createReport('no hot task goal')
    report.plan.tasks = report.plan.tasks.map((task) => ({
      ...task,
      status: 'pending'
    }))
    report.assignments = report.assignments.map((assignment) => ({
      ...assignment,
      task: {
        ...assignment.task,
        status: 'pending'
      }
    }))
    report.runtime.workers = []
    report.runtime.completedTaskIds = []
    report.runtime.readyTaskIds = []
    report.runtime.inProgressTaskIds = []
    report.runtime.failedTaskIds = []
    report.runtime.pendingTaskIds = report.plan.tasks.map((task) => task.id)
    report.runtime.taskStates = report.runtime.taskStates.map((state) => ({
      ...state,
      status: 'pending',
      claimedBy: null,
      lastError: null,
      lastClaimedAt: null,
      releasedAt: null,
      nextAttemptAt: null,
      lastUpdatedAt: null,
      attemptHistory: []
    }))
    report.results = []
    report.summary = {
      ...report.summary,
      failedTaskCount: 0,
      completedTaskCount: 0,
      retryTaskCount: 0
    }
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-no-hot'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T1' })

    expect(viewModel.hotTasks).toEqual([])
    expect(viewModel.selectedTask).toBeNull()
    expect(renderWatchScreen(viewModel)).toContain('No active task selected')
  })

  it('优先使用显式 runDirectory 与 reportPath 定位观察目标', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-explicit-'))
    const first = persistRunReport(stateRoot, createReport('first goal'), resolve(stateRoot, 'runs', 'run-first'))
    const latest = persistRunReport(stateRoot, createReport('latest goal'), resolve(stateRoot, 'runs', 'run-latest'))

    const byRunDirectory = loadWatchViewModel({ stateRoot, runDirectory: first.runDirectory })
    const byReportPath = loadWatchViewModel({ stateRoot, reportPath: latest.reportPath })
    const byMismatchedInputs = loadWatchViewModel({
      stateRoot,
      runDirectory: first.runDirectory,
      reportPath: latest.reportPath
    })

    expect(byRunDirectory.summary.goal).toBe('first goal')
    expect(byRunDirectory.resolvedRun.runDirectory).toBe(first.runDirectory)
    expect(byReportPath.summary.goal).toBe('latest goal')
    expect(byReportPath.resolvedRun.reportPath).toBe(latest.reportPath)
    expect(byMismatchedInputs.resolvedRun.runDirectory).toBe(latest.runDirectory)
  })

  it('没有 latest run 时给出明确错误', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-missing-'))

    expect(() => loadWatchViewModel({ stateRoot })).toThrow('未找到可观察的运行')
  })

  it('reportPath 不存在时给出明确错误', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-missing-report-'))
    const reportPath = resolve(stateRoot, 'runs', 'missing', 'report.json')

    expect(() => loadWatchViewModel({ stateRoot, reportPath })).toThrow(`未找到运行报告: ${reportPath}`)
  })

  it('零 batch 场景显示 0/0 进度', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-watch-state-empty-batch-'))
    const report = createReport('empty batch goal')
    report.batches = []
    report.runtime.batches = []
    const persisted = persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-empty-batch'))

    const viewModel = loadWatchViewModel({ stateRoot, reportPath: persisted.reportPath })

    expect(viewModel.summary.batchProgress).toBe('0/0')
  })
})
