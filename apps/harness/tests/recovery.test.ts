import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { DispatchAssignment } from '../src/domain/types.js'
import type { CocoAdapter } from '../src/runtime/coco-adapter.js'
import { resumeRun } from '../src/runtime/recovery.js'
import { createTaskQueue, loadTaskQueue } from '../src/runtime/task-queue.js'

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

describe('recovery', () => {
  it('基于持久化 queue 恢复未完成任务', async () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-recovery-'))
    const assignments: DispatchAssignment[] = [
      {
        task: {
          id: 'T1',
          title: 'plan',
          description: 'plan',
          role: 'planner',
          taskType: 'planning',
          dependsOn: [],
          acceptanceCriteria: ['a'],
          skills: ['analysis'],
          status: 'ready',
          maxAttempts: 1
        },
        roleDefinition: {
          name: 'planner',
          description: 'planner',
          defaultTaskTypes: ['planning'],
          defaultSkills: ['analysis']
        },
        modelResolution: { model: 'gpt5.4', source: 'global', reason: 'default' },
        fallback: null,
        remediation: null
      },
      {
        task: {
          id: 'T2',
          title: 'code',
          description: 'code',
          role: 'coder',
          taskType: 'coding',
          dependsOn: ['T1'],
          acceptanceCriteria: ['b'],
          skills: ['implementation'],
          status: 'pending',
          maxAttempts: 2
        },
        roleDefinition: {
          name: 'coder',
          description: 'coder',
          defaultTaskTypes: ['coding'],
          defaultSkills: ['implementation']
        },
        modelResolution: { model: 'gpt5.3-codex', source: 'taskType', reason: 'coding' },
        fallback: null,
        remediation: null
      },
      {
        task: {
          id: 'T3',
          title: 'review',
          description: 'review',
          role: 'reviewer',
          taskType: 'code-review',
          dependsOn: ['T2'],
          acceptanceCriteria: ['c'],
          skills: ['review'],
          status: 'pending',
          maxAttempts: 2
        },
        roleDefinition: {
          name: 'reviewer',
          description: 'reviewer',
          defaultTaskTypes: ['code-review'],
          defaultSkills: ['review']
        },
        modelResolution: { model: 'gpt5.3-codex', source: 'taskType', reason: 'review' },
        fallback: null,
        remediation: null
      }
    ]

    const queue = createTaskQueue({
      runDirectory,
      goal: 'resume goal',
      plan: {
        goal: 'resume goal',
        summary: 'summary',
        tasks: assignments.map((assignment) => assignment.task)
      },
      assignments,
      batches: [
        { batchId: 'B1', taskIds: ['T1'] },
        { batchId: 'B2', taskIds: ['T2'] },
        { batchId: 'B3', taskIds: ['T3'] }
      ],
      workerPool: { maxConcurrency: 1 }
    })

    const firstClaim = queue.claimNextTask('W1')
    expect(firstClaim?.taskId).toBe('T1')
    queue.transitionTask('T1', 'completed', {
      result: {
        taskId: 'T1',
        role: 'planner',
        model: 'gpt5.4',
        summary: 'done',
        status: 'completed',
        attempt: 1
      },
      finalizeAttempt: 'completed'
    })
    queue.releaseTask('T1')

    const secondClaim = queue.claimNextTask('W1')
    expect(secondClaim?.taskId).toBe('T2')

    class ResumeAdapter implements CocoAdapter {
      async execute({ assignment }) {
        return {
          taskId: assignment.task.id,
          role: assignment.roleDefinition.name,
          model: assignment.modelResolution.model,
          summary: `resumed ${assignment.task.id}`,
          status: 'completed' as const,
          attempt: 1
        }
      }
    }

    const resumed = await resumeRun({ runDirectory, adapter: new ResumeAdapter() })

    expect(resumed.results.map((result) => result.taskId)).toEqual(['T1', 'T2', 'T3'])
    expect(resumed.runtime.completedTaskIds).toEqual(['T1', 'T2', 'T3'])
    expect(resumed.runtime.pendingTaskIds).toEqual([])
    expect(resumed.runtime.workers).toHaveLength(1)
    expect(resumed.runtime.taskStates.find((taskState) => taskState.taskId === 'T2')?.attempts).toBe(2)
    expect(resumed.summary.completedTaskCount).toBe(3)
    expect(resumed.summary.retryTaskCount).toBe(1)
  })

  it('恢复执行时继续使用 repo root workspaceRoot 捕获 artifact 变化', async () => {
    const workspaceRoot = mkdtempSync(resolve(tmpdir(), 'harness-recovery-workspace-root-'))
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-recovery-artifacts-'))
    const repoRootFile = resolve(workspaceRoot, 'docs', 'spec.md')

    mkdirSync(resolve(workspaceRoot, 'apps', 'harness'), { recursive: true })
    mkdirSync(resolve(workspaceRoot, 'docs'), { recursive: true })
    writeFileSync(repoRootFile, 'before\n', 'utf8')

    runGit(workspaceRoot, ['init'])
    runGit(workspaceRoot, ['add', '.'])
    runGit(workspaceRoot, ['-c', 'user.name=Harness Test', '-c', 'user.email=harness@test.invalid', 'commit', '-m', 'init'])

    const assignments: DispatchAssignment[] = [
      {
        task: {
          id: 'T1',
          title: 'resume artifact',
          description: 'resume artifact',
          role: 'coder',
          taskType: 'coding',
          dependsOn: [],
          acceptanceCriteria: ['capture repo root artifact'],
          skills: ['implementation'],
          status: 'ready',
          maxAttempts: 1
        },
        roleDefinition: {
          name: 'coder',
          description: 'coder',
          defaultTaskTypes: ['coding'],
          defaultSkills: ['implementation']
        },
        modelResolution: { model: 'gpt5.3-codex', source: 'taskType', reason: 'coding' },
        fallback: null,
        remediation: null
      }
    ]

    createTaskQueue({
      runDirectory,
      goal: 'resume artifact goal',
      plan: {
        goal: 'resume artifact goal',
        summary: 'summary',
        tasks: assignments.map((assignment) => assignment.task)
      },
      assignments,
      batches: [{ batchId: 'B1', taskIds: ['T1'] }],
      workerPool: { maxConcurrency: 1 }
    })

    class ResumeArtifactAdapter implements CocoAdapter {
      async execute({ assignment }) {
        writeFileSync(repoRootFile, 'after\n', 'utf8')

        return {
          taskId: assignment.task.id,
          role: assignment.roleDefinition.name,
          model: assignment.modelResolution.model,
          summary: 'updated repo root file while resuming',
          status: 'completed' as const,
          attempt: 1
        }
      }
    }

    await resumeRun({
      runDirectory,
      adapter: new ResumeArtifactAdapter(),
      workspaceRoot
    })

    const artifactsByTaskId = loadTaskQueue(runDirectory).listArtifactsByTaskId()
    expect(artifactsByTaskId.T1?.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'docs/spec.md',
          type: 'modified'
        })
      ])
    )
  })
})
