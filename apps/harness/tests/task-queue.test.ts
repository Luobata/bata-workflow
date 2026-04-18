import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { mkdtempSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { DispatchAssignment } from '../src/domain/types.js'
import type { CocoAdapter } from '../src/runtime/coco-adapter.js'
import { runAssignmentsWithRuntime } from '../src/runtime/team-runtime.js'
import { getQueuePath, getTaskRecordPath, getTaskStorePath } from '../src/runtime/task-store.js'
import { createTaskQueue, loadTaskQueue, rerouteFailedTask, retryFailedTask } from '../src/runtime/task-queue.js'

function createAssignments(taskIds: string[]): DispatchAssignment[] {
  return taskIds.map((taskId) => ({
    task: {
      id: taskId,
      title: taskId,
      description: taskId,
      role: 'coder',
      taskType: 'coding',
      dependsOn: [],
      acceptanceCriteria: [`${taskId}-ok`],
      skills: ['implementation'],
      status: 'ready',
      maxAttempts: 2
    },
    roleDefinition: {
      name: 'coder',
      description: 'coder',
      defaultTaskTypes: ['coding'],
      defaultSkills: ['implementation']
    },
    modelResolution: {
      model: 'gpt5.3-codex',
      source: 'taskType',
      reason: 'coding'
    },
    fallback: null,
    remediation: null
  }))
}

describe('task queue', () => {
  it('为任务初始化、claim、重试与终态维护结构化 phase', () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-task-queue-phase-'))
    const assignments = createAssignments(['T1', 'T2'])
    assignments[0]!.task.maxAttempts = 2
    assignments[1]!.task.dependsOn = ['T1']
    assignments[1]!.task.status = 'pending'

    const queue = createTaskQueue({
      runDirectory,
      goal: 'phase goal',
      plan: {
        goal: 'phase goal',
        summary: 'phase summary',
        tasks: assignments.map((assignment) => assignment.task)
      },
      assignments,
      batches: [{ batchId: 'B1', taskIds: ['T1', 'T2'] }],
      workerPool: { maxConcurrency: 1 }
    })

    expect((queue.getTaskState('T1') as { phase?: string }).phase).toBe('ready')
    expect((queue.getTaskState('T2') as { phase?: string }).phase).toBe('queued')

    queue.claimNextTask('W1')
    expect((queue.getTaskState('T1') as { phase?: string }).phase).toBe('running')

    queue.transitionTask('T1', 'ready', {
      lastError: 'retry later',
      nextAttemptAt: '2026-04-15T10:00:00.000Z',
      finalizeAttempt: 'failed'
    })
    expect((queue.getTaskState('T1') as { phase?: string }).phase).toBe('retrying')

    queue.transitionTask('T1', 'completed', {
      finalizeAttempt: 'completed',
      result: {
        taskId: 'T1',
        role: 'coder',
        model: 'gpt5.3-codex',
        summary: 'done',
        status: 'completed',
        attempt: 2
      }
    })
    queue.releaseTask('T1')
    expect((queue.getTaskState('T1') as { phase?: string }).phase).toBe('completed')
  })

  it('按任务文件和 queue 文件持久化 claim/release 状态', () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-task-queue-'))
    const assignments = createAssignments(['T1', 'T2'])
    const queue = createTaskQueue({
      runDirectory,
      goal: 'queue goal',
      plan: {
        goal: 'queue goal',
        summary: 'queue summary',
        tasks: assignments.map((assignment) => assignment.task)
      },
      assignments,
      batches: [{ batchId: 'B1', taskIds: ['T1', 'T2'] }],
      workerPool: { maxConcurrency: 2 }
    })

    expect(existsSync(getQueuePath(runDirectory))).toBe(true)
    expect(existsSync(getTaskStorePath(runDirectory))).toBe(true)
    expect(existsSync(getTaskRecordPath(runDirectory, 'T1'))).toBe(true)

    const claim = queue.claimNextTask('W1')
    expect(claim?.taskId).toBe('T1')

    const reloaded = loadTaskQueue(runDirectory)
    expect(reloaded.getTaskState('T1').status).toBe('in_progress')
    expect(reloaded.getTaskState('T1').claimedBy).toBe('W1')

    reloaded.transitionTask('T1', 'completed', {
      finalizeAttempt: 'completed',
      result: {
        taskId: 'T1',
        role: 'coder',
        model: 'gpt5.3-codex',
        summary: 'done',
        status: 'completed',
        attempt: 1
      }
    })
    reloaded.releaseTask('T1')

    const afterRelease = loadTaskQueue(runDirectory)
    expect(afterRelease.getTaskState('T1').status).toBe('completed')
    expect(afterRelease.getTaskState('T1').claimedBy).toBeNull()
    expect(afterRelease.getRuntimeSnapshot().completedTaskIds).toEqual(['T1'])
  })

  it('通过 worker pool 限制最大并发并复用 worker', async () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-worker-pool-'))
    const assignments = createAssignments(['T1', 'T2', 'T3'])
    let running = 0
    let maxSeen = 0

    class ConcurrencyAdapter implements CocoAdapter {
      async execute({ assignment }) {
        running += 1
        maxSeen = Math.max(maxSeen, running)
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
        running -= 1

        return {
          taskId: assignment.task.id,
          role: assignment.roleDefinition.name,
          model: assignment.modelResolution.model,
          summary: `done ${assignment.task.id}`,
          status: 'completed' as const,
          attempt: 1
        }
      }
    }

    const { runtime, results } = await runAssignmentsWithRuntime({
      runDirectory,
      goal: 'worker goal',
      plan: {
        goal: 'worker goal',
        summary: 'worker summary',
        tasks: assignments.map((assignment) => assignment.task)
      },
      assignments,
      batches: [{ batchId: 'B1', taskIds: ['T1', 'T2', 'T3'] }],
      adapter: new ConcurrencyAdapter(),
      workerPool: { maxConcurrency: 2 }
    })

    expect(maxSeen).toBe(2)
    expect(runtime.maxConcurrency).toBe(2)
    expect(runtime.workers).toHaveLength(2)
    expect(runtime.completedTaskIds).toEqual(['T1', 'T2', 'T3'])
    expect(results).toHaveLength(3)
  })

  it('支持在运行中追加 remediation 任务并更新依赖', () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-task-queue-generated-'))
    const assignments = createAssignments(['T1', 'T2'])
    assignments[1]!.task.taskType = 'testing'
    assignments[1]!.task.role = 'tester'
    assignments[1]!.fallback = {
      roleDefinition: {
        name: 'coder',
        description: 'coder',
        defaultTaskTypes: ['coding'],
        defaultSkills: ['implementation']
      },
      modelResolution: {
        model: 'gpt5.3-codex',
        source: 'fallback',
        reason: 'test fallback'
      }
    }
    assignments[1]!.remediation = {
      roleDefinition: {
        name: 'coder',
        description: 'coder',
        defaultTaskTypes: ['coding'],
        defaultSkills: ['implementation']
      },
      modelResolution: {
        model: 'gpt5.3-codex-remediation',
        source: 'remediation',
        reason: 'test remediation'
      },
      taskType: 'coding',
      skills: ['implementation']
    }

    const queue = createTaskQueue({
      runDirectory,
      goal: 'generated goal',
      plan: {
        goal: 'generated goal',
        summary: 'generated summary',
        tasks: assignments.map((assignment) => assignment.task)
      },
      assignments,
      batches: [{ batchId: 'B1', taskIds: ['T1', 'T2'] }],
      workerPool: { maxConcurrency: 2 }
    })

    queue.appendGeneratedTask({
      batchId: 'B1',
      assignment: {
        task: {
          id: 'T2_FIX_1',
          title: 'fix T2',
          description: 'fix T2',
          role: 'coder',
          taskType: 'coding',
          dependsOn: [],
          acceptanceCriteria: ['fix'],
          skills: ['implementation'],
          status: 'ready',
          maxAttempts: 1,
          generatedFromTaskId: 'T2'
        },
        roleDefinition: assignments[1]!.fallback!.roleDefinition,
        modelResolution: assignments[1]!.remediation!.modelResolution,
        fallback: null,
        remediation: null
      }
    })
    queue.addDependency('T2', 'T2_FIX_1')

    const reloaded = loadTaskQueue(runDirectory)
    expect(reloaded.listAssignments().some((assignment) => assignment.task.id === 'T2_FIX_1')).toBe(true)
    expect(reloaded.getBatchId('T2_FIX_1')).toBe('B1')
    expect(reloaded.listAssignments().find((assignment) => assignment.task.id === 'T2')?.task.dependsOn).toContain('T2_FIX_1')
  })

  it('上游任务失败且无法重试时将下游任务标记为 blocked', () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-task-queue-blocked-'))
    const assignments = createAssignments(['T1', 'T2'])
    assignments[0]!.task.maxAttempts = 1
    assignments[1]!.task.dependsOn = ['T1']
    assignments[1]!.task.status = 'pending'

    const queue = createTaskQueue({
      runDirectory,
      goal: 'blocked goal',
      plan: {
        goal: 'blocked goal',
        summary: 'blocked summary',
        tasks: assignments.map((assignment) => assignment.task)
      },
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
        model: 'gpt5.3-codex',
        summary: 'timeout after 120000ms',
        status: 'failed',
        attempt: 1
      }
    })
    queue.releaseTask('T1')

    const reloaded = loadTaskQueue(runDirectory)
    expect(reloaded.getTaskState('T2').status).toBe('blocked')
    expect(reloaded.getRuntimeSnapshot().pendingTaskIds).toEqual([])
    expect(reloaded.isBatchSettled('B1')).toBe(true)
  })

  it('retryFailedTask 会将 failed 任务重新标记为 ready 并清理错误信息', () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-task-retry-'))
    const assignments = createAssignments(['T1'])

    const queue = createTaskQueue({
      runDirectory,
      goal: 'retry goal',
      plan: {
        goal: 'retry goal',
        summary: 'retry summary',
        tasks: assignments.map((assignment) => assignment.task)
      },
      assignments,
      batches: [{ batchId: 'B1', taskIds: ['T1'] }],
      workerPool: { maxConcurrency: 1 }
    })

    const claim = queue.claimNextTask('W1')
    expect(claim?.taskId).toBe('T1')

    queue.transitionTask('T1', 'failed', {
      finalizeAttempt: 'failed',
      lastError: 'boom',
      result: {
        taskId: 'T1',
        role: 'coder',
        model: 'gpt5.3-codex',
        summary: 'boom',
        status: 'failed',
        attempt: 1
      }
    })
    queue.releaseTask('T1')

    const failedSnapshot = loadTaskQueue(runDirectory)
    expect(failedSnapshot.getTaskState('T1').status).toBe('failed')

    retryFailedTask(failedSnapshot, 'T1')

    const retriedSnapshot = loadTaskQueue(runDirectory)
    const state = retriedSnapshot.getTaskState('T1')
    expect(state.status).toBe('ready')
    expect(state.lastError).toBeNull()
    expect(retriedSnapshot.listResults()).toEqual([])
    expect(retriedSnapshot.getRuntimeSnapshot().readyTaskIds).toContain('T1')
  })

  it('rerouteFailedTask 会切换任务角色并重新标记为 ready', () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-task-reroute-'))
    const assignments = createAssignments(['T1'])

    const queue = createTaskQueue({
      runDirectory,
      goal: 'reroute goal',
      plan: {
        goal: 'reroute goal',
        summary: 'reroute summary',
        tasks: assignments.map((assignment) => assignment.task)
      },
      assignments,
      batches: [{ batchId: 'B1', taskIds: ['T1'] }],
      workerPool: { maxConcurrency: 1 }
    })

    const claim = queue.claimNextTask('W1')
    expect(claim?.taskId).toBe('T1')
    queue.transitionTask('T1', 'failed', {
      finalizeAttempt: 'failed',
      lastError: 'boom',
      result: {
        taskId: 'T1',
        role: 'coder',
        model: 'gpt5.3-codex',
        summary: 'boom',
        status: 'failed',
        attempt: 1
      }
    })
    queue.releaseTask('T1')

    const reroute = rerouteFailedTask(queue, 'T1', 'reviewer')
    expect(reroute).toEqual({ fromRole: 'coder', toRole: 'reviewer' })

    const reloaded = loadTaskQueue(runDirectory)
    const nextClaim = reloaded.claimNextTask('W1')
    expect(nextClaim?.assignment.roleDefinition.name).toBe('reviewer')
    expect(nextClaim?.assignment.task.role).toBe('reviewer')
    expect(nextClaim?.assignment.modelResolution.reason).toContain('rerouted')
  })

  it('retryFailedTask 仅允许对 failed 任务重试，其他状态会抛错', () => {
    // completed
    {
      const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-task-retry-invalid-completed-'))
      const assignments = createAssignments(['T1'])
      const queue = createTaskQueue({
        runDirectory,
        goal: 'retry invalid completed',
        plan: {
          goal: 'retry invalid completed',
          summary: 'retry invalid completed summary',
          tasks: assignments.map((assignment) => assignment.task)
        },
        assignments,
        batches: [{ batchId: 'B1', taskIds: ['T1'] }],
        workerPool: { maxConcurrency: 1 }
      })

      const claim = queue.claimNextTask('W1')
      expect(claim?.taskId).toBe('T1')
      queue.transitionTask('T1', 'completed', {
        finalizeAttempt: 'completed',
        result: {
          taskId: 'T1',
          role: 'coder',
          model: 'gpt5.3-codex',
          summary: 'done',
          status: 'completed',
          attempt: 1
        }
      })
      queue.releaseTask('T1')

      const reloaded = loadTaskQueue(runDirectory)
      expect(() => retryFailedTask(reloaded, 'T1')).toThrowError(/已完成/)
    }

    // in_progress
    {
      const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-task-retry-invalid-in-progress-'))
      const assignments = createAssignments(['T1'])
      const queue = createTaskQueue({
        runDirectory,
        goal: 'retry invalid in progress',
        plan: {
          goal: 'retry invalid in progress',
          summary: 'retry invalid in progress summary',
          tasks: assignments.map((assignment) => assignment.task)
        },
        assignments,
        batches: [{ batchId: 'B1', taskIds: ['T1'] }],
        workerPool: { maxConcurrency: 1 }
      })

      const claim = queue.claimNextTask('W1')
      expect(claim?.taskId).toBe('T1')
      expect(() => retryFailedTask(queue, 'T1')).toThrowError(/正在执行中/)
    }

    // blocked
    {
      const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-task-retry-invalid-blocked-'))
      const assignments = createAssignments(['T1', 'T2'])
      assignments[0]!.task.maxAttempts = 1
      assignments[1]!.task.dependsOn = ['T1']
      assignments[1]!.task.status = 'pending'

      const queue = createTaskQueue({
        runDirectory,
        goal: 'retry invalid blocked',
        plan: {
          goal: 'retry invalid blocked',
          summary: 'retry invalid blocked summary',
          tasks: assignments.map((assignment) => assignment.task)
        },
        assignments,
        batches: [{ batchId: 'B1', taskIds: ['T1', 'T2'] }],
        workerPool: { maxConcurrency: 1 }
      })

      const claim = queue.claimNextTask('W1')
      expect(claim?.taskId).toBe('T1')
      queue.transitionTask('T1', 'failed', {
        finalizeAttempt: 'failed',
        result: {
          taskId: 'T1',
          role: 'coder',
          model: 'gpt5.3-codex',
          summary: 'failed',
          status: 'failed',
          attempt: 1
        }
      })
      queue.releaseTask('T1')

      const reloaded = loadTaskQueue(runDirectory)
      expect(reloaded.getTaskState('T2').status).toBe('blocked')
      expect(() => retryFailedTask(reloaded, 'T2')).toThrowError(/被依赖阻塞/)
    }
  })
})
