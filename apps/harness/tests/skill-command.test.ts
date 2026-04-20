import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { dispatchSkillCommand } from '../src/cli/skill-command.js'

const appRoot = resolve(import.meta.dirname, '..')
const repoRoot = resolve(appRoot, '..', '..')
const cliPath = resolve(appRoot, 'src/cli/index.ts')
const tsxCliPath = resolve(appRoot, 'node_modules/tsx/dist/cli.mjs')
const skillPacksRoot = resolve(repoRoot, '.harness', 'skill-packs')
const skillStateRoot = resolve(repoRoot, '.harness', 'state', 'skills')

function runSkillCli(args: string[], homeDirectory: string) {
  return spawnSync(process.execPath, [tsxCliPath, cliPath, 'skill', ...args], {
    cwd: appRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeDirectory,
      USERPROFILE: homeDirectory,
    },
  })
}

function runInstalledMonitor(installPath: string, workspacePath: string, homeDirectory: string) {
  return spawnSync(
    process.execPath,
    [resolve(installPath, 'runtime', 'invoke-monitor.mjs'), '--cwd', workspacePath, '--output', 'json'],
    {
      cwd: appRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: homeDirectory,
        USERPROFILE: homeDirectory,
      },
    },
  )
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
        env: {
          ...process.env,
          HARNESS_SKILL_PRESERVE_SYMLINKS: 'true',
        },
      },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('skill validate 不支持参数: dir')
    expect(result.stderr).not.toContain('ENOENT')
    expect(result.stderr).not.toContain('/definitely/not/real')
  })

  it('seeded monitor skill supports validate link status doctor and publish-local lifecycle', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'harness-skill-home-'))
    const installName = 'monitor'
    const installPath = resolve(tempHome, '.coco', 'skills', installName)
    const statePath = resolve(skillStateRoot, `${installName}.json`)
    const packOutputDirectory = resolve(skillPacksRoot, installName, '0.1.0')
    const cleanup = () => {
      rmSync(installPath, { recursive: true, force: true })
      rmSync(statePath, { recursive: true, force: true })
      rmSync(packOutputDirectory, { recursive: true, force: true })
      rmSync(tempHome, { recursive: true, force: true })
    }

    cleanup()

    try {
      const validateResult = runSkillCli(['validate', 'monitor'], tempHome)
      expect(validateResult.status).toBe(0)
      expect(validateResult.stdout).toContain('Validated skill: monitor@0.1.0')
      expect(validateResult.stdout).toContain(`Skill Root: ${resolve(repoRoot, 'skills', 'monitor')}`)

      const linkResult = runSkillCli(['link', 'monitor'], tempHome)
      expect(linkResult.status).toBe(0)
      expect(linkResult.stdout).toContain(`Install Path: ${installPath}`)
      expect(lstatSync(installPath).isSymbolicLink()).toBe(true)
      expect(existsSync(resolve(installPath, 'SKILL.md'))).toBe(true)
      expect(existsSync(resolve(installPath, 'runtime', 'invoke-monitor.mjs'))).toBe(true)
      const linkedRuntimeResult = spawnSync(process.execPath, [resolve(installPath, 'runtime', 'invoke-monitor.mjs')], {
        cwd: tempHome,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: tempHome,
          USERPROFILE: tempHome,
        },
      })
      expect(linkedRuntimeResult.status).toBe(0)
      expect(JSON.parse(linkedRuntimeResult.stdout)).toMatchObject({
        kind: 'create',
        requesterActorId: 'lead',
        isRootActor: true,
      })
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
        cocoInstallName: 'monitor',
        mode: 'linked',
      })

      const linkedStatusResult = runSkillCli(['status', 'monitor'], tempHome)
      expect(linkedStatusResult.status).toBe(0)
      expect(linkedStatusResult.stdout).toContain('Status: linked')
      expect(linkedStatusResult.stdout).toContain('Health: ok')

      const linkedDoctorResult = runSkillCli(['doctor', 'monitor'], tempHome)
      expect(linkedDoctorResult.status).toBe(0)
      expect(linkedDoctorResult.stdout).toContain('Summary: monitor is healthy')

      const publishResult = runSkillCli(['publish-local', 'monitor'], tempHome)
      expect(publishResult.status).toBe(0)
      expect(lstatSync(installPath).isDirectory()).toBe(true)
      expect(existsSync(resolve(installPath, 'SKILL.md'))).toBe(true)
      expect(existsSync(resolve(installPath, 'runtime', 'invoke-monitor.mjs'))).toBe(true)
      expect(JSON.parse(readFileSync(statePath, 'utf8'))).toMatchObject({
        cocoInstallName: 'monitor',
        mode: 'published-local',
        packPath: installPath,
      })

      const publishedStatusResult = runSkillCli(['status', 'monitor'], tempHome)
      expect(publishedStatusResult.status).toBe(0)
      expect(publishedStatusResult.stdout).toContain('Status: published-local')
      expect(publishedStatusResult.stdout).toContain('Health: ok')

      const publishedDoctorResult = runSkillCli(['doctor', 'monitor'], tempHome)
      expect(publishedDoctorResult.status).toBe(0)
      expect(publishedDoctorResult.stdout).toContain('Summary: monitor is healthy')
      expect(publishedDoctorResult.stdout).toContain(`State Path: ${statePath}`)
    } finally {
      cleanup()
    }
  })

  it('monitor runtime keeps the same session across linked and published-local installs', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'harness-skill-home-'))
    const workspacePath = mkdtempSync(join(tmpdir(), 'harness-monitor-workspace-'))
    const installName = 'monitor'
    const installPath = resolve(tempHome, '.coco', 'skills', installName)
    const statePath = resolve(skillStateRoot, `${installName}.json`)
    const packOutputDirectory = resolve(skillPacksRoot, installName, '0.1.0')
    const cleanup = () => {
      rmSync(installPath, { recursive: true, force: true })
      rmSync(statePath, { recursive: true, force: true })
      rmSync(packOutputDirectory, { recursive: true, force: true })
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(tempHome, { recursive: true, force: true })
    }

    cleanup()

    try {
      const linkResult = runSkillCli(['link', 'monitor'], tempHome)
      expect(linkResult.status).toBe(0)

      const linkedFirst = runInstalledMonitor(installPath, workspacePath, tempHome)
      const linkedSecond = runInstalledMonitor(installPath, workspacePath, tempHome)

      expect(linkedFirst.status).toBe(0)
      expect(linkedSecond.status).toBe(0)

      const linkedFirstJson = JSON.parse(linkedFirst.stdout) as { kind: string; monitorSessionId: string }
      const linkedSecondJson = JSON.parse(linkedSecond.stdout) as { kind: string; monitorSessionId: string }

      expect(linkedFirstJson.kind).toBe('create')
      expect(linkedSecondJson.kind).toBe('attach')
      expect(linkedSecondJson.monitorSessionId).toBe(linkedFirstJson.monitorSessionId)

      const publishResult = runSkillCli(['publish-local', 'monitor'], tempHome)
      expect(publishResult.status).toBe(0)
      expect(lstatSync(installPath).isDirectory()).toBe(true)

      const publishedFirst = runInstalledMonitor(installPath, workspacePath, tempHome)
      const publishedSecond = runInstalledMonitor(installPath, workspacePath, tempHome)

      expect(publishedFirst.status).toBe(0)
      expect(publishedSecond.status).toBe(0)

      const publishedFirstJson = JSON.parse(publishedFirst.stdout) as { kind: string; monitorSessionId: string }
      const publishedSecondJson = JSON.parse(publishedSecond.stdout) as { kind: string; monitorSessionId: string }

      expect(publishedFirstJson).toMatchObject({
        kind: 'attach',
        monitorSessionId: linkedFirstJson.monitorSessionId,
      })
      expect(publishedSecondJson).toMatchObject({
        kind: 'attach',
        monitorSessionId: linkedFirstJson.monitorSessionId,
      })
    } finally {
      cleanup()
    }
  })
})
