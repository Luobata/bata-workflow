import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { DispatchAssignment } from '../src/domain/types.js'
import { AutoFallbackCocoAdapter, CocoCliAdapter, type CocoAdapter } from '../src/runtime/coco-adapter.js'
import { appendControlCommand } from '../src/runtime/control-channel.js'
import { readAllRuntimeEvents } from '../src/runtime/event-stream.js'
import { getQueuePath } from '../src/runtime/task-store.js'
import { runAssignmentsWithRuntime } from '../src/runtime/team-runtime.js'

function runGit(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function createRecordingCli(params: { directory: string; name: string; recordPath: string }): string {
  const { directory, name, recordPath } = params
  const scriptPath = resolve(directory, name)
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { basename } = require('node:path');

const bin = basename(process.argv[1]);
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ bin, argv, stdoutIsTTY: Boolean(process.stdout.isTTY) }) + "\\n", 'utf8');
process.stdout.write(JSON.stringify({ status: 'completed', summary: bin + ' ok' }));
`,
    'utf8'
  )
  chmodSync(scriptPath, 0o755)
  return scriptPath
}

function createFallbackCli(params: { directory: string; name: string; recordPath: string; summary: string }): string {
  const { directory, name, recordPath, summary } = params
  const scriptPath = resolve(directory, name)
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { basename } = require('node:path');

const bin = basename(process.argv[1]);
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ bin, argv, stdoutIsTTY: Boolean(process.stdout.isTTY) }) + "\\n", 'utf8');

if (argv.includes('--print')) {
  process.stdout.write('Explore(');
  process.exit(0);
}

process.stdout.write('✽ Thinking...\\n');
setTimeout(() => {
  process.stdout.write('⏺ {"status":"completed","summary":${JSON.stringify(summary)}}\\n');
  setTimeout(() => process.exit(0), 50);
}, 50);
`,
    'utf8'
  )
  chmodSync(scriptPath, 0o755)
  return scriptPath
}

function readRecordedInvocations(recordPath: string): Array<{ bin: string; argv: string[]; stdoutIsTTY?: boolean }> {
  return readFileSync(recordPath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { bin: string; argv: string[]; stdoutIsTTY?: boolean })
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
    executionTarget: {
      backend: 'coco',
      model: 'gpt5.3-codex',
      source: 'taskType',
      reason: 'coding',
      transport: 'auto'
    },
    fallback: null,
    remediation: null
  }))
}

describe('team runtime control channel', () => {
  it('persists monitor session metadata into queue state for live monitor bridging', async () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-team-runtime-monitor-'))
    const previousSessionId = process.env.COCO_SESSION_ID
    process.env.COCO_SESSION_ID = 'workspace-monitor-test'

    class MonitorAdapter implements CocoAdapter {
      async execute({ assignment }) {
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

    try {
      await runAssignmentsWithRuntime({
        workspaceRoot: '/tmp/monitor-workspace',
        runDirectory,
        goal: 'monitor goal',
        plan: {
          goal: 'monitor goal',
          summary: 'monitor summary',
          tasks: createAssignments(['T1']).map((assignment) => assignment.task)
        },
        assignments: createAssignments(['T1']),
        batches: [{ batchId: 'B1', taskIds: ['T1'] }],
        adapter: new MonitorAdapter(),
        workerPool: { maxConcurrency: 1 }
      })

      const queue = JSON.parse(readFileSync(getQueuePath(runDirectory), 'utf8')) as {
        monitor?: {
          rootSessionId: string
          monitorSessionId: string
          workspaceRoot: string
        } | null
      }

      expect(queue.monitor).toEqual({
        rootSessionId: 'workspace-monitor-test',
        monitorSessionId: 'monitor:workspace-monitor-test',
        workspaceRoot: '/tmp/monitor-workspace'
      })
    } finally {
      if (previousSessionId === undefined) {
        delete process.env.COCO_SESSION_ID
      } else {
        process.env.COCO_SESSION_ID = previousSessionId
      }
    }
  })

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
      batches: [{ batchId: 'B1', taskIds: ['T1', 'T2', 'T3'] }],
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
      batches: [{ batchId: 'B1', taskIds: ['T1', 'T2', 'T3'] }],
      adapter: new RerouteAdapter(),
      workerPool: { maxConcurrency: 2 }
    })

    expect(executionRoles).toContain('T1:coder')
    expect(executionRoles).toContain('T1:reviewer')
    expect(results.find((result) => result.taskId === 'T1')?.status).toBe('completed')
  })

  it('slot override 会以 runtime executionTarget 传给 adapter，且 runtime 会覆盖结果元数据', async () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-team-runtime-slot-route-'))
    const assignments = createAssignments(['T1', 'T2'])
    const seenTargets: Array<{ taskId: string; backend: string; model: string; profile: string | null; transport: string }> = []

    class SlotRouteAdapter implements CocoAdapter {
      async execute({ assignment }) {
        seenTargets.push({
          taskId: assignment.task.id,
          backend: assignment.executionTarget.backend,
          model: assignment.executionTarget.model,
          profile: assignment.executionTarget.profile ?? null,
          transport: assignment.executionTarget.transport
        })

        return {
          taskId: assignment.task.id,
          role: assignment.roleDefinition.name,
          model: 'adapter-wrong-model',
          backend: 'coco',
          profile: null,
          transport: 'pty',
          summary: `done ${assignment.task.id}`,
          status: 'completed' as const,
          attempt: 1
        }
      }
    }

    const { results } = await runAssignmentsWithRuntime({
      runDirectory,
      goal: 'slot route goal',
      plan: {
        goal: 'slot route goal',
        summary: 'slot route summary',
        tasks: assignments.map((assignment) => assignment.task)
      },
      assignments,
      batches: [{ batchId: 'B1', taskIds: ['T1', 'T2'] }],
      adapter: new SlotRouteAdapter(),
      workerPool: {
        maxConcurrency: 2,
        slotCount: 2,
        slots: [
          { slotId: 1, backend: 'coco', model: 'gpt5.3-codex' },
          { slotId: 2, backend: 'local-cc', model: 'sonnet', profile: 'cc-local' }
        ]
      }
    })

    expect(seenTargets).toHaveLength(2)
    expect(seenTargets.some((target) => target.backend === 'local-cc' && target.model === 'sonnet' && target.profile === 'cc-local')).toBe(true)
    expect(results.some((result) => result.backend === 'local-cc' && result.model === 'sonnet' && result.profile === 'cc-local' && result.transport === 'auto' && result.slotId === 2)).toBe(true)
    expect(results.some((result) => result.model === 'adapter-wrong-model')).toBe(false)
  })

  it('slot override 会驱动真实 CocoCliAdapter 路由到对应 backend 命令', async () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-team-runtime-slot-cli-'))
    const assignments = createAssignments(['T1'])
    assignments[0]!.executionTarget.command = 'legacy-coco'
    const binDir = resolve(runDirectory, 'bin')
    mkdirSync(binDir, { recursive: true })
    const recordPath = resolve(runDirectory, 'cc-record.ndjson')
    createRecordingCli({ directory: binDir, name: 'cc', recordPath })

    const previousPath = process.env.PATH ?? ''
    process.env.PATH = `${binDir}:${previousPath}`

    try {
      const { results } = await runAssignmentsWithRuntime({
        runDirectory,
        goal: 'slot cli route goal',
        plan: {
          goal: 'slot cli route goal',
          summary: 'slot cli route summary',
          tasks: assignments.map((assignment) => assignment.task)
        },
        assignments,
        batches: [{ batchId: 'B1', taskIds: ['T1'] }],
        adapter: new CocoCliAdapter(),
        workerPool: {
          maxConcurrency: 1,
          slotCount: 1,
          slots: [{ slotId: 1, backend: 'local-cc', model: 'sonnet', profile: 'cc-local' }]
        }
      })

      const [invocation] = readRecordedInvocations(recordPath)
      expect(invocation?.bin).toBe('cc')
      expect(invocation?.argv).toEqual(expect.arrayContaining(['--dangerously-skip-permissions', '--profile', 'cc-local', '--model', 'sonnet', '--print']))
      expect(results[0]).toMatchObject({
        backend: 'local-cc',
        model: 'sonnet',
        profile: 'cc-local',
        slotId: 1,
        status: 'completed'
      })
    } finally {
      process.env.PATH = previousPath
    }
  })

  it('slot override 下失败结果也会由 runtime 回填 executionTarget 元数据', async () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-team-runtime-slot-failed-'))
    const assignments = createAssignments(['T1'])
    assignments[0]!.task.maxAttempts = 1

    class FailedSlotRouteAdapter implements CocoAdapter {
      async execute({ assignment }) {
        return {
          taskId: assignment.task.id,
          role: assignment.roleDefinition.name,
          model: 'adapter-wrong-model',
          backend: 'coco',
          profile: null,
          transport: 'pty',
          summary: 'adapter failed',
          status: 'failed' as const,
          attempt: 1
        }
      }
    }

    const { results } = await runAssignmentsWithRuntime({
      runDirectory,
      goal: 'slot failed goal',
      plan: {
        goal: 'slot failed goal',
        summary: 'slot failed summary',
        tasks: assignments.map((assignment) => assignment.task)
      },
      assignments,
      batches: [{ batchId: 'B1', taskIds: ['T1'] }],
      adapter: new FailedSlotRouteAdapter(),
      workerPool: {
        maxConcurrency: 1,
        slotCount: 1,
        slots: [{ slotId: 1, backend: 'local-cc', model: 'sonnet', profile: 'cc-local' }]
      }
    })

    expect(results[0]).toMatchObject({
      backend: 'local-cc',
      model: 'sonnet',
      profile: 'cc-local',
      transport: 'auto',
      slotId: 1,
      status: 'failed',
      summary: 'adapter failed'
    })
    expect(results[0]?.model).not.toBe('adapter-wrong-model')
  })

  it('默认 coco-auto 路径下 slot override + transport=auto 会走 backend fallback 链路', async () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-team-runtime-auto-fallback-'))
    const assignments = createAssignments(['T1'])
    const binDir = resolve(runDirectory, 'bin')
    mkdirSync(binDir, { recursive: true })
    const recordPath = resolve(runDirectory, 'cc-fallback-record.ndjson')
    createFallbackCli({ directory: binDir, name: 'cc', recordPath, summary: 'cc pty recovered' })

    const previousPath = process.env.PATH ?? ''
    process.env.PATH = `${binDir}:${previousPath}`

    try {
      const { results } = await runAssignmentsWithRuntime({
        runDirectory,
        goal: 'auto fallback goal',
        plan: {
          goal: 'auto fallback goal',
          summary: 'auto fallback summary',
          tasks: assignments.map((assignment) => assignment.task)
        },
        assignments,
        batches: [{ batchId: 'B1', taskIds: ['T1'] }],
        adapter: new AutoFallbackCocoAdapter(),
        workerPool: {
          maxConcurrency: 1,
          slotCount: 1,
          slots: [{ slotId: 1, backend: 'local-cc', model: 'sonnet', profile: 'cc-local' }]
        }
      })

      const invocations = readRecordedInvocations(recordPath)
      expect(invocations).toHaveLength(2)
      expect(invocations[0]?.bin).toBe('cc')
      expect(invocations[0]?.stdoutIsTTY).toBe(false)
      expect(invocations[0]?.argv).toContain('--print')
      expect(invocations[1]?.bin).toBe('cc')
      expect(invocations[1]?.stdoutIsTTY).toBe(true)
      expect(invocations[1]?.argv).not.toContain('--print')
      expect(results[0]).toMatchObject({
        backend: 'local-cc',
        model: 'sonnet',
        profile: 'cc-local',
        slotId: 1,
        status: 'completed',
        summary: 'cc pty recovered'
      })
    } finally {
      process.env.PATH = previousPath
    }
  })

  it('maxConcurrency 受限时会优先复用最久空闲的 slot worker', async () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-team-runtime-oldest-idle-'))
    const assignments = createAssignments(['T1', 'T2', 'T3'])

    class OldestIdleAdapter implements CocoAdapter {
      async execute({ assignment }) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
        return {
          taskId: assignment.task.id,
          role: assignment.roleDefinition.name,
          model: assignment.executionTarget.model,
          summary: `done ${assignment.task.id}`,
          status: 'completed' as const,
          attempt: 1
        }
      }
    }

    const { runtime } = await runAssignmentsWithRuntime({
      runDirectory,
      goal: 'oldest idle goal',
      plan: {
        goal: 'oldest idle goal',
        summary: 'oldest idle summary',
        tasks: assignments.map((assignment) => assignment.task)
      },
      assignments,
      batches: [{ batchId: 'B1', taskIds: ['T1', 'T2', 'T3'] }],
      adapter: new OldestIdleAdapter(),
      workerPool: { maxConcurrency: 1, slotCount: 2 }
    })

    expect(runtime.taskStates.map((taskState) => taskState.workerHistory[0])).toEqual(['W1', 'W2', 'W1'])
  })

  it('backend 不变时 slot override 仅改 model/profile 也会保留显式 command', async () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-team-runtime-command-preserve-'))
    const assignments = createAssignments(['T1'])
    assignments[0]!.executionTarget = {
      backend: 'local-cc',
      model: 'base-model',
      profile: 'base-profile',
      command: 'custom-cc',
      source: 'role',
      reason: 'explicit command baseline',
      transport: 'print'
    }
    const binDir = resolve(runDirectory, 'bin')
    mkdirSync(binDir, { recursive: true })
    const recordPath = resolve(runDirectory, 'custom-cc-record.ndjson')
    createRecordingCli({ directory: binDir, name: 'custom-cc', recordPath })
    createRecordingCli({ directory: binDir, name: 'cc', recordPath })

    const previousPath = process.env.PATH ?? ''
    process.env.PATH = `${binDir}:${previousPath}`

    try {
      const { results } = await runAssignmentsWithRuntime({
        runDirectory,
        goal: 'command preserve goal',
        plan: {
          goal: 'command preserve goal',
          summary: 'command preserve summary',
          tasks: assignments.map((assignment) => assignment.task)
        },
        assignments,
        batches: [{ batchId: 'B1', taskIds: ['T1'] }],
        adapter: new CocoCliAdapter(),
        workerPool: {
          maxConcurrency: 1,
          slotCount: 1,
          slots: [{ slotId: 1, model: 'slot-model', profile: 'slot-profile' }]
        }
      })

      const invocations = readRecordedInvocations(recordPath)
      expect(invocations).toHaveLength(1)
      expect(invocations[0]?.bin).toBe('custom-cc')
      expect(invocations[0]?.argv).toEqual(expect.arrayContaining(['--dangerously-skip-permissions', '--profile', 'slot-profile', '--model', 'slot-model', '--print']))
      expect(results[0]).toMatchObject({
        command: 'custom-cc',
        backend: 'local-cc',
        model: 'slot-model',
        profile: 'slot-profile',
        status: 'completed'
      })
    } finally {
      process.env.PATH = previousPath
    }
  })

  it('runtime event detail 会带上 worker/slot/pane scope', async () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-team-runtime-scope-'))
    const assignments = createAssignments(['T1'])

    class ScopeAdapter implements CocoAdapter {
      async execute({ assignment }) {
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

    const { runtime } = await runAssignmentsWithRuntime({
      runDirectory,
      goal: 'scope goal',
      plan: {
        goal: 'scope goal',
        summary: 'scope summary',
        tasks: assignments.map((assignment) => assignment.task)
      },
      assignments,
      batches: [{ batchId: 'B1', taskIds: ['T1'] }],
      adapter: new ScopeAdapter(),
      workerPool: {
        maxConcurrency: 1,
        slotCount: 1,
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
          }
        ]
      }
    })

    expect(runtime.events.find((event) => event.type === 'task-claimed')?.detail).toContain('W1/S1/%12 claim T1')
    expect(runtime.events.find((event) => event.type === 'task-complete')?.detail).toContain('W1/S1/%12 完成 T1')
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
