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
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'bata-workflow-recovery-'))
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
        executionTarget: { backend: 'coco', model: 'gpt5.4', source: 'global', reason: 'default', transport: 'auto' },
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
        executionTarget: { backend: 'coco', model: 'gpt5.3-codex', source: 'taskType', reason: 'coding', transport: 'auto' },
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
        executionTarget: { backend: 'coco', model: 'gpt5.3-codex', source: 'taskType', reason: 'review', transport: 'auto' },
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
    const workspaceRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-recovery-workspace-root-'))
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'bata-workflow-recovery-artifacts-'))
    const repoRootFile = resolve(workspaceRoot, 'docs', 'spec.md')

    mkdirSync(resolve(workspaceRoot, 'apps', 'bata-workflow'), { recursive: true })
    mkdirSync(resolve(workspaceRoot, 'docs'), { recursive: true })
    writeFileSync(repoRootFile, 'before\n', 'utf8')

    runGit(workspaceRoot, ['init'])
    runGit(workspaceRoot, ['add', '.'])
    runGit(workspaceRoot, ['-c', 'user.name=Bata Workflow Test', '-c', 'user.email=bata-workflow@test.invalid', 'commit', '-m', 'init'])

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
        executionTarget: { backend: 'coco', model: 'gpt5.3-codex', source: 'taskType', reason: 'coding', transport: 'auto' },
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

  it('resume 会保留显式 slotCount 生成的 slot worker 池', async () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'bata-workflow-recovery-slots-'))
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
        executionTarget: { backend: 'coco', model: 'gpt5.4', source: 'global', reason: 'default', transport: 'auto' },
        fallback: null,
        remediation: null
      }
    ]

    createTaskQueue({
      runDirectory,
      goal: 'resume slots goal',
      plan: {
        goal: 'resume slots goal',
        summary: 'summary',
        tasks: assignments.map((assignment) => assignment.task)
      },
      assignments,
      batches: [{ batchId: 'B1', taskIds: ['T1'] }],
      workerPool: {
        maxConcurrency: 1,
        slotCount: 3,
        slots: [
          {
            slotId: 1,
            tmux: {
              paneId: '%12',
              sessionName: 'tmux-run-a:1',
              mode: 'dedicated-window',
              paneIndex: 0,
              title: 'slot-1'
            }
          },
          {
            slotId: 2,
            tmux: {
              paneId: '%13',
              sessionName: 'tmux-run-a:1',
              mode: 'dedicated-window',
              paneIndex: 1,
              title: 'slot-2'
            }
          },
          {
            slotId: 3,
            tmux: {
              paneId: '%14',
              sessionName: 'tmux-run-a:1',
              mode: 'dedicated-window',
              paneIndex: 2,
              title: 'slot-3'
            }
          }
        ]
      }
    })

    class ResumeSlotAdapter implements CocoAdapter {
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

    const resumed = await resumeRun({ runDirectory, adapter: new ResumeSlotAdapter() })

    expect(resumed.runtime.workers).toHaveLength(3)
    expect(resumed.runtime.workers.map((worker) => worker.slotId)).toEqual([1, 2, 3])
    expect(resumed.runtime.workers.map((worker) => worker.tmux?.paneId)).toEqual(['%12', '%13', '%14'])
    expect(resumed.runtime.completedTaskIds).toEqual(['T1'])
  })

  it('recover 不会把 in-flight 执行目标污染成后续任务的 slot 默认值', () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'bata-workflow-recovery-slot-pollution-'))
    const assignments: DispatchAssignment[] = [
      {
        task: {
          id: 'T1',
          title: 'local cc task',
          description: 'local cc task',
          role: 'coder',
          taskType: 'coding',
          dependsOn: [],
          acceptanceCriteria: ['t1'],
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
        modelResolution: { model: 'sonnet', source: 'role', reason: 'slot test' },
        executionTarget: {
          backend: 'local-cc',
          model: 'sonnet',
          profile: 'cc-local',
          source: 'role',
          reason: 'slot test',
          transport: 'auto'
        },
        fallback: null,
        remediation: null
      },
      {
        task: {
          id: 'T2',
          title: 'coco task',
          description: 'coco task',
          role: 'coder',
          taskType: 'coding',
          dependsOn: ['T1'],
          acceptanceCriteria: ['t2'],
          skills: ['implementation'],
          status: 'pending',
          maxAttempts: 1
        },
        roleDefinition: {
          name: 'coder',
          description: 'coder',
          defaultTaskTypes: ['coding'],
          defaultSkills: ['implementation']
        },
        modelResolution: { model: 'gpt5.3-codex', source: 'taskType', reason: 'default' },
        executionTarget: {
          backend: 'coco',
          model: 'gpt5.3-codex',
          source: 'taskType',
          reason: 'default',
          transport: 'auto'
        },
        fallback: null,
        remediation: null
      }
    ]

    const queue = createTaskQueue({
      runDirectory,
      goal: 'recover pollution goal',
      plan: {
        goal: 'recover pollution goal',
        summary: 'summary',
        tasks: assignments.map((assignment) => assignment.task)
      },
      assignments,
      batches: [
        { batchId: 'B1', taskIds: ['T1'] },
        { batchId: 'B2', taskIds: ['T2'] }
      ],
      workerPool: { maxConcurrency: 1 }
    })

    const firstClaim = queue.claimNextTask('W1')
    expect(firstClaim?.assignment.executionTarget.backend).toBe('local-cc')

    const recovered = loadTaskQueue(runDirectory, { recover: true })
    recovered.transitionTask('T1', 'completed', {
      finalizeAttempt: 'completed',
      result: {
        taskId: 'T1',
        role: 'coder',
        model: 'sonnet',
        summary: 'done',
        status: 'completed',
        attempt: 1
      }
    })
    recovered.releaseTask('T1')

    const secondClaim = recovered.claimNextTask('W1')
    expect(secondClaim?.taskId).toBe('T2')
    expect(secondClaim?.assignment.executionTarget).toMatchObject({
      backend: 'coco',
      model: 'gpt5.3-codex',
      source: 'taskType'
    })
  })
})
