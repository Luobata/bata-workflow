#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
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
const MAX_TARGET_FILE_CHARS = 4000
const TARGET_TEXT_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.mdx', '.txt', '.yaml', '.yml', '.json'])
const IGNORED_TARGET_DIRECTORIES = new Set(['.git', '.harness', 'node_modules', 'dist', 'build', 'coverage'])

function appendFlag(flags: Map<string, string>, key: string, value: string) {
  if ((key === 'target' || key === 'dir') && flags.has(key)) {
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
    const prefix = arg.startsWith('--') ? '--' : arg.startsWith('-') && arg.length > 1 ? '-' : ''

    if (prefix) {
      const flag = arg.slice(prefix.length)
      const separatorIndex = flag.indexOf('=')

      if (separatorIndex >= 0) {
        appendFlag(flags, flag.slice(0, separatorIndex), flag.slice(separatorIndex + 1))
        continue
      }

      const nextArg = args[index + 1]
      if (nextArg && !nextArg.startsWith('-')) {
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

function normalizeTargetContent(raw: string): string {
  const trimmed = raw.trim()
  return trimmed.length > MAX_TARGET_FILE_CHARS ? `${trimmed.slice(0, MAX_TARGET_FILE_CHARS)}\n...[truncated]` : trimmed
}

function readTargetFileAtPath(resolvedPath: string): GoalTargetFile {
  const raw = readFileSync(resolvedPath, 'utf8').trim()

  return {
    path: resolvedPath,
    content: normalizeTargetContent(raw)
  }
}

function readTargetFile(targetPath: string): GoalTargetFile {
  return readTargetFileAtPath(resolve(process.cwd(), targetPath))
}

function splitFlagValues(rawValue: string): string[] {
  return rawValue
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function readTargetFiles(targetValue: string): GoalTargetFile[] {
  return splitFlagValues(targetValue).map((targetPath) => readTargetFile(targetPath))
}

function shouldIgnoreDirectoryEntry(name: string, isDirectory: boolean): boolean {
  return isDirectory && IGNORED_TARGET_DIRECTORIES.has(name)
}

function isSupportedTargetFile(filePath: string): boolean {
  return TARGET_TEXT_FILE_EXTENSIONS.has(extname(filePath).toLowerCase())
}

function collectDirectoryFiles(directoryPath: string): string[] {
  const entries = readdirSync(directoryPath, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'))

  return entries.flatMap((entry) => {
    if (shouldIgnoreDirectoryEntry(entry.name, entry.isDirectory())) {
      return []
    }

    const resolvedPath = resolve(directoryPath, entry.name)

    if (entry.isDirectory()) {
      return collectDirectoryFiles(resolvedPath)
    }

    if (entry.isFile()) {
      if (!isSupportedTargetFile(resolvedPath)) {
        return []
      }

      return [resolvedPath]
    }

    return []
  })
}

function readTargetDirectories(dirValue: string): GoalTargetFile[] {
  return splitFlagValues(dirValue).flatMap((directoryPath) => collectDirectoryFiles(resolve(process.cwd(), directoryPath))).map((filePath) => readTargetFileAtPath(filePath))
}

function mergeTargetFiles(...groups: GoalTargetFile[][]): GoalTargetFile[] {
  const deduped = new Map<string, GoalTargetFile>()

  for (const group of groups) {
    for (const targetFile of group) {
      if (!deduped.has(targetFile.path)) {
        deduped.set(targetFile.path, targetFile)
      }
    }
  }

  return Array.from(deduped.values())
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
  const dirFlag = flags.get('dir')
  const targetFiles = mergeTargetFiles(targetFlag ? readTargetFiles(targetFlag) : [], dirFlag ? readTargetDirectories(dirFlag) : [])
  const effectiveGoal =
    goal ||
    (targetFiles.length === 1
      ? `基于目标文件 ${targetFiles[0]!.path} 执行`
      : targetFiles.length > 1
        ? `基于 ${targetFiles.length} 个目标文件执行`
        : '')

  if (command === 'watch') {
    const { runWatchTui } = await import('../tui/watch.js')
    await runWatchTui({
      stateRoot,
      runDirectory: flags.get('runDirectory'),
      reportPath: flags.get('reportPath')
    })
    return
  }

  if (!effectiveGoal && command !== 'resume') {
    throw new Error('请提供目标，或通过 -target todo.md / -target=a.md,b.md / -dir docs 指定目标输入')
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
