import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

const appRoot = resolve(import.meta.dirname, '..')
const repoRoot = resolve(appRoot, '..', '..')
const roleModelConfigPath = resolve(appRoot, 'configs/role-models.yaml')
const rolesConfigPath = resolve(appRoot, 'configs/roles.yaml')
const failurePolicyConfigPath = resolve(appRoot, 'configs/failure-policies.yaml')
const teamCompositionConfigPath = resolve(appRoot, 'configs/team-compositions.yaml')
const cliPath = resolve(appRoot, 'src/cli/index.ts')
const tsxCliPath = resolve(appRoot, 'node_modules/tsx/dist/cli.mjs')

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

  it('支持基于方案文档与 todo 拆出更细粒度的推进任务', () => {
    const plan = buildPlan(
      {
        goal: '',
        teamName: 'default',
        targetFiles: [
          {
            path: '/tmp/design.md',
            content: ['# 登录改造方案', '## 核心任务', '- [ ] 梳理现有登录链路与风险', '- [ ] 实现统一认证中间件', '- [ ] 补充登录回归测试'].join('\n')
          }
        ]
      },
      loadTeamCompositionRegistry(teamCompositionConfigPath)
    )

    expect(plan.tasks.length).toBeGreaterThan(5)
    expect(plan.tasks.some((task) => task.title.includes('梳理现有登录链路与风险'))).toBe(true)
    expect(plan.tasks.some((task) => task.title.includes('实现统一认证中间件'))).toBe(true)
    expect(plan.tasks.some((task) => task.title.includes('补充登录回归测试'))).toBe(true)
  })

  it('显式 composition 时不会被文档拆解扩展出额外 taskType', () => {
    const plan = buildPlan(
      {
        goal: '',
        teamName: 'default',
        compositionName: 'research-only',
        targetFiles: [
          {
            path: '/tmp/design.md',
            content: ['# 登录改造方案', '## 核心任务', '- [ ] 梳理现有登录链路与风险', '- [ ] 实现统一认证中间件', '- [ ] 补充登录回归测试'].join('\n')
          }
        ]
      },
      loadTeamCompositionRegistry(teamCompositionConfigPath)
    )

    expect(plan.tasks.map((task) => task.taskType)).toEqual(['planning', 'research', 'coordination'])
  })

  it('支持通过 -dir 与 -target 组合读取目录和文件目标', () => {
    const workspace = mkdtempSync(resolve(tmpdir(), 'harness-cli-'))
    const targetDirectory = resolve(workspace, 'targets')
    const nestedDirectory = resolve(targetDirectory, 'nested')
    const hiddenDirectory = resolve(targetDirectory, '.hidden-dir')
    const explicitTarget = resolve(workspace, 'manual.md')
    const todoTarget = resolve(targetDirectory, 'todo.md')
    const specTarget = resolve(nestedDirectory, 'spec.md')
    const hiddenTarget = resolve(hiddenDirectory, 'notes.md')
    const ignoredBinary = resolve(targetDirectory, 'diagram.png')
    const ignoredLog = resolve(targetDirectory, 'debug.log')

    mkdirSync(nestedDirectory, { recursive: true })
    mkdirSync(hiddenDirectory, { recursive: true })
    writeFileSync(todoTarget, '实现登录功能\n补充测试', 'utf8')
    writeFileSync(specTarget, '先调研现有登录架构', 'utf8')
    writeFileSync(hiddenTarget, '记录隐藏目录中的约束说明', 'utf8')
    writeFileSync(explicitTarget, '补充代码审查步骤', 'utf8')
    writeFileSync(ignoredBinary, 'PNGDATA', 'utf8')
    writeFileSync(ignoredLog, 'debug info', 'utf8')

    const result = spawnSync(process.execPath, [tsxCliPath, cliPath, 'plan', '-dir', targetDirectory, '-target', explicitTarget], {
      cwd: repoRoot,
      encoding: 'utf8'
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')

    const output = JSON.parse(result.stdout) as {
      plan: {
        goal: string
        summary: string
        tasks: Array<{ description: string }>
      }
    }

    expect(output.plan.goal).toBe('基于 4 个目标文件执行')
    expect(output.plan.summary).toContain('4 个参考文件')
    expect(output.plan.tasks[0]?.description).toContain(`参考文件 1: ${explicitTarget}`)
    expect(output.plan.tasks[0]?.description).toContain(`参考文件 2: ${hiddenTarget}`)
    expect(output.plan.tasks[0]?.description).toContain(`参考文件 3: ${resolve(targetDirectory, 'nested/spec.md')}`)
    expect(output.plan.tasks[0]?.description).toContain(`参考文件 4: ${todoTarget}`)
    expect(output.plan.tasks[0]?.description).not.toContain(ignoredBinary)
    expect(output.plan.tasks[0]?.description).not.toContain(ignoredLog)
    expect(output.plan.tasks[0]?.description).toContain('记录隐藏目录中的约束说明')
    expect(output.plan.tasks[0]?.description).toContain('先调研现有登录架构')
    expect(output.plan.tasks[0]?.description).toContain('补充代码审查步骤')
  })

  it('run 启动时输出运行目录与 watch 提示', () => {
    const result = spawnSync(process.execPath, [tsxCliPath, cliPath, 'run', '梳理登录链路现状'], {
      cwd: repoRoot,
      encoding: 'utf8'
    })

    expect(result.status).toBe(0)
    expect(result.stderr).toContain('[harness] runDirectory:')
    expect(result.stderr).toContain('[harness] queuePath:')
    expect(result.stderr).toContain('watch --runDirectory')
  })

  it('run 默认只输出关键信息摘要而不是完整 report JSON', () => {
    const result = spawnSync(process.execPath, [tsxCliPath, cliPath, 'run', '梳理登录链路现状'], {
      cwd: repoRoot,
      encoding: 'utf8'
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Goal: 梳理登录链路现状')
    expect(result.stdout).toContain('Status: COMPLETED')
    expect(result.stdout).toContain('Tasks:')
    expect(result.stdout).toContain('Summary:')
    expect(result.stdout).not.toContain('"report"')
    expect(result.stdout).not.toContain('"runtime"')
  })

  it('harness 脚本默认显式使用 coco-auto adapter', () => {
    const packageJson = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }

    expect(packageJson.scripts?.harness).toContain('--adapter coco-auto')
  })
})
