#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { dispatchPlan } from '../dispatcher/dispatcher.js'
import { buildPlan } from '../planner/planner.js'
import { loadRoleModelConfig } from '../role-model-config/loader.js'
import { CocoCliAdapter, DryRunCocoAdapter } from '../runtime/coco-adapter.js'
import { applyFailurePolicies, loadFailurePolicyConfig } from '../runtime/failure-policy.js'
import { createRunDirectory, loadLatestRunPointer, persistPlan, persistRunReport } from '../runtime/state-store.js'
import { resumeRun } from '../runtime/recovery.js'
import { loadRoles, buildRoleRegistry } from '../team/role-registry.js'
import { loadRolePromptTemplates } from '../team/prompt-loader.js'
import { loadSkills } from '../team/skill-loader.js'
import { buildSkillRegistry } from '../team/skill-registry.js'
import { loadTeamCompositionRegistry } from '../team/team-composition-loader.js'
import { loadSlashCommandRegistry, resolveSlashCommand } from './slash-command-loader.js'
import { runGoal } from '../orchestrator/run-goal.js'
import { verifyAssignments, verifyRun } from '../verification/index.js'
import type { GoalTargetFile } from '../domain/types.js'

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const roleModelConfigPath = resolve(root, 'configs/role-models.yaml')
const rolesConfigPath = resolve(root, 'configs/roles.yaml')
const rolePromptConfigPath = resolve(root, 'configs/role-prompts.yaml')
const failurePolicyConfigPath = resolve(root, 'configs/failure-policies.yaml')
const skillsConfigPath = resolve(root, 'configs/skills.yaml')
const teamCompositionConfigPath = resolve(root, 'configs/team-compositions.yaml')
const slashCommandConfigPath = resolve(root, 'configs/slash-commands.yaml')
const stateRoot = resolve(root, '.harness/state')

function appendFlag(flags: Map<string, string>, key: string, value: string) {
  if (key === 'target' && flags.has(key)) {
    flags.set(key, `${flags.get(key)},${value}`)
    return
  }

  flags.set(key, value)
}

function parseFlags(args: string[]): { flags: Map<string, string>; positionals: string[] } {
  const flags = new Map<string, string>()
  const positionals: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (arg.startsWith('--')) {
      const flag = arg.slice(2)
      const separatorIndex = flag.indexOf('=')

      if (separatorIndex >= 0) {
        appendFlag(flags, flag.slice(0, separatorIndex), flag.slice(separatorIndex + 1))
        continue
      }

      const nextArg = args[index + 1]
      if (nextArg && !nextArg.startsWith('--')) {
        appendFlag(flags, flag, nextArg)
        index += 1
        continue
      }

      appendFlag(flags, flag, 'true')
    } else {
      positionals.push(arg)
    }
  }

  return { flags, positionals }
}

function readTargetFile(targetPath: string): GoalTargetFile {
  const resolvedPath = resolve(process.cwd(), targetPath)
  const raw = readFileSync(resolvedPath, 'utf8').trim()
  const content = raw.length > 2000 ? `${raw.slice(0, 2000)}\n...[truncated]` : raw

  return {
    path: resolvedPath,
    content
  }
}

function readTargetFiles(targetValue: string): GoalTargetFile[] {
  return targetValue
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((targetPath) => readTargetFile(targetPath))
}

async function main(): Promise<void> {
  const [, , rawCommand = 'plan', ...rawArgs] = process.argv
  const { flags: parsedFlags, positionals } = parseFlags(rawArgs)
  const slashCommandRegistry = loadSlashCommandRegistry(slashCommandConfigPath)
  const slashResolution = resolveSlashCommand(rawCommand, parsedFlags, slashCommandRegistry)
  const command = slashResolution?.command ?? rawCommand
  const flags = slashResolution?.flags ?? parsedFlags
  const goal = positionals.join(' ').trim()
  const targetFlag = flags.get('target')
  const targetFiles = targetFlag ? readTargetFiles(targetFlag) : []
  const effectiveGoal =
    goal ||
    (targetFiles.length === 1
      ? `基于目标文件 ${targetFiles[0]!.path} 执行`
      : targetFiles.length > 1
        ? `基于 ${targetFiles.length} 个目标文件执行`
        : '')

  if (!effectiveGoal && command !== 'resume') {
    throw new Error('请提供目标，或通过 --target todo.md / --target=a.md,b.md 指定目标文件')
  }

  const roles = loadRoles(rolesConfigPath)
  const roleRegistry = buildRoleRegistry(roles)
  const modelConfig = loadRoleModelConfig(roleModelConfigPath)
  const promptTemplates = loadRolePromptTemplates(rolePromptConfigPath)
  const failurePolicyConfig = loadFailurePolicyConfig(failurePolicyConfigPath)
  const skillRegistry = buildSkillRegistry(loadSkills(skillsConfigPath))
  const teamCompositionRegistry = loadTeamCompositionRegistry(teamCompositionConfigPath)
  const adapterKind = flags.get('adapter') ?? 'dry-run'
  const timeoutMs = Number(flags.get('timeoutMs') ?? '120000')
  const teamName = flags.get('teamName') ?? 'default'
  const compositionName = flags.get('composition')
  const maxConcurrencyFlag = flags.get('maxConcurrency')
  const allowedTools = (flags.get('allowedTools') ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)

  if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`timeoutMs 非法: ${flags.get('timeoutMs')}`)
  }

  if (maxConcurrencyFlag && (!Number.isInteger(Number(maxConcurrencyFlag)) || Number(maxConcurrencyFlag) <= 0)) {
    throw new Error(`maxConcurrency 非法: ${maxConcurrencyFlag}`)
  }

  const maxConcurrency = maxConcurrencyFlag ? Number(maxConcurrencyFlag) : undefined

  if (command === 'plan') {
    const plan = applyFailurePolicies(
      buildPlan({ goal: effectiveGoal, teamName, compositionName, targetFiles }, teamCompositionRegistry),
      failurePolicyConfig
    )
    const assignments = dispatchPlan(plan, roleRegistry, modelConfig, teamName)
    const { buildExecutionBatches } = await import('../runtime/scheduler.js')
    const batches = buildExecutionBatches(assignments)
    const verification = verifyAssignments(assignments)
    const persistedPlanPath = persistPlan(stateRoot, plan)
    process.stdout.write(JSON.stringify({ plan, assignments, batches, verification, persistedPlanPath }, null, 2))
    return
  }

  if (command === 'run') {
    const runDirectory = createRunDirectory(stateRoot, effectiveGoal)
    const adapter =
      adapterKind === 'coco-cli'
        ? new CocoCliAdapter({ timeoutMs, allowedTools, yolo: flags.get('yolo') === 'true', promptTemplates, skillRegistry })
        : new DryRunCocoAdapter()

    const report = await runGoal({
      input: { goal: effectiveGoal, teamName, compositionName, targetFiles },
      adapter,
      roleRegistry,
      modelConfig,
      failurePolicyConfig,
      teamCompositionRegistry,
      runDirectory,
      maxConcurrency: maxConcurrency ?? 2
    })
    const verification = verifyRun(report)
    const persisted = persistRunReport(stateRoot, report, runDirectory)
    process.stdout.write(JSON.stringify({ adapter: adapterKind, report, verification, persisted }, null, 2))
    return
  }

  if (command === 'resume') {
    const latestRun = loadLatestRunPointer(stateRoot)
    const reportPath = flags.get('reportPath') ?? latestRun?.reportPath
    const runDirectory = flags.get('runDirectory') ?? latestRun?.runDirectory

    if (!runDirectory && !reportPath) {
      throw new Error('未找到可恢复的运行，请先执行 run，或通过 --runDirectory/--reportPath 指定恢复目标')
    }

    const adapter =
      adapterKind === 'coco-cli'
        ? new CocoCliAdapter({ timeoutMs, allowedTools, yolo: flags.get('yolo') === 'true', promptTemplates, skillRegistry })
        : new DryRunCocoAdapter()
    const report = await resumeRun({
      adapter,
      runDirectory,
      reportPath,
      workerPool: maxConcurrency ? { maxConcurrency } : undefined
    })
    const verification = verifyRun(report)
    const persisted = persistRunReport(stateRoot, report, runDirectory ?? latestRun?.runDirectory)
    process.stdout.write(
      JSON.stringify(
        { adapter: adapterKind, resumedFrom: runDirectory ?? reportPath, report, verification, persisted },
        null,
        2
      )
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
