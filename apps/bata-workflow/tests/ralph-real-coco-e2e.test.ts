import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const appRoot = resolve(import.meta.dirname, '..')
const cliPath = resolve(appRoot, 'src/cli/index.ts')
const tsxCliPath = resolve(appRoot, 'node_modules/tsx/dist/cli.mjs')
const runIfEnabled = process.env.RALPH_REAL_COCO_E2E === '1' ? it : it.skip
const runAdvancedIfEnabled = process.env.RALPH_REAL_COCO_E2E_ADVANCED === '1' ? it : it.skip

function classifyCocoFailure(params: { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; errorMessage: string }): string {
  const output = `${params.stderr}\n${params.stdout}\n${params.errorMessage}`.toLowerCase()

  if (params.signal === 'SIGTERM' || output.includes('timed out') || output.includes('etimedout')) {
    return '可能是网络超时或模型响应超时，请检查网络与超时阈值。'
  }
  if (output.includes('not found') || output.includes('enoent') || output.includes('command not found')) {
    return '检测到 coco 不可执行，请确认 coco 已安装且在 PATH 中。'
  }
  if (output.includes('unauthorized') || output.includes('forbidden') || output.includes('permission denied')) {
    return '检测到权限问题，请检查账号权限、模型权限与 API 凭据。'
  }
  if (output.includes('login') || output.includes('auth') || output.includes('token')) {
    return '检测到登录/鉴权异常，请重新登录 coco 并确认会话有效。'
  }

  return '未识别错误类型，请检查 stderr/stdout 详情。'
}

function assertSuccessfulProcess(
  result: ReturnType<typeof spawnSync>,
  phase: string,
): void {
  if (result.status === 0) {
    return
  }

  const stderr = result.stderr?.trim() || '(empty)'
  const stdout = result.stdout?.trim() || '(empty)'
  const errorMessage = result.error?.message || '(no error message)'
  const hint = classifyCocoFailure({
    status: result.status,
    signal: result.signal,
    stdout,
    stderr,
    errorMessage,
  })

  throw new Error(
    `[${phase}] 进程失败: status=${result.status ?? 'null'} signal=${result.signal ?? 'null'}\n` +
      `hint=${hint}\n` +
      `stderr=${stderr}\n` +
      `stdout=${stdout}\n` +
      `error=${errorMessage}`,
  )
}

function assertCocoPreflight(): void {
  const help = spawnSync('coco', ['-h'], {
    cwd: appRoot,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env },
  })

  if (help.status !== 0) {
    throw new Error(
      `real e2e preflight failed: 无法调用 coco -h。stderr=${help.stderr?.trim() || '(empty)'}；请确认 coco 已安装并在 PATH 中。`,
    )
  }

  const smoke = spawnSync(
    'coco',
    ['-y', '--print', '请仅输出 JSON: {"status":"ok"}'],
    {
      cwd: appRoot,
      encoding: 'utf8',
      timeout: 90_000,
      env: { ...process.env },
    },
  )

  if (smoke.status !== 0) {
    throw new Error(
      `real e2e preflight failed: coco 非交互执行不可用。stderr=${smoke.stderr?.trim() || '(empty)'} stdout=${smoke.stdout?.trim() || '(empty)'}；请检查 coco 登录/模型权限。`,
    )
  }
}

describe('ralph real coco e2e', () => {
  runIfEnabled('starts real coco dialogue with planning gate then natural-language confirmation', () => {
    assertCocoPreflight()
    const workspacePath = mkdtempSync(join(tmpdir(), 'ralph-real-coco-'))

    try {
      const planningRun = spawnSync(
        process.execPath,
        [tsxCliPath, cliPath, '/ralph', '执行最小可验证任务并输出结论', '--cwd', workspacePath, '--mode', 'independent', '--output', 'json'],
        {
          cwd: appRoot,
          encoding: 'utf8',
          timeout: 240000,
          env: {
            ...process.env,
          },
        },
      )

      assertSuccessfulProcess(planningRun, 'independent /ralph real e2e planning run')
      const planningPayload = JSON.parse(planningRun.stdout) as {
        kind: string
        mode: string
        summary: string
        requiresConfirmation: boolean
        tasks: Array<{ status: string }>
      }

      expect(planningPayload.mode).toBe('independent')
      expect(planningPayload.kind).toBe('plan')
      expect(planningPayload.requiresConfirmation).toBe(true)
      expect(planningPayload.tasks.length).toBeGreaterThan(0)
      expect(planningPayload.tasks.every((task) => task.status === 'pending')).toBe(true)
      expect(planningPayload.summary).toContain('executed=0')
      expect(existsSync(resolve(workspacePath, '.ralph', 'confirmation-state.json'))).toBe(true)

      const resumeRun = spawnSync(
        process.execPath,
        [tsxCliPath, cliPath, '确认', '--cwd', workspacePath, '--mode', 'independent', '--output', 'json'],
        {
          cwd: appRoot,
          encoding: 'utf8',
          timeout: 240000,
          env: {
            ...process.env,
          },
        },
      )

      assertSuccessfulProcess(resumeRun, 'independent /ralph real e2e resume run')
      const resumePayload = JSON.parse(resumeRun.stdout) as {
        kind: string
        mode: string
        summary: string
        tasks: Array<{ status: string }>
      }

      expect(resumePayload.mode).toBe('independent')
      expect(resumePayload.kind).toBe('resume')
      expect(resumePayload.tasks.length).toBeGreaterThan(0)
      expect(resumePayload.tasks.some((task) => task.status !== 'pending')).toBe(true)
      expect(resumePayload.summary).toMatch(/done=\d+, blocked=\d+, total=\d+/)
      expect(existsSync(resolve(workspacePath, '.ralph', 'session.json'))).toBe(true)
      expect(existsSync(resolve(workspacePath, '.ralph', 'tasks.json'))).toBe(true)

      const persistedTasks = JSON.parse(readFileSync(resolve(workspacePath, '.ralph', 'tasks.json'), 'utf8')) as Array<{ status: string }>
      expect(persistedTasks.length).toBeGreaterThan(0)
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  runAdvancedIfEnabled('runs real coco dialogue in subagent mode after /ralph --resume', () => {
    assertCocoPreflight()
    const workspacePath = mkdtempSync(join(tmpdir(), 'ralph-real-coco-subagent-'))

    try {
      const planningRun = spawnSync(
        process.execPath,
        [tsxCliPath, cliPath, '/ralph', '使用subagent模式执行最小任务', '--cwd', workspacePath, '--mode', 'subagent', '--output', 'json'],
        {
          cwd: appRoot,
          encoding: 'utf8',
          timeout: 300000,
          env: {
            ...process.env,
          },
        },
      )

      assertSuccessfulProcess(planningRun, 'subagent /ralph real e2e planning run')
      const planningPayload = JSON.parse(planningRun.stdout) as {
        kind: string
        mode: string
        summary: string
        requiresConfirmation: boolean
        tasks: Array<{ status: string }>
      }

      expect(planningPayload.mode).toBe('subagent')
      expect(planningPayload.kind).toBe('plan')
      expect(planningPayload.requiresConfirmation).toBe(true)
      expect(planningPayload.tasks.length).toBeGreaterThan(0)
      expect(planningPayload.tasks.every((task) => task.status === 'pending')).toBe(true)
      expect(planningPayload.summary).toContain('executed=0')
      expect(existsSync(resolve(workspacePath, '.ralph', 'confirmation-state.json'))).toBe(true)

      const resumeRun = spawnSync(
        process.execPath,
        [tsxCliPath, cliPath, '/ralph', '--resume', '--cwd', workspacePath, '--mode', 'subagent', '--output', 'json'],
        {
          cwd: appRoot,
          encoding: 'utf8',
          timeout: 300000,
          env: {
            ...process.env,
          },
        },
      )

      assertSuccessfulProcess(resumeRun, 'subagent /ralph real e2e resume run')
      const resumePayload = JSON.parse(resumeRun.stdout) as {
        kind: string
        mode: string
        summary: string
        tasks: Array<{ status: string }>
      }

      expect(resumePayload.mode).toBe('subagent')
      expect(resumePayload.kind).toBe('resume')
      expect(resumePayload.tasks.length).toBeGreaterThan(0)
      expect(resumePayload.tasks.some((task) => task.status !== 'pending')).toBe(true)
      expect(resumePayload.summary).toMatch(/done=\d+, blocked=\d+, total=\d+/)
      expect(existsSync(resolve(workspacePath, '.ralph', 'session.json'))).toBe(true)
      expect(existsSync(resolve(workspacePath, '.ralph', 'tasks.json'))).toBe(true)
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  runAdvancedIfEnabled('recovers from real-process interruption and continues with /ralph --resume', () => {
    assertCocoPreflight()
    const workspacePath = mkdtempSync(join(tmpdir(), 'ralph-real-coco-resume-'))

    try {
      const planningRun = spawnSync(
        process.execPath,
        [tsxCliPath, cliPath, '/ralph', '模拟中断后恢复执行', '--cwd', workspacePath, '--mode', 'independent', '--output', 'json'],
        {
          cwd: appRoot,
          encoding: 'utf8',
          timeout: 300000,
          env: {
            ...process.env,
          },
        },
      )

      assertSuccessfulProcess(planningRun, 'resume flow planning run')
      const planningPayload = JSON.parse(planningRun.stdout) as {
        kind: string
        summary: string
        requiresConfirmation: boolean
        tasks: Array<{ status: string }>
      }
      expect(planningPayload.kind).toBe('plan')
      expect(planningPayload.requiresConfirmation).toBe(true)
      expect(planningPayload.summary).toContain('executed=0')
      expect(planningPayload.tasks.every((task) => task.status === 'pending')).toBe(true)

      const firstResumeRun = spawnSync(
        process.execPath,
        [tsxCliPath, cliPath, '/ralph', '--resume', '--cwd', workspacePath, '--mode', 'independent', '--output', 'json'],
        {
          cwd: appRoot,
          encoding: 'utf8',
          timeout: 300000,
          env: {
            ...process.env,
            RALPH_TEST_INTERRUPT_ONCE: '1',
          },
        },
      )

      assertSuccessfulProcess(firstResumeRun, 'resume flow first resume run')
      const firstResumePayload = JSON.parse(firstResumeRun.stdout) as { kind: string; summary: string }
      expect(firstResumePayload.kind).toBe('resume')
      expect(firstResumePayload.summary).toMatch(/blocked=\d+/)

      const secondResumeRun = spawnSync(
        process.execPath,
        [tsxCliPath, cliPath, '/ralph', '--resume', '--cwd', workspacePath, '--mode', 'independent', '--output', 'json'],
        {
          cwd: appRoot,
          encoding: 'utf8',
          timeout: 300000,
          env: {
            ...process.env,
            RALPH_TEST_INTERRUPT_ONCE: '1',
          },
        },
      )

      assertSuccessfulProcess(secondResumeRun, 'resume flow second resume run')
      const secondResumePayload = JSON.parse(secondResumeRun.stdout) as { kind: string; summary: string }
      expect(secondResumePayload.kind).toBe('resume')
      expect(secondResumePayload.summary).toContain('blocked=0')

      const markerPath = resolve(workspacePath, '.ralph', 'interrupt-once.marker')
      expect(existsSync(markerPath)).toBe(true)
      const persistedTasks = JSON.parse(readFileSync(resolve(workspacePath, '.ralph', 'tasks.json'), 'utf8')) as Array<{ status: string }>
      expect(persistedTasks.every((task) => task.status === 'done')).toBe(true)
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })
})
