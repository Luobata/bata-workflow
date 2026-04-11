import { resolve } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { describe, expect, it } from 'vitest'

import { runGoal } from '../src/orchestrator/run-goal.js'
import { loadRoleModelConfig } from '../src/role-model-config/loader.js'
import { loadFailurePolicyConfig } from '../src/runtime/failure-policy.js'
import { DryRunCocoAdapter, type CocoAdapter } from '../src/runtime/coco-adapter.js'
import { buildRoleRegistry, loadRoles } from '../src/team/role-registry.js'
import { loadTeamCompositionRegistry } from '../src/team/team-composition-loader.js'
import { verifyRun } from '../src/verification/index.js'

const roleModelConfigPath = resolve(import.meta.dirname, '../configs/role-models.yaml')
const rolesConfigPath = resolve(import.meta.dirname, '../configs/roles.yaml')
const failurePolicyConfigPath = resolve(import.meta.dirname, '../configs/failure-policies.yaml')
const teamCompositionConfigPath = resolve(import.meta.dirname, '../configs/team-compositions.yaml')

describe('runGoal', () => {
  it('完成最小 dry-run 编排闭环', async () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-run-goal-'))
    const report = await runGoal({
      input: { goal: '实现登录功能并补测试', teamName: 'default' },
      adapter: new DryRunCocoAdapter(),
      roleRegistry: buildRoleRegistry(loadRoles(rolesConfigPath)),
      modelConfig: loadRoleModelConfig(roleModelConfigPath),
      failurePolicyConfig: loadFailurePolicyConfig(failurePolicyConfigPath),
      teamCompositionRegistry: loadTeamCompositionRegistry(teamCompositionConfigPath),
      runDirectory,
      maxConcurrency: 2
    })

    const verification = verifyRun(report)
    expect(report.results.length).toBe(report.plan.tasks.length)
    expect(report.batches).toHaveLength(4)
    expect(report.runtime.pendingTaskIds).toEqual([])
    expect(report.runtime.maxConcurrency).toBe(2)
    expect(report.runtime.completedTaskIds).toEqual(['T1', 'T2', 'T3', 'T4', 'T5'])
    expect(report.runtime.events.some((event) => event.type === 'batch-start')).toBe(true)
    expect(report.runtime.workers.every((worker) => worker.lastHeartbeatAt)).toBe(true)
    expect(report.runtime.workers).toHaveLength(2)
    expect(report.runtime.mailbox.length).toBeGreaterThan(0)
    expect(report.runtime.dynamicTaskStats.generatedTaskCount).toBe(0)
    expect(report.runtime.loopSummaries.some((summary) => summary.sourceTaskId === 'T4')).toBe(true)
    expect(report.runtime.taskStates.every((taskState) => taskState.claimedBy === null)).toBe(true)
    expect(report.results.every((result) => result.status === 'completed')).toBe(true)
    expect(report.summary.completedTaskCount).toBe(5)
    expect(report.summary.failedTaskCount).toBe(0)
    expect(report.summary.retryTaskCount).toBe(0)
    expect(verification.ok).toBe(true)
  })

  it('失败任务会按 maxAttempts 重试并留下状态轨迹', async () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-run-goal-retry-'))
    class RetryAdapter implements CocoAdapter {
      private codingAttempts = 0

      async execute({ assignment }) {
        if (assignment.task.taskType === 'coding') {
          this.codingAttempts += 1
          if (this.codingAttempts === 1) {
            return {
              taskId: assignment.task.id,
              role: assignment.roleDefinition.name,
              model: assignment.modelResolution.model,
              status: 'failed' as const,
              summary: 'first fail',
              attempt: 1
            }
          }
        }

        return {
          taskId: assignment.task.id,
          role: assignment.roleDefinition.name,
          model: assignment.modelResolution.model,
          status: 'completed' as const,
          summary: 'success',
          attempt: 1
        }
      }
    }

    const report = await runGoal({
      input: { goal: '实现登录功能并补测试', teamName: 'default' },
      adapter: new RetryAdapter(),
      roleRegistry: buildRoleRegistry(loadRoles(rolesConfigPath)),
      modelConfig: loadRoleModelConfig(roleModelConfigPath),
      failurePolicyConfig: loadFailurePolicyConfig(failurePolicyConfigPath),
      teamCompositionRegistry: loadTeamCompositionRegistry(teamCompositionConfigPath),
      runDirectory,
      maxConcurrency: 2
    })

    expect(report.runtime.events.some((event) => event.type === 'task-retry' && event.taskId === 'T2')).toBe(true)
    expect(report.runtime.taskStates.find((taskState) => taskState.taskId === 'T2')?.attempts).toBe(2)
    expect(report.runtime.taskStates.find((taskState) => taskState.taskId === 'T2')?.attemptHistory).toHaveLength(2)
    expect(report.runtime.taskStates.every((taskState) => taskState.claimedBy === null)).toBe(true)
    expect(report.results.every((result) => result.status === 'completed')).toBe(true)
    expect(report.summary.retryTaskCount).toBe(1)
  })

  it('失败策略可触发 fallback role 路由', async () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-run-goal-fallback-'))

    class FallbackAdapter implements CocoAdapter {
      async execute({ assignment }) {
        if (assignment.task.id === 'T2' && assignment.roleDefinition.name === 'coder') {
          return {
            taskId: assignment.task.id,
            role: assignment.roleDefinition.name,
            model: assignment.modelResolution.model,
            status: 'failed' as const,
            summary: 'implementation failed',
            attempt: 1
          }
        }

        return {
          taskId: assignment.task.id,
          role: assignment.roleDefinition.name,
          model: assignment.modelResolution.model,
          status: 'completed' as const,
          summary: `success by ${assignment.roleDefinition.name}`,
          attempt: 1
        }
      }
    }

    const report = await runGoal({
      input: { goal: '实现登录功能并补测试', teamName: 'default' },
      adapter: new FallbackAdapter(),
      roleRegistry: buildRoleRegistry(loadRoles(rolesConfigPath)),
      modelConfig: loadRoleModelConfig(roleModelConfigPath),
      failurePolicyConfig: loadFailurePolicyConfig(failurePolicyConfigPath),
      teamCompositionRegistry: loadTeamCompositionRegistry(teamCompositionConfigPath),
      runDirectory,
      maxConcurrency: 2
    })

    expect(report.runtime.events.some((event) => event.type === 'task-rerouted' && event.taskId === 'T2')).toBe(true)
    expect(report.results.find((result) => result.taskId === 'T2')?.role).toBe('reviewer')
    expect(report.results.find((result) => result.taskId === 'T2')?.summary).toContain('reviewer')
  })

  it('testing 失败会生成显式 fix/verify loop', async () => {
    const runDirectory = mkdtempSync(resolve(tmpdir(), 'harness-run-goal-fix-loop-'))

    class FixLoopAdapter implements CocoAdapter {
      private testingAttempts = 0

      async execute({ assignment }) {
        if (assignment.task.id === 'T4' && assignment.roleDefinition.name === 'tester' && assignment.task.generatedFromTaskId == null) {
          this.testingAttempts += 1
          if (this.testingAttempts === 1) {
            return {
              taskId: assignment.task.id,
              role: assignment.roleDefinition.name,
              model: assignment.modelResolution.model,
              status: 'failed' as const,
              summary: 'qa regression found',
              attempt: 1
            }
          }
        }

        return {
          taskId: assignment.task.id,
          role: assignment.roleDefinition.name,
          model: assignment.modelResolution.model,
          status: 'completed' as const,
          summary: `success by ${assignment.roleDefinition.name}`,
          attempt: 1
        }
      }
    }

    const report = await runGoal({
      input: { goal: '实现登录功能并补测试', teamName: 'default' },
      adapter: new FixLoopAdapter(),
      roleRegistry: buildRoleRegistry(loadRoles(rolesConfigPath)),
      modelConfig: loadRoleModelConfig(roleModelConfigPath),
      failurePolicyConfig: loadFailurePolicyConfig(failurePolicyConfigPath),
      teamCompositionRegistry: loadTeamCompositionRegistry(teamCompositionConfigPath),
      runDirectory,
      maxConcurrency: 2
    })

    expect(report.runtime.events.some((event) => event.type === 'task-generated' && event.taskId === 'T4_FIX_1')).toBe(true)
    expect(report.plan.tasks.some((task) => task.id === 'T4_FIX_1')).toBe(true)
    expect(report.runtime.dynamicTaskStats.generatedTaskCount).toBe(1)
    expect(report.runtime.dynamicTaskStats.generatedTaskIds).toContain('T4_FIX_1')
    expect(report.runtime.dynamicTaskStats.generatedTaskCountBySourceTaskId.T4).toBe(1)
    expect(report.runtime.loopSummaries.find((summary) => summary.sourceTaskId === 'T4')?.generatedTaskIds).toContain('T4_FIX_1')
    expect(report.results.find((result) => result.taskId === 'T4_FIX_1')?.role).toBe('coder')
    expect(report.results.find((result) => result.taskId === 'T4_FIX_1')?.model).toBe('gpt5.3-codex-remediation')
    expect(report.runtime.taskStates.find((taskState) => taskState.taskId === 'T4')?.attempts).toBe(2)
    expect(report.runtime.taskStates.find((taskState) => taskState.taskId === 'T4')?.status).toBe('completed')
    expect(report.summary.generatedTaskCount).toBe(1)
    expect(report.summary.loopCount).toBe(1)
    expect(report.summary.loopedSourceTaskIds).toEqual(['T4'])
  })
})
