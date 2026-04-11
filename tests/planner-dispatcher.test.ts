import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { dispatchPlan } from '../src/dispatcher/dispatcher.js'
import { buildPlan } from '../src/planner/planner.js'
import { loadRoleModelConfig } from '../src/role-model-config/loader.js'
import { applyFailurePolicies, loadFailurePolicyConfig } from '../src/runtime/failure-policy.js'
import { buildExecutionBatches } from '../src/runtime/scheduler.js'
import { buildRoleRegistry, loadRoles } from '../src/team/role-registry.js'
import { loadTeamCompositionRegistry } from '../src/team/team-composition-loader.js'
import { verifyAssignments } from '../src/verification/index.js'

const roleModelConfigPath = resolve(import.meta.dirname, '../configs/role-models.yaml')
const rolesConfigPath = resolve(import.meta.dirname, '../configs/roles.yaml')
const failurePolicyConfigPath = resolve(import.meta.dirname, '../configs/failure-policies.yaml')
const teamCompositionConfigPath = resolve(import.meta.dirname, '../configs/team-compositions.yaml')

describe('planner and dispatcher', () => {
  it('为实现类目标生成 coding/testing/review 任务并分配模型', () => {
    const plan = applyFailurePolicies(
      buildPlan({ goal: '实现登录功能并补测试', teamName: 'default' }, loadTeamCompositionRegistry(teamCompositionConfigPath)),
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
    expect(plan.tasks.find((task) => task.taskType === 'coding')?.failurePolicy?.fallbackRole).toBe('reviewer')
    expect(plan.tasks.find((task) => task.taskType === 'testing')?.failurePolicy?.fixVerifyLoop?.enabled).toBe(true)
    expect(plan.tasks.find((task) => task.taskType === 'testing')?.failurePolicy?.fixVerifyLoop?.maxRounds).toBe(2)
    expect(plan.tasks.find((task) => task.taskType === 'code-review')?.maxAttempts).toBe(1)
    expect(plan.tasks.find((task) => task.taskType === 'planning')?.maxAttempts).toBe(1)
    expect(assignments.find((item) => item.task.taskType === 'coding')?.fallback?.roleDefinition.name).toBe('reviewer')
    expect(assignments.find((item) => item.task.taskType === 'testing')?.fallback?.roleDefinition.name).toBe('reviewer')
    expect(assignments.find((item) => item.task.taskType === 'testing')?.remediation?.roleDefinition.name).toBe('coder')
    expect(assignments.find((item) => item.task.taskType === 'testing')?.remediation?.taskType).toBe('coding')
    expect(assignments.find((item) => item.task.taskType === 'testing')?.remediation?.skills).toEqual(['implementation'])
    expect(assignments.find((item) => item.task.taskType === 'testing')?.remediation?.modelResolution.source).toBe('remediation')
    expect(assignments.find((item) => item.task.taskType === 'testing')?.remediation?.modelResolution.model).toBe('gpt5.3-codex-remediation')

    const batches = buildExecutionBatches(assignments)
    expect(batches).toEqual([
      { batchId: 'B1', taskIds: ['T1'] },
      { batchId: 'B2', taskIds: ['T2'] },
      { batchId: 'B3', taskIds: ['T3', 'T4'] },
      { batchId: 'B4', taskIds: ['T5'] }
    ])
  })

  it('支持显式选择 research-only composition', () => {
    const roles = loadRoles(rolesConfigPath)
    const registry = buildRoleRegistry(roles)
    const modelConfig = loadRoleModelConfig(roleModelConfigPath)
    const plan = buildPlan(
      { goal: '梳理登录链路现状', teamName: 'default', compositionName: 'research-only' },
      loadTeamCompositionRegistry(teamCompositionConfigPath)
    )
    const assignments = dispatchPlan(plan, registry, modelConfig)
    const verification = verifyAssignments(assignments)

    expect(plan.tasks.map((task) => task.taskType)).toEqual(['planning', 'research', 'coordination'])
    expect(plan.tasks.find((task) => task.taskType === 'coordination')?.dependsOn).toEqual(['T1', 'T2'])
    expect(verification.ok).toBe(true)
  })

  it('支持通过 target 文件驱动规划并注入任务描述', () => {
    const plan = buildPlan(
      {
        goal: '',
        teamName: 'default',
        targetFiles: [
          {
            path: '/tmp/todo.md',
            content: '实现登录功能\n补充测试\n做代码审查'
          }
        ]
      },
      loadTeamCompositionRegistry(teamCompositionConfigPath)
    )

    expect(plan.goal).toBe('基于目标文件 /tmp/todo.md 执行')
    expect(plan.tasks.map((task) => task.taskType)).toEqual(['planning', 'coding', 'code-review', 'testing', 'coordination'])
    expect(plan.tasks[0]?.description).toContain('参考文件: /tmp/todo.md')
    expect(plan.tasks[0]?.description).toContain('实现登录功能')
  })

  it('支持多个 target 文件共同驱动规划', () => {
    const plan = buildPlan(
      {
        goal: '',
        teamName: 'default',
        targetFiles: [
          {
            path: '/tmp/architecture.md',
            content: '需要先调研现有登录架构'
          },
          {
            path: '/tmp/todo.md',
            content: '实现登录功能\n补充测试'
          }
        ]
      },
      loadTeamCompositionRegistry(teamCompositionConfigPath)
    )

    expect(plan.goal).toBe('基于 2 个目标文件执行')
    expect(plan.summary).toContain('2 个参考文件')
    expect(plan.tasks.map((task) => task.taskType)).toEqual(['planning', 'research', 'coding', 'code-review', 'testing', 'coordination'])
    expect(plan.tasks[0]?.description).toContain('参考文件 1: /tmp/architecture.md')
    expect(plan.tasks[0]?.description).toContain('参考文件 2: /tmp/todo.md')
  })
})
