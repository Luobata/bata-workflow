import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { runGoal } from '../src/orchestrator/run-goal.js'
import { loadRoleModelConfig } from '../src/role-model-config/loader.js'
import { loadFailurePolicyConfig } from '../src/runtime/failure-policy.js'
import { DryRunCocoAdapter, type CocoAdapter } from '../src/runtime/coco-adapter.js'
import { buildRoleRegistry, loadRoles } from '../src/team/role-registry.js'
import { verifyRun } from '../src/verification/index.js'

const roleModelConfigPath = resolve(import.meta.dirname, '../configs/role-models.yaml')
const rolesConfigPath = resolve(import.meta.dirname, '../configs/roles.yaml')
const failurePolicyConfigPath = resolve(import.meta.dirname, '../configs/failure-policies.yaml')

describe('runGoal', () => {
  it('完成最小 dry-run 编排闭环', async () => {
    const report = await runGoal({
      input: { goal: '实现登录功能并补测试', teamName: 'default' },
      adapter: new DryRunCocoAdapter(),
      roleRegistry: buildRoleRegistry(loadRoles(rolesConfigPath)),
      modelConfig: loadRoleModelConfig(roleModelConfigPath),
      failurePolicyConfig: loadFailurePolicyConfig(failurePolicyConfigPath)
    })

    const verification = verifyRun(report)
    expect(report.results.length).toBe(report.plan.tasks.length)
    expect(report.batches).toHaveLength(4)
    expect(report.runtime.pendingTaskIds).toEqual([])
    expect(report.runtime.completedTaskIds).toEqual(['T1', 'T2', 'T3', 'T4', 'T5'])
    expect(report.runtime.events.some((event) => event.type === 'batch-start')).toBe(true)
    expect(report.runtime.workers.every((worker) => worker.lastHeartbeatAt)).toBe(true)
    expect(report.runtime.mailbox.length).toBeGreaterThan(0)
    expect(report.runtime.taskStates.every((taskState) => taskState.claimedBy === null)).toBe(true)
    expect(report.results.every((result) => result.status === 'completed')).toBe(true)
    expect(verification.ok).toBe(true)
  })

  it('失败任务会按 maxAttempts 重试并留下状态轨迹', async () => {
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
      failurePolicyConfig: loadFailurePolicyConfig(failurePolicyConfigPath)
    })

    expect(report.runtime.events.some((event) => event.type === 'task-retry' && event.taskId === 'T2')).toBe(true)
    expect(report.runtime.taskStates.find((taskState) => taskState.taskId === 'T2')?.attempts).toBe(2)
    expect(report.runtime.taskStates.every((taskState) => taskState.claimedBy === null)).toBe(true)
    expect(report.results.every((result) => result.status === 'completed')).toBe(true)
  })
})
