import { existsSync } from 'node:fs'
import { dirname, isAbsolute, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type BataWorkflowRepoPaths = {
  appRoot: string
  repoRoot: string
  configRoot: string
  skillsRoot: string
  skillPacksRoot: string
  stateRoot: string
  skillStateRoot: string
}

function isBataWorkflowAppRoot(candidatePath: string): boolean {
  return existsSync(resolve(candidatePath, 'package.json')) && existsSync(resolve(candidatePath, 'configs'))
}

function resolveRootOverride(envVarName: 'BATA_WORKFLOW_SKILL_PACKS_ROOT' | 'BATA_WORKFLOW_STATE_ROOT', fallbackPath: string): string {
  const rawOverride = process.env[envVarName]?.trim()
  if (!rawOverride) {
    return fallbackPath
  }

  if (!isAbsolute(rawOverride)) {
    throw new Error(`${envVarName} must be an absolute path: ${rawOverride}`)
  }

  return rawOverride
}

export function createBataWorkflowRepoPaths(moduleUrl: string): BataWorkflowRepoPaths {
  const moduleFilePath = fileURLToPath(moduleUrl)
  let currentDirectory = dirname(moduleFilePath)
  const { root } = parse(currentDirectory)

  while (true) {
    if (isBataWorkflowAppRoot(currentDirectory)) {
      const appRoot = currentDirectory
      const repoRoot = resolve(appRoot, '..', '..')
      const stateRoot = resolveRootOverride('BATA_WORKFLOW_STATE_ROOT', resolve(repoRoot, '.bata-workflow', 'state'))

      return {
        appRoot,
        repoRoot,
        configRoot: resolve(appRoot, 'configs'),
        skillsRoot: resolve(repoRoot, 'skills'),
        skillPacksRoot: resolveRootOverride('BATA_WORKFLOW_SKILL_PACKS_ROOT', resolve(repoRoot, '.bata-workflow', 'skill-packs')),
        stateRoot,
        skillStateRoot: resolve(stateRoot, 'skills')
      }
    }

    if (currentDirectory === root) {
      throw new Error(`Unable to resolve bata-workflow app root from ${moduleFilePath}`)
    }

    currentDirectory = dirname(currentDirectory)
  }
}

const { appRoot, repoRoot, configRoot, skillsRoot, skillPacksRoot, stateRoot, skillStateRoot } =
  createBataWorkflowRepoPaths(import.meta.url)

export function getBataWorkflowRepoPaths(): BataWorkflowRepoPaths {
  return {
    appRoot,
    repoRoot,
    configRoot,
    skillsRoot,
    skillPacksRoot,
    stateRoot,
    skillStateRoot
  }
}

export function resolveBataWorkflowConfigPath(...segments: string[]): string {
  return resolve(configRoot, ...segments)
}

export function resolveBataWorkflowInputPath(
  inputPath: string,
  options: {
    cwd?: string
    repoRoot?: string
  } = {}
): string {
  if (isAbsolute(inputPath)) {
    return inputPath
  }

  const effectiveCwd = options.cwd ?? process.cwd()
  const effectiveRepoRoot = options.repoRoot ?? repoRoot
  const cwdResolvedPath = resolve(effectiveCwd, inputPath)
  if (existsSync(cwdResolvedPath)) {
    return cwdResolvedPath
  }

  return resolve(effectiveRepoRoot, inputPath)
}
