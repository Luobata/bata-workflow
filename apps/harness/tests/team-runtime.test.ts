import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { DispatchAssignment } from '../src/domain/types.js'
import type { CocoAdapter } from '../src/runtime/coco-adapter.js'
import { appendControlCommand } from '../src/runtime/control-channel.js'
import { readAllRuntimeEvents } from '../src/runtime/event-stream.js'
import { runAssignmentsWithRuntime } from '../src/runtime/team-runtime.js'

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

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

describe('team runtime control channel', () => {
  it('收到 abort-run 控制命令后停止领取新任务，允许 in-flight 自然收口', async () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-team-runtime-abort-'))
    const assignments = createAssignments(['T1', 'T2'])

    const executedTasks: string[] = []

    class AbortAdapter implements CocoAdapter {
      async execute({ assignment }) {
        executedTasks.push(assignment.task.id)

        if (assignment.task.id === 'T1') {
          await appendControlCommand(runDirectory, {
            id: 'C1',
            type: 'abort-run',
            createdAt: new Date().toISOString()
          })
        }

        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))

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
      goal: 'abort goal',
      plan: {
        goal: 'abort goal',
        summary: 'abort summary',
        tasks: assignments.map((assignment) => assignment.task)
      },
      assignments,
      batches: [{ batchId: 'B1', taskIds: ['T1', 'T2'] }],
      adapter: new AbortAdapter(),
      workerPool: { maxConcurrency: 1 }
    })

    expect(executedTasks).toEqual(['T1'])
    expect(results.map((result) => result.taskId)).toEqual(['T1'])

    const t1State = runtime.taskStates.find((task) => task.taskId === 'T1')
    const t2State = runtime.taskStates.find((task) => task.taskId === 'T2')

    expect(t1State?.status).toBe('completed')
    expect(t2State?.status === 'ready' || t2State?.status === 'pending').toBe(true)

    expect(runtime.events.map((event) => event.type)).toContain('run-abort-requested')
    expect(runtime.events.map((event) => event.type)).toContain('run-aborted')

    const streamedEvents = await readAllRuntimeEvents(runDirectory)
    expect(streamedEvents.some((event) => event.type === 'run-abort-requested')).toBe(true)
    expect(streamedEvents.some((event) => event.type === 'run-aborted')).toBe(true)
  })

  it('收到 reroute-task 控制命令后会以新角色重新执行失败任务', async () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-team-runtime-reroute-'))
    const assignments = createAssignments(['T1', 'T2'])
    assignments[0]!.task.maxAttempts = 1

    const executionRoles: string[] = []
    let firstFailureIssued = false

    class RerouteAdapter implements CocoAdapter {
      async execute({ assignment }) {
        executionRoles.push(`${assignment.task.id}:${assignment.roleDefinition.name}`)

        if (assignment.task.id === 'T1' && assignment.roleDefinition.name === 'coder' && !firstFailureIssued) {
          firstFailureIssued = true
          setTimeout(() => {
            void appendControlCommand(runDirectory, {
              id: 'reroute-1',
              type: 'reroute-task',
              taskId: 'T1',
              targetRole: 'reviewer',
              createdAt: new Date().toISOString()
            })
          }, 5)

          return {
            taskId: assignment.task.id,
            role: assignment.roleDefinition.name,
            model: assignment.modelResolution.model,
            summary: 'boom',
            status: 'failed' as const,
            attempt: 1
          }
        }

        if (assignment.task.id === 'T2') {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 20))
        }

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

    const { results } = await runAssignmentsWithRuntime({
      runDirectory,
      goal: 'reroute goal',
      plan: {
        goal: 'reroute goal',
        summary: 'reroute summary',
        tasks: assignments.map((assignment) => assignment.task)
      },
      assignments,
      batches: [{ batchId: 'B1', taskIds: ['T1', 'T2'] }],
      adapter: new RerouteAdapter(),
      workerPool: { maxConcurrency: 2 }
    })

    expect(executionRoles).toContain('T1:coder')
    expect(executionRoles).toContain('T1:reviewer')
    expect(results.find((result) => result.taskId === 'T1')?.status).toBe('completed')
  })

  it('workspaceRoot 会驱动 repo root 级别的 git artifact snapshot', async () => {
    const workspaceRoot = mkdtempSync(resolve(tmpdir(), 'harness-team-runtime-workspace-root-'))
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-team-runtime-artifacts-'))
    const repoRootFile = resolve(workspaceRoot, 'docs', 'spec.md')

    mkdirSync(resolve(workspaceRoot, 'apps', 'harness'), { recursive: true })
    mkdirSync(resolve(workspaceRoot, 'docs'), { recursive: true })
    writeFileSync(repoRootFile, 'before\n', 'utf8')

    runGit(workspaceRoot, ['init'])
    runGit(workspaceRoot, ['add', '.'])
    runGit(workspaceRoot, ['-c', 'user.name=Harness Test', '-c', 'user.email=harness@test.invalid', 'commit', '-m', 'init'])

    const assignments = createAssignments(['T1'])

    class ArtifactAdapter implements CocoAdapter {
      async execute({ assignment }) {
        writeFileSync(repoRootFile, 'after\n', 'utf8')

        return {
          taskId: assignment.task.id,
          role: assignment.roleDefinition.name,
          model: assignment.modelResolution.model,
          summary: 'updated repo root file',
          status: 'completed' as const,
          attempt: 1
        }
      }
    }

    const { artifactsByTaskId } = await runAssignmentsWithRuntime({
      workspaceRoot,
      runDirectory,
      goal: 'artifact goal',
      plan: {
        goal: 'artifact goal',
        summary: 'artifact summary',
        tasks: assignments.map((assignment) => assignment.task)
      },
      assignments,
      batches: [{ batchId: 'B1', taskIds: ['T1'] }],
      adapter: new ArtifactAdapter(),
      workerPool: { maxConcurrency: 1 }
    })

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
