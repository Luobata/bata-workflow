import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const appRoot = resolve(import.meta.dirname, '..')
const cliPath = resolve(appRoot, 'src/cli/index.ts')
const tsxCliPath = resolve(appRoot, 'node_modules/tsx/dist/cli.mjs')

function runCli(args: string[], envOverrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [tsxCliPath, cliPath, ...args], {
    cwd: appRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      RALPH_STUB_AGENT: '1',
      ...envOverrides,
    },
  })
}

describe('ralph cli command', () => {
  it('supports /ralph --dryRunPlan to only generate TODO list', () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'ralph-cli-dry-plan-'))

    try {
      const result = runCli(['/ralph', '先规划后执行', '--cwd', workspacePath, '--output', 'json', '--stubAgent', '--dryRunPlan'])
      expect(result.status).toBe(0)

      const payload = JSON.parse(result.stdout) as {
        kind: string
        dryRunPlan: boolean
        summary: string
        tasks: Array<{ status: string; deps: string[]; acceptance: string[]; verification_cmds: string[] }>
      }

      expect(payload.kind).toBe('plan')
      expect(payload.dryRunPlan).toBe(true)
      expect(payload.summary).toContain('executed=0')
      expect(payload.tasks.length).toBeGreaterThan(0)
      expect(payload.tasks.every((task) => task.status === 'pending')).toBe(true)
      expect(payload.tasks.every((task) => Array.isArray(task.deps))).toBe(true)
      expect(payload.tasks.every((task) => task.acceptance.length > 0)).toBe(true)
      expect(payload.tasks.every((task) => task.verification_cmds.length > 0)).toBe(true)
      expect(existsSync(resolve(workspacePath, '.ralph', 'tasks.json'))).toBe(true)
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('first /ralph goal invocation only persists plan and waits for confirmation', () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'ralph-cli-goal-'))

    try {
      const result = runCli(['/ralph', '实现登录接口并补充测试', '--cwd', workspacePath, '--output', 'json', '--stubAgent'])
      expect(result.status).toBe(0)

      const payload = JSON.parse(result.stdout) as {
        kind: string
        summary: string
        ralphDirectory: string
        requiresConfirmation: boolean
        confirmationPrompt: string | null
        tasks: Array<{ status: string }>
      }
      expect(payload.kind).toBe('plan')
      expect(payload.summary).toContain('executed=0')
      expect(payload.requiresConfirmation).toBe(true)
      expect(payload.confirmationPrompt).toContain('确认')
      expect(payload.tasks.length).toBeGreaterThan(0)
      expect(payload.tasks.every((task) => task.status === 'pending')).toBe(true)
      expect(existsSync(resolve(workspacePath, '.ralph', 'session.json'))).toBe(true)
      expect(existsSync(resolve(workspacePath, '.ralph', 'tasks.json'))).toBe(true)
      expect(existsSync(resolve(workspacePath, '.ralph', 'confirmation-state.json'))).toBe(true)
      expect(payload.ralphDirectory).toBe(resolve(workspacePath, '.ralph'))
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('rejects mixing a new goal with --execute', () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'ralph-cli-goal-execute-'))

    try {
      const result = runCli(['/ralph', '实现登录接口并补充测试', '--cwd', workspacePath, '--output', 'json', '--stubAgent', '--execute'])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('首次调用只会生成计划')
      expect(result.stderr).toContain('/ralph --resume')
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  for (const confirmationPhrase of ['确认', '继续', '开始', 'confirm', 'continue', 'go']) {
    it(`treats bare phrase "${confirmationPhrase}" as resume only when a plan is awaiting confirmation`, () => {
      const workspacePath = mkdtempSync(join(tmpdir(), `ralph-cli-confirm-${confirmationPhrase}-`))

      try {
        const firstRun = runCli(['/ralph', '实现登录接口并补充测试', '--cwd', workspacePath, '--output', 'json', '--stubAgent'])
        expect(firstRun.status).toBe(0)

        const secondRun = runCli([confirmationPhrase, '--cwd', workspacePath, '--output', 'json', '--stubAgent'])
        expect(secondRun.status).toBe(0)
        const secondPayload = JSON.parse(secondRun.stdout) as { kind: string; summary: string }
        expect(secondPayload.kind).toBe('resume')
        expect(secondPayload.summary).toContain('blocked=0')
        expect(secondRun.stderr).toContain('received confirmation')
      } finally {
        rmSync(workspacePath, { recursive: true, force: true })
      }
    })
  }

  it('keeps monorepo path-mode confirmation scoped to the target directory', () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'ralph-cli-path-'))
    const targetPath = mkdtempSync(join(tmpdir(), 'ralph-target-'))

    try {
      const firstRun = runCli(['/ralph', targetPath, '--cwd', workspacePath, '--mode', 'subagent', '--output', 'json', '--stubAgent'])
      expect(firstRun.status).toBe(0)
      const firstPayload = JSON.parse(firstRun.stdout) as { mode: string; kind: string; autoPlanOnly: boolean; requiresConfirmation: boolean }
      expect(firstPayload.mode).toBe('subagent')
      expect(firstPayload.kind).toBe('plan')
      expect(firstPayload.autoPlanOnly).toBe(true)
      expect(firstPayload.requiresConfirmation).toBe(true)

      const wrongCwdConfirm = runCli(['继续', '--cwd', workspacePath, '--output', 'json', '--stubAgent'])
      expect(wrongCwdConfirm.status).toBe(1)
      expect(wrongCwdConfirm.stderr).not.toContain('received confirmation')

      const secondRun = runCli(['继续', '--cwd', targetPath, '--output', 'json', '--stubAgent'])
      expect(secondRun.status).toBe(0)
      const secondPayload = JSON.parse(secondRun.stdout) as { kind: string; summary: string }
      expect(secondPayload.kind).toBe('resume')
      expect(secondPayload.summary).toContain('blocked=0')

      const tasks = JSON.parse(readFileSync(resolve(targetPath, '.ralph', 'tasks.json'), 'utf8')) as Array<{ status: string }>
      expect(tasks.every((task) => task.status === 'done')).toBe(true)
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(targetPath, { recursive: true, force: true })
    }
  })

  it('does not auto-resume while a plan is still awaiting explicit confirmation', () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'ralph-cli-awaiting-confirmation-'))

    try {
      const firstRun = runCli(['/ralph', '实现功能A,实现功能B', '--cwd', workspacePath, '--output', 'json', '--stubAgent'])
      expect(firstRun.status).toBe(0)

      const plainRun = runCli(['/ralph', '--cwd', workspacePath, '--output', 'json', '--stubAgent'])
      expect(plainRun.status).toBe(1)
      expect(plainRun.stderr).not.toContain('auto-enabled --resume')
      expect(plainRun.stderr).toContain('确认')

      const resumeRun = runCli(['/ralph', '--cwd', workspacePath, '--output', 'json', '--stubAgent', '--resume'])
      expect(resumeRun.status).toBe(0)
      const resumePayload = JSON.parse(resumeRun.stdout) as { kind: string; summary: string }
      expect(resumePayload.kind).toBe('resume')
      expect(resumePayload.summary).toContain('blocked=0')
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('rejects mixing a new path input with --resume', () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'ralph-cli-path-resume-mix-'))
    const targetPath = mkdtempSync(join(tmpdir(), 'ralph-cli-path-resume-target-'))

    try {
      const result = runCli(['/ralph', targetPath, '--cwd', workspacePath, '--output', 'json', '--stubAgent', '--resume'])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('首次调用只会生成计划')
      expect(result.stderr).toContain('/ralph --resume')
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
      rmSync(targetPath, { recursive: true, force: true })
    }
  })

  it('supports --resumeForce when todo-state is missing or malformed', () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'ralph-cli-resume-force-'))

    try {
      const firstPlanRun = runCli(['/ralph', '先执行并制造一次中断', '--cwd', workspacePath, '--output', 'json', '--stubAgent'])
      expect(firstPlanRun.status).toBe(0)

      const interruptedRun = runCli(['/ralph', '--cwd', workspacePath, '--output', 'json', '--stubAgent', '--resume'], {
        RALPH_TEST_INTERRUPT_ONCE: '1',
      })
      expect(interruptedRun.status).toBe(0)

      const todoStatePath = resolve(workspacePath, '.ralph', 'todo-state.json')
      if (existsSync(todoStatePath)) {
        unlinkSync(todoStatePath)
      }

      const plainRun = runCli(['/ralph', '--cwd', workspacePath, '--output', 'json', '--stubAgent'])
      expect(plainRun.status).toBe(1)

      writeFileSync(todoStatePath, '{broken json}', 'utf8')
      const forcedRun = runCli(['/ralph', '--cwd', workspacePath, '--output', 'json', '--stubAgent', '--resumeForce'])
      expect(forcedRun.status).toBe(0)
      const forcedPayload = JSON.parse(forcedRun.stdout) as { kind: string; summary: string }
      expect(forcedPayload.kind).toBe('resume')
      expect(forcedPayload.summary).toContain('blocked=0')
      expect(forcedRun.stderr).toContain('force-enabled --resume')
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('returns clear error when confirming without pending plan', () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'ralph-cli-confirm-without-plan-'))

    try {
      const result = runCli(['/ralph', '确认', '--cwd', workspacePath, '--output', 'json', '--stubAgent'])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('未检测到待确认计划')
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('supports /ralph --monitor and starts monitor once before task execution', () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'ralph-cli-monitor-once-'))

    try {
      const firstRun = runCli(
        ['/ralph', '执行并监控一次', '--cwd', workspacePath, '--output', 'json', '--stubAgent', '--monitor'],
        { RALPH_TEST_MONITOR_STUB: '1' },
      )
      expect(firstRun.status).toBe(0)
      expect(firstRun.stderr).toContain('monitor integration started')
      const firstPayload = JSON.parse(firstRun.stdout) as { monitorIntegration?: { status?: string } }
      expect(firstPayload.monitorIntegration?.status).toBe('started')

      const monitorStatePath = resolve(workspacePath, '.ralph', 'monitor-integration.json')
      expect(existsSync(monitorStatePath)).toBe(true)
      const firstState = JSON.parse(readFileSync(monitorStatePath, 'utf8')) as { startCount?: number }
      expect(firstState.startCount).toBe(1)

      const secondRun = runCli(
        ['/ralph', '--cwd', workspacePath, '--output', 'json', '--stubAgent', '--resume', '--monitor'],
        { RALPH_TEST_MONITOR_STUB: '1' },
      )
      expect(secondRun.status).toBe(0)
      expect(secondRun.stderr).toContain('monitor integration skipped')
      const secondPayload = JSON.parse(secondRun.stdout) as { monitorIntegration?: { status?: string } }
      expect(secondPayload.monitorIntegration?.status).toBe('skipped')

      const secondState = JSON.parse(readFileSync(monitorStatePath, 'utf8')) as { startCount?: number }
      expect(secondState.startCount).toBe(1)
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('ignores --monitor gracefully when monitor skill is unavailable', () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'ralph-cli-monitor-missing-'))

    try {
      const run = runCli(
        ['/ralph', '监控不可用时继续执行', '--cwd', workspacePath, '--output', 'json', '--stubAgent', '--monitor'],
        { RALPH_TEST_MONITOR_FORCE_MISSING: '1' },
      )

      expect(run.status).toBe(0)
      expect(run.stderr).toContain('monitor integration unavailable, skipping')
      const payload = JSON.parse(run.stdout) as { monitorIntegration?: { status?: string } }
      expect(payload.monitorIntegration?.status).toBe('unavailable')
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })
})
