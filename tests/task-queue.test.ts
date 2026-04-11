import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { mkdtempSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import type { DispatchAssignment } from '../src/domain/types.js'
import type { CocoAdapter } from '../src/runtime/coco-adapter.js'
import { runAssignmentsWithRuntime } from '../src/runtime/team-runtime.js'
import { getQueuePath, getTaskRecordPath, getTaskStorePath } from '../src/runtime/task-store.js'
import { createTaskQueue, loadTaskQueue } from '../src/runtime/task-queue.js'

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
})
