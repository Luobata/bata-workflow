import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { dispatchPlan } from '../src/dispatcher/dispatcher.js'
import { buildPlan } from '../src/planner/planner.js'
import { loadRoleModelConfig } from '../src/role-model-config/loader.js'
import { applyFailurePolicies, loadFailurePolicyConfig } from '../src/runtime/failure-policy.js'
import { buildExecutionBatches } from '../src/runtime/scheduler.js'
import { buildRoleRegistry, loadRoles } from '../src/team/role-registry.js'

const roleModelConfigPath = resolve(import.meta.dirname, '../configs/role-models.yaml')
const rolesConfigPath = resolve(import.meta.dirname, '../configs/roles.yaml')
const failurePolicyConfigPath = resolve(import.meta.dirname, '../configs/failure-policies.yaml')

describe('planner and dispatcher', () => {
  it('为实现类目标生成 coding/testing/review 任务并分配模型', () => {
    const plan = applyFailurePolicies(
      buildPlan({ goal: '实现登录功能并补测试', teamName: 'default' }),
      loadFailurePolicyConfig(failurePolicyConfigPath)
    )
    const roles = loadRoles(rolesConfigPath)
    const registry = buildRoleRegistry(roles)
    const modelConfig = loadRoleModelConfig(roleModelConfigPath)
    const assignments = dispatchPlan(plan, registry, modelConfig)

    expect(plan.tasks.some((task) => task.taskType === 'coding')).toBe(true)
    expect(plan.tasks.some((task) => task.taskType === 'testing')).toBe(true)
    expect(assignments.find((item) => item.task.taskType === 'coding')?.modelResolution.model).toBe('gpt5.3-codex')
    expect(assignments.find((item) => item.task.taskType === 'planning')?.modelResolution.model).toBe('gpt5.4')
    expect(plan.tasks.find((task) => task.taskType === 'code-review')?.dependsOn).toEqual(['T2'])
    expect(plan.tasks.find((task) => task.taskType === 'testing')?.dependsOn).toEqual(['T2'])
    expect(plan.tasks.find((task) => task.taskType === 'coordination')?.dependsOn).toEqual(['T1', 'T2', 'T3', 'T4'])
    expect(plan.tasks.find((task) => task.taskType === 'coding')?.maxAttempts).toBe(2)
    expect(plan.tasks.find((task) => task.taskType === 'planning')?.maxAttempts).toBe(1)

    const batches = buildExecutionBatches(assignments)
    expect(batches).toEqual([
      { batchId: 'B1', taskIds: ['T1'] },
      { batchId: 'B2', taskIds: ['T2'] },
      { batchId: 'B3', taskIds: ['T3', 'T4'] },
      { batchId: 'B4', taskIds: ['T5'] }
    ])
  })
})
