import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { DispatchAssignment, Plan, RunReport, Task } from '../src/domain/types.js'
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
          role: 'coder',
          taskId: 'T2',
          model: 'coder-model',
          status: 'running',
          lastHeartbeatAt: '2026-04-12T10:04:00.000Z'
        },
        {
          workerId: 'W2',
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
        { type: 'batch-start', batchId: 'B1', detail: 'batch started' },
        { type: 'task-start', batchId: 'B1', taskId: 'T2', detail: 'task started' },
        { type: 'task-failed', batchId: 'B1', taskId: 'T1', detail: 'task failed' },
        { type: 'task-complete', batchId: 'B1', taskId: 'T4', detail: 'task completed' },
        { type: 'task-generated', batchId: 'B1', taskId: 'T4_FIX_1', detail: 'generated remediation task' }
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
  it('聚合 watch 视图模型并应用热点排序、worker 占位与 recent event 裁剪', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'harness-watch-state-'))
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
      roleLabel: 'coder',
      taskId: 'T2',
      taskTitle: 'Implement feature',
      modelLabel: 'coder-model',
      heartbeatLabel: '2026-04-12T10:04:00.000Z',
      isPlaceholder: false
    })
    expect(viewModel.workers[1]).toMatchObject({
      workerId: 'W2',
      roleLabel: '--',
      taskTitle: '--',
      modelLabel: '--',
      heartbeatLabel: '--',
      isPlaceholder: false
    })
    expect(viewModel.workers[2]).toMatchObject({
      workerId: 'W3',
      roleLabel: '--',
      taskTitle: '--',
      modelLabel: '--',
      heartbeatLabel: '--',
      isPlaceholder: true
    })
    expect(viewModel.recentEvents).toHaveLength(3)
    expect(viewModel.recentEvents.map((event) => event.type)).toEqual(['task-generated', 'task-complete', 'task-failed'])

    const rendered = renderWatchScreen(viewModel)
    expect(rendered).toContain('Workers')
    expect(rendered).toContain('Hot Tasks')
    expect(rendered).toContain('Task Details')
    expect(rendered).toContain('Recent Events')
    expect(rendered).toContain('Status: RUNNING')
    expect(rendered).toContain('>')
    expect(rendered).toContain('W1   coder        running    T2       Implement feature')
    expect(rendered).toContain('> T1       coding       failed')
    expect(rendered).toContain('Task ID:')
    expect(rendered).toContain('Last Error:')
    expect(rendered).toContain('Depends On:')
    expect(rendered).toContain('[↑/k] prev  [↓/j] next')
  })

  it('选中 failed task 时返回完整详情字段', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'harness-watch-state-selected-'))
    const report = createReport('selected task goal')
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-selected'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T1' })

    expect(viewModel.selectedTask).toEqual({
      taskId: 'T1',
      title: 'Handle failure',
      role: 'tester',
      taskType: 'coding',
      status: 'failed',
      attempts: 2,
      maxAttempts: 3,
      lastError: 'network timeout',
      summary: 'failed after retry',
      dependsOn: ['T6'],
      generatedFromTaskId: 'T0',
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
      }
    })
  })

  it('selectedTask 聚合最近 mailbox，并提取最新 inbound handoff 摘要', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'harness-watch-state-mailbox-'))
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
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'harness-watch-state-non-handoff-'))
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
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'harness-watch-state-stale-handoff-'))
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
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'harness-watch-state-soft-keywords-'))
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
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'harness-watch-state-upstream-'))
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
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'harness-watch-state-render-collab-'))
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
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'harness-watch-state-empty-collab-'))
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
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'harness-watch-state-render-empty-collab-'))
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

  it('selectedTaskId 未命中时回退到第一条 hot task', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'harness-watch-state-selected-fallback-'))
    const report = createReport('selected task fallback goal')
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-selected-fallback'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T999' })

    expect(viewModel.hotTasks[0]?.taskId).toBe('T1')
    expect(viewModel.selectedTask?.taskId).toBe('T1')
  })

  it('selectedTaskId 命中被 hotTaskLimit 截断的任务时仍返回对应详情', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'harness-watch-state-selected-outside-limit-'))
    const report = createReport('selected task outside limit goal')
    persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-selected-outside-limit'))

    const viewModel = loadWatchViewModel({ stateRoot, selectedTaskId: 'T4', hotTaskLimit: 3 })

    expect(viewModel.hotTasks.map((task) => task.taskId)).toEqual(['T1', 'T2', 'T3'])
    expect(viewModel.selectedTask?.taskId).toBe('T4')
    expect(viewModel.selectedTask?.summary).toBe('patch shipped')
  })

  it('没有 hot task 时 selectedTask 为 null', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'harness-watch-state-no-hot-'))
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
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'harness-watch-state-explicit-'))
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
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'harness-watch-state-missing-'))

    expect(() => loadWatchViewModel({ stateRoot })).toThrow('未找到可观察的运行')
  })

  it('reportPath 不存在时给出明确错误', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'harness-watch-state-missing-report-'))
    const reportPath = resolve(stateRoot, 'runs', 'missing', 'report.json')

    expect(() => loadWatchViewModel({ stateRoot, reportPath })).toThrow(`未找到运行报告: ${reportPath}`)
  })

  it('零 batch 场景显示 0/0 进度', () => {
    const stateRoot = mkdtempSync(resolve(tmpdir(), 'harness-watch-state-empty-batch-'))
    const report = createReport('empty batch goal')
    report.batches = []
    report.runtime.batches = []
    const persisted = persistRunReport(stateRoot, report, resolve(stateRoot, 'runs', 'run-empty-batch'))

    const viewModel = loadWatchViewModel({ stateRoot, reportPath: persisted.reportPath })

    expect(viewModel.summary.batchProgress).toBe('0/0')
  })
})
