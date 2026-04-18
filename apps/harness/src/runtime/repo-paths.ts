import { existsSync } from 'node:fs'
import { dirname, isAbsolute, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type HarnessRepoPaths = {
  appRoot: string
  repoRoot: string
  configRoot: string
  stateRoot: string
}

function isHarnessAppRoot(candidatePath: string): boolean {
  return existsSync(resolve(candidatePath, 'package.json')) && existsSync(resolve(candidatePath, 'configs'))
}

export function createHarnessRepoPaths(moduleUrl: string): HarnessRepoPaths {
  const moduleFilePath = fileURLToPath(moduleUrl)
  let currentDirectory = dirname(moduleFilePath)
  const { root } = parse(currentDirectory)

  while (true) {
    if (isHarnessAppRoot(currentDirectory)) {
      const appRoot = currentDirectory
      const repoRoot = resolve(appRoot, '..', '..')

      return {
        appRoot,
        repoRoot,
        configRoot: resolve(appRoot, 'configs'),
        stateRoot: resolve(repoRoot, '.harness', 'state')
      }
    }

    if (currentDirectory === root) {
      throw new Error(`Unable to resolve harness app root from ${moduleFilePath}`)
    }

    currentDirectory = dirname(currentDirectory)
  }
}

const { appRoot, repoRoot, configRoot, stateRoot } = createHarnessRepoPaths(import.meta.url)

export function getHarnessRepoPaths(): HarnessRepoPaths {
  return {
    appRoot,
    repoRoot,
    configRoot,
    stateRoot
  }
}

export function resolveHarnessConfigPath(...segments: string[]): string {
  return resolve(configRoot, ...segments)
}

export function resolveHarnessInputPath(
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
