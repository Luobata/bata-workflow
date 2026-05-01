import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

import { dispatchSkillCommand } from '../src/cli/skill-command.js'

const appRoot = resolve(import.meta.dirname, '..')
const repoRoot = resolve(appRoot, '..', '..')
const cliPath = resolve(appRoot, 'src/cli/index.ts')
const tsxCliPath = resolve(appRoot, 'node_modules/tsx/dist/cli.mjs')

function createSkillCliSandbox() {
  const homeDirectory = mkdtempSync(join(tmpdir(), 'bata-workflow-skill-home-'))
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

function deriveWorkspaceSessionId(workspacePath: string) {
  return `workspace-${createHash('sha1').update(workspacePath).digest('hex').slice(0, 12)}`
}

let installedMonitorImportSequence = 0

async function runInstalledMonitor(
  installPath: string,
  workspacePath: string,
  homeDirectory: string,
  envOverrides: NodeJS.ProcessEnv = {},
) {
  void envOverrides

  try {
    const runtimeModulePath = resolve(installPath, 'runtime', 'invoke-monitor.mjs')
    const runtimeModuleUrl = `${pathToFileURL(runtimeModulePath).href}?testImport=${installedMonitorImportSequence += 1}`
    const runtimeModule = (await import(runtimeModuleUrl)) as {
      invokeMonitor: (options?: Record<string, unknown>) => Promise<MonitorRuntimeOutput>
    }
    const result = await runtimeModule.invokeMonitor({
      cwd: workspacePath,
      homeDir: homeDirectory,
      requesterActorId: 'lead',
      isRootActor: true,
      rootSessionId: deriveWorkspaceSessionId(workspacePath),
    })

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

type MonitorRuntimeOutput = {
  kind: string
  monitorSessionId: string
  requesterActorId: string
  isRootActor: boolean
  board: {
    status: string
    url: string | null
    port: number
    pid: number | null
    message: string
  }
}

function parseMonitorRuntimeOutput(stdout: string): MonitorRuntimeOutput {
  return JSON.parse(stdout) as MonitorRuntimeOutput
}

async function createReusableMonitorBoardBataWorkflow() {
  let pseudoRepoRoot: string | null = null
  let workspacePath: string | null = null
  let server: ReturnType<typeof createServer> | null = null

  const cleanup = async () => {
    if (server?.listening) {
      await new Promise<void>((resolvePromise, reject) => {
        server?.close((error) => {
          if (error) {
            reject(error)
            return
          }

          resolvePromise()
        })
      })
    }

    if (pseudoRepoRoot) {
      rmSync(pseudoRepoRoot, { recursive: true, force: true })
    }
  }

  try {
    pseudoRepoRoot = mkdtempSync(join(tmpdir(), 'monitor-board-test-root-'))

    const boardAppRoot = resolve(pseudoRepoRoot, 'apps', 'monitor-board')
    const workspacesRoot = resolve(pseudoRepoRoot, 'tmp-workspaces')
    const runtimeStateDirectory = resolve(pseudoRepoRoot, '.bata-workflow', 'state', 'monitor-board')
    const runtimeStatePath = resolve(runtimeStateDirectory, 'runtime.json')

    mkdirSync(boardAppRoot, { recursive: true })
    mkdirSync(workspacesRoot, { recursive: true })
    writeFileSync(
      resolve(boardAppRoot, 'package.json'),
      `${JSON.stringify({
        name: '@tests/monitor-board',
        private: true,
      }, null, 2)}\n`,
      'utf8',
    )

    workspacePath = mkdtempSync(join(workspacesRoot, 'workspace-'))
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end('<html><head><title>Monitor Board</title></head><body>Monitor Board</body></html>')
    })

    const port = await new Promise<number>((resolvePromise, reject) => {
      server?.once('error', reject)
      server?.listen(0, '127.0.0.1', () => {
        server?.removeListener('error', reject)
        const address = server?.address()
        if (!address || typeof address === 'string') {
          reject(new Error('monitor board test server did not expose a TCP port'))
          return
        }

        resolvePromise(address.port)
      })
    })

    mkdirSync(runtimeStateDirectory, { recursive: true })
    writeFileSync(
      runtimeStatePath,
      `${JSON.stringify(
        {
          pid: process.pid,
          port,
          host: '127.0.0.1',
          url: `http://127.0.0.1:${port}`,
          startedAt: new Date().toISOString(),
          repoRoot: pseudoRepoRoot,
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    return {
      port,
      repoRoot: pseudoRepoRoot,
      runtimeStatePath,
      workspacePath,
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

function expectReusableBoard(result: MonitorRuntimeOutput, expectedPort: number) {
  expect(result.board.status).toBe('reused')
  expect(result.board.port).toBe(expectedPort)
  expect(result.board.url).toContain(`http://127.0.0.1:${expectedPort}/`)
  expect(result.board.url).toContain(`monitorSessionId=${encodeURIComponent(result.monitorSessionId)}`)
  expect(typeof result.board.message).toBe('string')
  expect(result.board.message.length).toBeGreaterThan(0)
}

function createHandlers() {
  return {
    validate: vi.fn(async () => {}),
    pack: vi.fn(async () => {}),
    link: vi.fn(async () => {}),
    unlink: vi.fn(async () => {}),
    publishLocal: vi.fn(async () => {}),
    status: vi.fn(async () => {}),
    doctor: vi.fn(async () => {}),
  }
}

describe('skill command', () => {
  it('validate 子命令会携带 skill 名称分发', async () => {
    const handlers = createHandlers()

    await dispatchSkillCommand(['validate', 'demo-skill'], handlers)

    expect(handlers.validate).toHaveBeenCalledWith({ skillName: 'demo-skill' })
    expect(handlers.pack).not.toHaveBeenCalled()
    expect(handlers.doctor).not.toHaveBeenCalled()
  })

  it('doctor --fix 会以 fix=true 分发', async () => {
    const handlers = createHandlers()

    await dispatchSkillCommand(['doctor', 'demo-skill', '--fix'], handlers)

    expect(handlers.doctor).toHaveBeenCalledWith({ skillName: 'demo-skill', fix: true })
    expect(handlers.validate).not.toHaveBeenCalled()
  })

  it('doctor --fix=false 会以 fix=false 分发', async () => {
    const handlers = createHandlers()

    await dispatchSkillCommand(['doctor', 'demo-skill', '--fix=false'], handlers)

    expect(handlers.doctor).toHaveBeenCalledWith({ skillName: 'demo-skill', fix: false })
    expect(handlers.validate).not.toHaveBeenCalled()
  })

  it('doctor --fix 显式传入非法布尔值会拒绝', async () => {
    await expect(dispatchSkillCommand(['doctor', 'demo-skill', '--fix=maybe'], createHandlers())).rejects.toThrow(
      /fix 非法: maybe/,
    )
  })

  it('未知子命令会拒绝', async () => {
    await expect(dispatchSkillCommand(['unknown', 'demo-skill'], createHandlers())).rejects.toThrow(/未知 skill 子命令/)
  })

  it('缺少 skill 名称会拒绝', async () => {
    await expect(dispatchSkillCommand(['validate'], createHandlers())).rejects.toThrow(/请提供 skill 名称/)
  })

  it('多余位置参数会拒绝', async () => {
    await expect(dispatchSkillCommand(['status', 'demo-skill', 'extra'], createHandlers())).rejects.toThrow(
      /只接受一个 skill 名称/,
    )
  })

  it('绝对路径形式的 skill 名称会拒绝', async () => {
    await expect(dispatchSkillCommand(['validate', '/tmp/demo-skill'], createHandlers())).rejects.toThrow(
      /skill 名称不能是绝对路径/,
    )
  })

  it('包含父目录逃逸的 skill 名称会拒绝', async () => {
    await expect(dispatchSkillCommand(['link', '../demo-skill'], createHandlers())).rejects.toThrow(
      /skill 名称不能包含目录逃逸片段/,
    )
  })

  it('Windows 盘符绝对路径形式的 skill 名称会拒绝', async () => {
    await expect(dispatchSkillCommand(['status', 'C:\\tmp\\demo-skill'], createHandlers())).rejects.toThrow(
      /skill 名称不能是绝对路径/,
    )
  })

  it('Windows UNC 绝对路径形式的 skill 名称会拒绝', async () => {
    await expect(
      dispatchSkillCommand(['status', '\\\\server\\share\\demo-skill'], createHandlers()),
    ).rejects.toThrow(/skill 名称不能是绝对路径/)
  })

  it('skill 顶层命令优先于 target\/dir 解析，并先拒绝 skill 不支持的参数', () => {
    const result = spawnSync(
      process.execPath,
      [tsxCliPath, cliPath, 'skill', 'validate', 'demo-skill', '--dir', '/definitely/not/real'],
      {
        cwd: appRoot,
        encoding: 'utf8',
        env: sanitizeChildProcessEnv({
          BATA_WORKFLOW_SKILL_PRESERVE_SYMLINKS: 'true',
        }),
      },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('skill validate 不支持参数: dir')
    expect(result.stderr).not.toContain('ENOENT')
    expect(result.stderr).not.toContain('/definitely/not/real')
  })

  it('seeded monitor skill supports validate link status doctor and publish-local lifecycle', async () => {
    const sandbox = createSkillCliSandbox()
    const installName = 'monitor'
    const installPath = resolve(sandbox.homeDirectory, '.coco', 'skills', installName)
    const statePath = resolve(sandbox.skillStateRoot, `${installName}.json`)
    const packOutputDirectory = resolve(sandbox.skillPacksRoot, installName, '0.1.0')
    const cliEnv = {
      BATA_WORKFLOW_STATE_ROOT: sandbox.stateRoot,
      BATA_WORKFLOW_SKILL_PACKS_ROOT: sandbox.skillPacksRoot,
    }
    const cleanup = () => {
      rmSync(installPath, { recursive: true, force: true })
      rmSync(statePath, { recursive: true, force: true })
      rmSync(packOutputDirectory, { recursive: true, force: true })
      rmSync(sandbox.homeDirectory, { recursive: true, force: true })
    }

    cleanup()

    let boardBataWorkflow: Awaited<ReturnType<typeof createReusableMonitorBoardBataWorkflow>> | null = null

    try {
      boardBataWorkflow = await createReusableMonitorBoardBataWorkflow()
      expect(boardBataWorkflow.repoRoot).not.toBe(repoRoot)
      expect(boardBataWorkflow.workspacePath.startsWith(boardBataWorkflow.repoRoot)).toBe(true)
      expect(boardBataWorkflow.runtimeStatePath).toBe(resolve(boardBataWorkflow.repoRoot, '.bata-workflow', 'state', 'monitor-board', 'runtime.json'))

      const validateResult = runSkillCli(['validate', 'monitor'], sandbox.homeDirectory, cliEnv)
      expect(validateResult.status).toBe(0)
      expect(validateResult.stdout).toContain('Validated skill: monitor@0.1.0')
      expect(validateResult.stdout).toContain(`Skill Root: ${resolve(repoRoot, 'skills', 'monitor')}`)

      const linkResult = runSkillCli(['link', 'monitor'], sandbox.homeDirectory, cliEnv)
      expect(linkResult.status).toBe(0)
      expect(linkResult.stdout).toContain(`Install Path: ${installPath}`)
      expect(lstatSync(installPath).isSymbolicLink()).toBe(true)
      expect(existsSync(resolve(installPath, 'SKILL.md'))).toBe(true)
      expect(existsSync(resolve(installPath, 'runtime', 'invoke-monitor.mjs'))).toBe(true)
      const linkedRuntimeResult = await runInstalledMonitor(installPath, boardBataWorkflow.workspacePath, sandbox.homeDirectory, cliEnv)
      expect(linkedRuntimeResult.status).toBe(0)
      const linkedRuntimeJson = parseMonitorRuntimeOutput(linkedRuntimeResult.stdout)
      expect(linkedRuntimeJson).toMatchObject({
        kind: 'create',
        requesterActorId: 'lead',
        isRootActor: true,
      })
      expectReusableBoard(linkedRuntimeJson, boardBataWorkflow.port)
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
        cocoInstallName: 'monitor',
        mode: 'linked',
      })

      const linkedStatusResult = runSkillCli(['status', 'monitor'], sandbox.homeDirectory, cliEnv)
      expect(linkedStatusResult.status).toBe(0)
      expect(linkedStatusResult.stdout).toContain('Status: linked')
      expect(linkedStatusResult.stdout).toContain('Health: ok')

      const linkedDoctorResult = runSkillCli(['doctor', 'monitor'], sandbox.homeDirectory, cliEnv)
      expect(linkedDoctorResult.status).toBe(0)
      expect(linkedDoctorResult.stdout).toContain('Summary: monitor is healthy')

      const publishResult = runSkillCli(['publish-local', 'monitor'], sandbox.homeDirectory, cliEnv)
      expect(publishResult.status).toBe(0)
      expect(lstatSync(installPath).isDirectory()).toBe(true)
      expect(existsSync(resolve(installPath, 'SKILL.md'))).toBe(true)
      expect(existsSync(resolve(installPath, 'runtime', 'invoke-monitor.mjs'))).toBe(true)
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
        cocoInstallName: 'monitor',
        mode: 'published-local',
        packPath: installPath,
      })

      const publishedStatusResult = runSkillCli(['status', 'monitor'], sandbox.homeDirectory, cliEnv)
      expect(publishedStatusResult.status).toBe(0)
      expect(publishedStatusResult.stdout).toContain('Status: published-local')
      expect(publishedStatusResult.stdout).toContain('Health: ok')

      const publishedDoctorResult = runSkillCli(['doctor', 'monitor'], sandbox.homeDirectory, cliEnv)
      expect(publishedDoctorResult.status).toBe(0)
      expect(publishedDoctorResult.stdout).toContain('Summary: monitor is healthy')
      expect(publishedDoctorResult.stdout).toContain(`State Path: ${statePath}`)

      const publishedRuntimeResult = await runInstalledMonitor(installPath, boardBataWorkflow.workspacePath, sandbox.homeDirectory, cliEnv)
      expect(publishedRuntimeResult.status).toBe(0)
      const publishedRuntimeJson = parseMonitorRuntimeOutput(publishedRuntimeResult.stdout)
      expect(publishedRuntimeJson).toMatchObject({
        kind: 'attach',
        monitorSessionId: linkedRuntimeJson.monitorSessionId,
      })
      expectReusableBoard(publishedRuntimeJson, boardBataWorkflow.port)
    } finally {
      await boardBataWorkflow?.cleanup()
      cleanup()
    }
  })

  it('monitor runtime keeps the same session across linked and published-local installs', async () => {
    const sandbox = createSkillCliSandbox()
    const installName = 'monitor'
    const installPath = resolve(sandbox.homeDirectory, '.coco', 'skills', installName)
    const statePath = resolve(sandbox.skillStateRoot, `${installName}.json`)
    const packOutputDirectory = resolve(sandbox.skillPacksRoot, installName, '0.1.0')
    const cliEnv = {
      BATA_WORKFLOW_STATE_ROOT: sandbox.stateRoot,
      BATA_WORKFLOW_SKILL_PACKS_ROOT: sandbox.skillPacksRoot,
    }
    const cleanup = () => {
      rmSync(installPath, { recursive: true, force: true })
      rmSync(statePath, { recursive: true, force: true })
      rmSync(packOutputDirectory, { recursive: true, force: true })
      rmSync(sandbox.homeDirectory, { recursive: true, force: true })
    }

    cleanup()

    let boardBataWorkflow: Awaited<ReturnType<typeof createReusableMonitorBoardBataWorkflow>> | null = null

    try {
      boardBataWorkflow = await createReusableMonitorBoardBataWorkflow()
      expect(boardBataWorkflow.repoRoot).not.toBe(repoRoot)
      expect(boardBataWorkflow.workspacePath.startsWith(boardBataWorkflow.repoRoot)).toBe(true)

      const linkResult = runSkillCli(['link', 'monitor'], sandbox.homeDirectory, cliEnv)
      expect(linkResult.status).toBe(0)

      const linkedFirst = await runInstalledMonitor(installPath, boardBataWorkflow.workspacePath, sandbox.homeDirectory, cliEnv)
      const linkedSecond = await runInstalledMonitor(installPath, boardBataWorkflow.workspacePath, sandbox.homeDirectory, cliEnv)

      expect(linkedFirst.status).toBe(0)
      expect(linkedSecond.status).toBe(0)

      const linkedFirstJson = parseMonitorRuntimeOutput(linkedFirst.stdout)
      const linkedSecondJson = parseMonitorRuntimeOutput(linkedSecond.stdout)

      expect(linkedFirstJson.kind).toBe('create')
      expect(linkedSecondJson.kind).toBe('attach')
      expect(linkedSecondJson.monitorSessionId).toBe(linkedFirstJson.monitorSessionId)
      expectReusableBoard(linkedFirstJson, boardBataWorkflow.port)
      expectReusableBoard(linkedSecondJson, boardBataWorkflow.port)

      const publishResult = runSkillCli(['publish-local', 'monitor'], sandbox.homeDirectory, cliEnv)
      expect(publishResult.status).toBe(0)
      expect(lstatSync(installPath).isDirectory()).toBe(true)

      const publishedFirst = await runInstalledMonitor(installPath, boardBataWorkflow.workspacePath, sandbox.homeDirectory, cliEnv)
      const publishedSecond = await runInstalledMonitor(installPath, boardBataWorkflow.workspacePath, sandbox.homeDirectory, cliEnv)

      expect(publishedFirst.status).toBe(0)
      expect(publishedSecond.status).toBe(0)

      const publishedFirstJson = parseMonitorRuntimeOutput(publishedFirst.stdout)
      const publishedSecondJson = parseMonitorRuntimeOutput(publishedSecond.stdout)

      expect(publishedFirstJson).toMatchObject({
        kind: 'attach',
        monitorSessionId: linkedFirstJson.monitorSessionId,
      })
      expect(publishedSecondJson).toMatchObject({
        kind: 'attach',
        monitorSessionId: linkedFirstJson.monitorSessionId,
      })
      expectReusableBoard(publishedFirstJson, boardBataWorkflow.port)
      expectReusableBoard(publishedSecondJson, boardBataWorkflow.port)
    } finally {
      await boardBataWorkflow?.cleanup()
      cleanup()
    }
  })
})
