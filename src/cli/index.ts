#!/usr/bin/env node
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dispatchPlan } from '../dispatcher/dispatcher.js'
import { buildPlan } from '../planner/planner.js'
import { loadRoleModelConfig } from '../role-model-config/loader.js'
import { CocoCliAdapter, DryRunCocoAdapter } from '../runtime/coco-adapter.js'
import { applyFailurePolicies, loadFailurePolicyConfig } from '../runtime/failure-policy.js'
import { loadLatestRunPointer, loadRunReport, persistPlan, persistRunReport } from '../runtime/state-store.js'
import { resumeRun } from '../runtime/recovery.js'
import { loadRoles, buildRoleRegistry } from '../team/role-registry.js'
import { loadRolePromptTemplates } from '../team/prompt-loader.js'
import { runGoal } from '../orchestrator/run-goal.js'
import { verifyAssignments, verifyRun } from '../verification/index.js'

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const roleModelConfigPath = resolve(root, 'configs/role-models.yaml')
const rolesConfigPath = resolve(root, 'configs/roles.yaml')
const rolePromptConfigPath = resolve(root, 'configs/role-prompts.yaml')
const failurePolicyConfigPath = resolve(root, 'configs/failure-policies.yaml')
const stateRoot = resolve(root, '.harness/state')

function parseFlags(args: string[]): { flags: Map<string, string>; positionals: string[] } {
  const flags = new Map<string, string>()
  const positionals: string[] = []

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, value = 'true'] = arg.slice(2).split('=')
      flags.set(key, value)
    } else {
      positionals.push(arg)
    }
  }

  return { flags, positionals }
}

async function main(): Promise<void> {
  const [, , command = 'plan', ...rawArgs] = process.argv
  const { flags, positionals } = parseFlags(rawArgs)
  const goal = positionals.join(' ').trim()

  if (!goal && command !== 'resume') {
    throw new Error('请提供目标，例如：pnpm plan "实现登录功能并补测试"')
  }

  const roles = loadRoles(rolesConfigPath)
  const roleRegistry = buildRoleRegistry(roles)
  const modelConfig = loadRoleModelConfig(roleModelConfigPath)
  const promptTemplates = loadRolePromptTemplates(rolePromptConfigPath)
  const failurePolicyConfig = loadFailurePolicyConfig(failurePolicyConfigPath)
  const adapterKind = flags.get('adapter') ?? 'dry-run'
  const timeoutMs = Number(flags.get('timeoutMs') ?? '120000')
  const allowedTools = (flags.get('allowedTools') ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  if (command === 'plan') {
    const plan = applyFailurePolicies(buildPlan({ goal, teamName: 'default' }), failurePolicyConfig)
    const assignments = dispatchPlan(plan, roleRegistry, modelConfig)
    const { buildExecutionBatches } = await import('../runtime/scheduler.js')
    const batches = buildExecutionBatches(assignments)
    const verification = verifyAssignments(assignments)
    const persistedPlanPath = persistPlan(stateRoot, plan)
    process.stdout.write(JSON.stringify({ plan, assignments, batches, verification, persistedPlanPath }, null, 2))
    return
  }

  if (command === 'run') {
    const adapter =
      adapterKind === 'coco-cli'
        ? new CocoCliAdapter({ timeoutMs, allowedTools, yolo: flags.get('yolo') === 'true', promptTemplates })
        : new DryRunCocoAdapter()

    const report = await runGoal({
      input: { goal, teamName: 'default' },
      adapter,
      roleRegistry,
      modelConfig,
      failurePolicyConfig
    })
    const verification = verifyRun(report)
    const persisted = persistRunReport(stateRoot, report)
    process.stdout.write(JSON.stringify({ adapter: adapterKind, report, verification, persisted }, null, 2))
    return
  }

  if (command === 'resume') {
    const latestRun = loadLatestRunPointer(stateRoot)
    const reportPath = flags.get('reportPath') ?? latestRun?.reportPath

    if (!reportPath) {
      throw new Error('未找到可恢复的运行，请先执行 run，或通过 --reportPath 指定报告路径')
    }

    const previousReport = loadRunReport(reportPath)
    const adapter =
      adapterKind === 'coco-cli'
        ? new CocoCliAdapter({ timeoutMs, allowedTools, yolo: flags.get('yolo') === 'true', promptTemplates })
        : new DryRunCocoAdapter()
    const report = await resumeRun({ previousReport, adapter })
    const verification = verifyRun(report)
    const persisted = persistRunReport(stateRoot, report, latestRun?.runDirectory)
    process.stdout.write(
      JSON.stringify({ adapter: adapterKind, resumedFrom: reportPath, report, verification, persisted }, null, 2)
    )
    return
  }

  throw new Error(`未知命令: ${command}`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
