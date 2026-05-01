import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it } from 'vitest'

const appRoot = resolve(import.meta.dirname, '..')
const repoRoot = resolve(appRoot, '..', '..')
const cliPath = resolve(appRoot, 'src/cli/index.ts')
const tsxCliPath = resolve(appRoot, 'node_modules/tsx/dist/cli.mjs')

function createSkillCliSandbox() {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'bata-workflow-ralph-home-'))
  const stateRoot = resolve(homeDirectory, '.bata-workflow-test', 'state')
  const skillPacksRoot = resolve(homeDirectory, '.bata-workflow-test', 'skill-packs')

  return {
    homeDirectory,
    stateRoot,
    skillStateRoot: resolve(stateRoot, 'skills'),
    skillPacksRoot,
  }
}

function sanitizeChildProcessEnv(envOverrides: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env }

  for (const key of Object.keys(env)) {
    if (key.startsWith('COCO_') || key.startsWith('BATA_WORKFLOW_')) {
      delete env[key]
    }
  }

  return {
    ...env,
    ...envOverrides,
  }
}

function runSkillCli(args: string[], homeDirectory: string, envOverrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [tsxCliPath, cliPath, 'skill', ...args], {
    cwd: appRoot,
    encoding: 'utf8',
    env: sanitizeChildProcessEnv({
      HOME: homeDirectory,
      USERPROFILE: homeDirectory,
      ...envOverrides,
    }),
  })
}

let installedRalphImportSequence = 0

async function runInstalledRalph(
  installPath: string,
  options: Record<string, unknown>,
) {
  try {
    const runtimeModulePath = resolve(installPath, 'runtime', 'invoke-ralph.mjs')
    const runtimeModuleUrl = `${pathToFileURL(runtimeModulePath).href}?testImport=${installedRalphImportSequence += 1}`
    const runtimeModule = (await import(runtimeModuleUrl)) as {
      invokeRalph: (input?: Record<string, unknown>) => Promise<unknown>
    }

    const result = await runtimeModule.invokeRalph(options)
    return {
      status: 0,
      stdout: `${JSON.stringify(result)}\n`,
      stderr: '',
    }
  } catch (error) {
    return {
      status: 1,
      stdout: '',
      stderr: `${error instanceof Error ? error.message : String(error)}\n`,
    }
  }
}

function runInstalledRalphCli(installPath: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const runtimePath = resolve(installPath, 'runtime', 'invoke-ralph.mjs')
  return spawnSync(process.execPath, [runtimePath, ...args], {
    cwd: appRoot,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      ...env,
    },
  })
}

describe('ralph skill install e2e', () => {
  it('supports linked -> published-local runtime continuity with resume and .ralph persistence', async () => {
    const sandbox = createSkillCliSandbox()
    const installName = 'ralph'
    const installPath = resolve(sandbox.homeDirectory, '.coco', 'skills', installName)
    const statePath = resolve(sandbox.skillStateRoot, `${installName}.json`)
    const packOutputDirectory = resolve(sandbox.skillPacksRoot, installName, '0.1.0')
    const workspacePath = mkdtempSync(join(tmpdir(), 'ralph-workspace-'))
    const cliEnv = {
      BATA_WORKFLOW_STATE_ROOT: sandbox.stateRoot,
      BATA_WORKFLOW_SKILL_PACKS_ROOT: sandbox.skillPacksRoot,
    }

    const cleanup = () => {
      rmSync(installPath, { recursive: true, force: true })
      rmSync(statePath, { recursive: true, force: true })
      rmSync(packOutputDirectory, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(sandbox.homeDirectory, { recursive: true, force: true })
    }

    cleanup()

    try {
      const validateResult = runSkillCli(['validate', 'ralph'], sandbox.homeDirectory, cliEnv)
      expect(validateResult.status).toBe(0)
      expect(validateResult.stdout).toContain('Validated skill: ralph@0.1.0')
      expect(validateResult.stdout).toContain(`Skill Root: ${resolve(repoRoot, 'skills', 'ralph')}`)

      const linkResult = runSkillCli(['link', 'ralph'], sandbox.homeDirectory, cliEnv)
      expect(linkResult.status).toBe(0)
      expect(lstatSync(installPath).isSymbolicLink()).toBe(true)
      expect(existsSync(resolve(installPath, 'runtime', 'invoke-ralph.mjs'))).toBe(true)

      let interrupted = false
      const linkedRuntimeResult = await runInstalledRalph(installPath, {
        cwd: workspacePath,
        goal: '实现接口与测试',
        mode: 'independent',
        todoBuilder: () => [
          { id: 'task-1', title: '子任务1: 实现接口', status: 'pending', reviewRounds: 0, lastAdvicePath: null, history: [] },
          { id: 'task-2', title: '子任务2: 补充测试', status: 'pending', reviewRounds: 0, lastAdvicePath: null, history: [] },
        ],
        runAgent: async ({ role, prompt }: { role: string; prompt: string }) => {
          if (!interrupted && role === 'coding' && prompt.includes('子任务2')) {
            interrupted = true
            throw new Error('network dropped during linked run')
          }

          return {
            stdout: JSON.stringify({ status: 'completed', summary: `${role} linked`, suggestions: [] }),
            stderr: '',
          }
        },
      })

      expect(linkedRuntimeResult.status).toBe(0)
      const linkedRuntimeJson = JSON.parse(linkedRuntimeResult.stdout) as { summary: string }
      expect(linkedRuntimeJson.summary).toContain('blocked=1')

      const linkedCliRun = runInstalledRalphCli(
        installPath,
        ['--cwd', workspacePath, '--goal', '验证安装态入口可直接输出', '--output', 'json', '--stubAgent', '--dryRunPlan'],
        { RALPH_STUB_AGENT: '1' },
      )
      expect(linkedCliRun.status).toBe(0)
      const linkedCliPayload = JSON.parse(linkedCliRun.stdout) as { kind: string; dryRunPlan: boolean }
      expect(linkedCliPayload.kind).toBe('plan')
      expect(linkedCliPayload.dryRunPlan).toBe(true)

      const publishResult = runSkillCli(['publish-local', 'ralph'], sandbox.homeDirectory, cliEnv)
      expect(publishResult.status).toBe(0)
      expect(lstatSync(installPath).isDirectory()).toBe(true)
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
        cocoInstallName: 'ralph',
        mode: 'published-local',
      })

      const resumedRuntimeResult = await runInstalledRalph(installPath, {
        cwd: workspacePath,
        mode: 'subagent',
        resume: true,
        runAgent: async ({ role }: { role: string }) => ({
          stdout: JSON.stringify({ status: 'completed', summary: `${role} resumed`, suggestions: [] }),
          stderr: '',
        }),
      })

      expect(resumedRuntimeResult.status).toBe(0)
      const resumedRuntimeJson = JSON.parse(resumedRuntimeResult.stdout) as {
        kind: string
        summary: string
        tasks: Array<{ status: string }>
      }
      expect(resumedRuntimeJson.kind).toBe('resume')
      expect(resumedRuntimeJson.summary).toContain('blocked=0')
      expect(resumedRuntimeJson.tasks.every((task) => task.status === 'done')).toBe(true)
      const reviewDirectory = resolve(workspacePath, '.ralph', 'reviews')
      expect(existsSync(reviewDirectory)).toBe(true)
      const adviceFiles = readdirSync(reviewDirectory).filter((name) => name.endsWith('.advice.md'))
      expect(adviceFiles.length).toBeGreaterThan(0)
    } finally {
      cleanup()
    }
  })
})
