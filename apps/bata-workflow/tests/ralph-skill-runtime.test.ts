import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { invokeRalph } from '../../../skills/ralph/runtime/invoke-ralph.mjs'

const tempRoots: string[] = []

const createTempRoot = (): string => {
  const root = mkdtempSync(resolve(tmpdir(), 'ralph-runtime-'))
  tempRoots.push(root)
  return root
}

const readRuntimeEvents = (ralphDir: string): string[] => {
  const runtimeLogPath = resolve(ralphDir, 'logs', 'runtime.jsonl')
  return readFileSync(runtimeLogPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { event: string })
    .map((entry) => entry.event)
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('ralph skill runtime', () => {
  it('decomposes path input into concrete subtasks (at least 3 executable tasks)', async () => {
    const cwd = createTempRoot()
    const docsRoot = resolve(cwd, 'gl-render', 'docs')
    mkdirSync(docsRoot, { recursive: true })
    writeFileSync(resolve(cwd, 'package.json'), JSON.stringify({ name: 'demo', private: true }), 'utf8')
    writeFileSync(resolve(cwd, 'gl-render', 'docs', 'overview.md'), '# 渲染链路\n## 初始化\n## 绘制流程\n', 'utf8')
    writeFileSync(resolve(cwd, 'gl-render', 'docs', 'api.md'), '# API\n## createRenderer\n## destroyRenderer\n', 'utf8')

    const result = await invokeRalph({
      cwd,
      path: docsRoot,
      mode: 'subagent',
    })

    expect(result.kind).toBe('plan')
    expect(result.requiresConfirmation).toBe(true)
    expect(result.confirmationPrompt).toContain('确认')
    expect(result.tasks.length).toBeGreaterThanOrEqual(6)
    expect(result.tasks[0].title).toContain('目录解析')
    expect(result.tasks.some((task: { title: string }) => task.title.includes('目录实现推进'))).toBe(true)
    expect(result.tasks[0].backgroundContext).toContain('来源文档概览')
    expect(Array.isArray(result.tasks[0].sourceRefs)).toBe(true)
    expect(result.tasks.some((task: { title: string }) => task.title.includes('目录验证闭环'))).toBe(true)
  })

  it('expands complex markdown plan into many functional TODOs with rich context', async () => {
    const cwd = createTempRoot()
    const docsRoot = resolve(cwd, 'complex-docs')
    mkdirSync(docsRoot, { recursive: true })
    writeFileSync(resolve(cwd, 'package.json'), JSON.stringify({ name: 'demo', private: true }), 'utf8')

    const checklist = Array.from({ length: 18 }, (_, index) => `- [ ] Step ${index + 1}: 完成功能点${index + 1}`).join('\n')
    writeFileSync(
      resolve(docsRoot, 'plan.md'),
      ['# 引擎方案', '## 核心数据流', checklist, '## 缓存层', '- Geometry Cache', '- Command Cache'].join('\n'),
      'utf8',
    )

    const result = await invokeRalph({
      cwd,
      path: docsRoot,
      mode: 'subagent',
    })

    expect(result.kind).toBe('plan')
    expect(result.tasks.length).toBeGreaterThanOrEqual(20)
    expect(result.tasks[1].backgroundContext).toContain('当前功能点')
    expect(result.tasks[1].sourceRefs.length).toBeGreaterThan(0)
    expect(result.tasks.every((task: { deps: string[] }) => Array.isArray(task.deps))).toBe(true)
  })

  it('returns clear error when resume state files are missing', async () => {
    const cwd = createTempRoot()

    await expect(
      invokeRalph({
        cwd,
        resume: true,
      }),
    ).rejects.toThrow(/无法恢复执行/)
  })

  it('infers verification commands from workspace project type', async () => {
    const cwd = createTempRoot()
    writeFileSync(resolve(cwd, 'package.json'), JSON.stringify({ name: 'demo', private: true }), 'utf8')

    const result = await invokeRalph({
      cwd,
      goal: '仅推导验证命令',
      dryRunPlan: true,
      mode: 'independent',
    })

    expect(result.kind).toBe('plan')
    const mergedVerificationCommands = result.tasks.flatMap((task: { verification_cmds: string[] }) => task.verification_cmds)
    expect(mergedVerificationCommands).toContain('npm test')
    expect(mergedVerificationCommands).toContain('npm run build')
  })

  it('supports dryRunPlan and only persists TODO without executing agents', async () => {
    const cwd = createTempRoot()
    let callCount = 0

    const result = await invokeRalph({
      cwd,
      goal: '实现任务拆解但暂不执行',
      mode: 'independent',
      dryRunPlan: true,
      todoBuilder: () => [
        {
          id: 'task-plan-only',
          title: '子任务1: 仅规划',
          status: 'pending',
          reviewRounds: 0,
          lastAdvicePath: null,
          history: [],
        },
      ],
      runAgent: async () => {
        callCount += 1
        return {
          stdout: JSON.stringify({ status: 'completed', summary: 'should not run', suggestions: [] }),
          stderr: '',
        }
      },
    })

    expect(result.kind).toBe('plan')
    expect(result.summary).toContain('executed=0')
    expect(result.requiresConfirmation).toBe(true)
    expect(result.confirmationPrompt).toContain('确认')
    expect(callCount).toBe(0)
    expect(result.tasks[0].acceptance.length).toBeGreaterThan(0)
    expect(result.tasks[0].verification_cmds.length).toBeGreaterThan(0)
    expect(Array.isArray(result.tasks[0].deps)).toBe(true)

    const tasksPath = resolve(cwd, '.ralph', 'tasks.json')
    const todoStatePath = resolve(cwd, '.ralph', 'todo-state.json')
    const todoMarkdownPath = resolve(cwd, '.ralph', 'TODO.md')
    const confirmationStatePath = resolve(cwd, '.ralph', 'confirmation-state.json')
    const runtimeLogPath = resolve(cwd, '.ralph', 'logs', 'runtime.jsonl')
    const persistedTasks = JSON.parse(readFileSync(tasksPath, 'utf8'))
    const confirmationState = JSON.parse(readFileSync(confirmationStatePath, 'utf8')) as {
      awaitingConfirmation: boolean
      reason: string
      nextAction: string
    }
    expect(persistedTasks[0].status).toBe('pending')
    expect(Array.isArray(persistedTasks[0].acceptance)).toBe(true)
    expect(Array.isArray(persistedTasks[0].verification_cmds)).toBe(true)
    expect(existsSync(todoStatePath)).toBe(true)
    expect(existsSync(todoMarkdownPath)).toBe(true)
    expect(existsSync(confirmationStatePath)).toBe(true)
    expect(existsSync(runtimeLogPath)).toBe(true)
    expect(confirmationState.awaitingConfirmation).toBe(true)
    expect(confirmationState.reason).toBe('plan_ready_waiting_user_confirmation')
    expect(confirmationState.nextAction).toContain('/ralph --resume')
    expect(readFileSync(todoMarkdownPath, 'utf8')).toContain('Ralph TODO Progress')
    expect(readFileSync(runtimeLogPath, 'utf8')).toContain('session.planned')
    expect(readRuntimeEvents(resolve(cwd, '.ralph'))).toEqual(['session.start', 'session.planned'])
  })

  it('forces first goal invocation into planning-only even when execute is requested', async () => {
    const cwd = createTempRoot()
    let callCount = 0

    const result = await invokeRalph({
      cwd,
      goal: '实现一个按钮点击功能',
      mode: 'independent',
      execute: true,
      todoBuilder: () => [
        {
          id: 'task-a',
          title: '子任务1: 实现按钮点击',
          status: 'pending',
          reviewRounds: 0,
          lastAdvicePath: null,
          history: [],
        },
      ],
      runAgent: async () => {
        callCount += 1
        return {
          stdout: JSON.stringify({ status: 'completed', summary: 'should not run', suggestions: [] }),
          stderr: '',
        }
      },
    })

    const ralphDir = resolve(cwd, '.ralph')
    const tasksPath = resolve(ralphDir, 'tasks.json')
    const confirmationStatePath = resolve(ralphDir, 'confirmation-state.json')

    expect(result.kind).toBe('plan')
    expect(result.summary).toContain('executed=0')
    expect(result.requiresConfirmation).toBe(true)
    expect(callCount).toBe(0)
    expect(existsSync(ralphDir)).toBe(true)
    expect(existsSync(tasksPath)).toBe(true)
    expect(existsSync(confirmationStatePath)).toBe(true)

    const persistedTasks = JSON.parse(readFileSync(tasksPath, 'utf8'))
    const confirmationState = JSON.parse(readFileSync(confirmationStatePath, 'utf8')) as { awaitingConfirmation: boolean; reason: string }
    expect(persistedTasks[0].status).toBe('pending')
    expect(confirmationState.awaitingConfirmation).toBe(true)
    expect(confirmationState.reason).toBe('plan_ready_waiting_user_confirmation')
    expect(readRuntimeEvents(ralphDir)).toEqual(['session.start', 'session.planned'])
  })

  it('resumes after planning and completes tasks with persisted review advice', async () => {
    const cwd = createTempRoot()

    const sharedTodo = () => [
      {
        id: 'task-a',
        title: '子任务1: 实现按钮点击',
        status: 'pending',
        reviewRounds: 0,
        lastAdvicePath: null,
        history: [],
      },
    ]

    await invokeRalph({
      cwd,
      goal: '实现一个按钮点击功能',
      mode: 'independent',
      todoBuilder: sharedTodo,
    })

    const result = await invokeRalph({
      cwd,
      mode: 'independent',
      resume: true,
      runAgent: async ({ role }) => ({
        stdout: JSON.stringify({
          status: 'completed',
          summary: `${role} done`,
          suggestions: role === 'review' ? ['保持现有实现，补充注释即可'] : [],
        }),
        stderr: '',
      }),
    })

    const ralphDir = resolve(cwd, '.ralph')
    const advicePath = resolve(ralphDir, 'reviews', 'task-a.advice.md')
    const tasksPath = resolve(ralphDir, 'tasks.json')
    const todoStatePath = resolve(ralphDir, 'todo-state.json')
    const runtimeLogPath = resolve(ralphDir, 'logs', 'runtime.jsonl')
    const confirmationStatePath = resolve(ralphDir, 'confirmation-state.json')

    expect(result.kind).toBe('resume')
    expect(result.summary).toContain('blocked=0')
    expect(existsSync(ralphDir)).toBe(true)
    expect(existsSync(tasksPath)).toBe(true)
    expect(existsSync(advicePath)).toBe(true)
    expect(existsSync(todoStatePath)).toBe(true)
    expect(existsSync(runtimeLogPath)).toBe(true)
    expect(readFileSync(advicePath, 'utf8')).toContain('Actionable Suggestions')
    expect(readFileSync(runtimeLogPath, 'utf8')).toContain('task.completed')

    const persistedTasks = JSON.parse(readFileSync(tasksPath, 'utf8'))
    const confirmationState = JSON.parse(readFileSync(confirmationStatePath, 'utf8')) as { awaitingConfirmation: boolean; reason: string }
    expect(persistedTasks[0].status).toBe('done')
    expect(confirmationState.awaitingConfirmation).toBe(false)
    expect(confirmationState.reason).toBe('execution_started')
  })

  it('runs coding/review loop until review passes and records round count', async () => {
    const cwd = createTempRoot()
    let reviewCallCount = 0
    let codingCallCount = 0

    await invokeRalph({
      cwd,
      goal: '修复接口超时问题',
      mode: 'subagent',
      todoBuilder: () => [
        {
          id: 'task-loop',
          title: '子任务1: 修复超时并加重试',
          status: 'pending',
          reviewRounds: 0,
          lastAdvicePath: null,
          history: [],
        },
      ],
    })

    const result = await invokeRalph({
      cwd,
      mode: 'subagent',
      resume: true,
      runAgent: async ({ role }) => {
        if (role === 'coding') {
          codingCallCount += 1
          return {
            stdout: JSON.stringify({ status: 'completed', summary: `coding round ${codingCallCount}`, suggestions: [] }),
            stderr: '',
          }
        }

        reviewCallCount += 1
        if (reviewCallCount === 1) {
          return {
            stdout: JSON.stringify({
              status: 'needs_changes',
              summary: '缺少失败重试的测试覆盖',
              suggestions: ['新增失败重试次数断言', '补充超时边界测试'],
            }),
            stderr: '',
          }
        }

        return {
          stdout: JSON.stringify({ status: 'completed', summary: 'review pass', suggestions: [] }),
          stderr: '',
        }
      },
    })

    expect(result.tasks[0].status).toBe('done')
    expect(result.tasks[0].reviewRounds).toBe(2)
    expect(codingCallCount).toBe(2)
    expect(reviewCallCount).toBe(2)
  })

  it('injects global TODO snapshot and TodoWrite instructions into agent prompt', async () => {
    const cwd = createTempRoot()
    const prompts: string[] = []

    await invokeRalph({
      cwd,
      goal: '验证 TODO 注入提示',
      mode: 'independent',
      todoBuilder: () => [
        {
          id: 'task-a',
          title: '子任务A',
          status: 'pending',
          reviewRounds: 0,
          lastAdvicePath: null,
          history: [],
          backgroundContext: '背景A',
          sourceRefs: ['docs/a.md'],
        },
        {
          id: 'task-b',
          title: '子任务B',
          status: 'pending',
          reviewRounds: 0,
          lastAdvicePath: null,
          history: [],
          deps: ['task-a'],
          backgroundContext: '背景B',
          sourceRefs: ['docs/b.md'],
        },
      ],
    })

    const result = await invokeRalph({
      cwd,
      mode: 'independent',
      resume: true,
      runAgent: async ({ prompt }) => {
        prompts.push(String(prompt))
        return {
          stdout: JSON.stringify({ status: 'completed', summary: 'ok', suggestions: [] }),
          stderr: '',
        }
      },
    })

    expect(result.summary).toContain('blocked=0')
    expect(prompts.length).toBeGreaterThan(0)
    expect(prompts[0]).toContain('全局 TODO 快照（执行前）')
    expect(prompts[0]).toContain('TodoWrite')
    expect(prompts[0]).toContain('task-a')
    expect(prompts[0]).toContain('<= current')
    expect(prompts[0]).toContain('只处理当前子任务')
    expect(prompts[0]).toContain('背景上下文')
    expect(prompts[0]).toContain('来源参考')
    expect(prompts[0]).toContain('上游依赖摘要')
  })

  it('starts monitor before execution when --monitor is enabled and returns monitor url', async () => {
    const cwd = createTempRoot()
    let monitorCallCount = 0

    const result = await invokeRalph({
      cwd,
      goal: '验证 monitor 集成输出',
      mode: 'independent',
      monitor: true,
      runMonitor: async () => {
        monitorCallCount += 1
        return {
          kind: 'create',
          monitorSessionId: 'monitor:demo-session',
          board: {
            url: 'http://127.0.0.1:3939?monitorSessionId=monitor:demo-session',
          },
        }
      },
      runAgent: async ({ role }) => ({
        stdout: JSON.stringify({ status: 'completed', summary: `${role} ok`, suggestions: [] }),
        stderr: '',
      }),
    })

    expect(result.kind).toBe('plan')
    expect(result.summary).toContain('executed=0')
    expect(result.requiresConfirmation).toBe(true)
    expect(monitorCallCount).toBe(1)
    expect(result.monitorIntegration?.status).toBe('started')
    expect(result.monitorIntegration?.monitorUrl).toContain('http://127.0.0.1:3939')
  })

  it('skips monitor startup on resume when current session already started monitor', async () => {
    const cwd = createTempRoot()
    let monitorCallCount = 0

    await invokeRalph({
      cwd,
      goal: '第一次执行启动 monitor',
      mode: 'independent',
      monitor: true,
      runMonitor: async () => {
        monitorCallCount += 1
        return {
          kind: 'create',
          monitorSessionId: 'monitor:once',
          board: {
            url: 'http://127.0.0.1:3939?monitorSessionId=monitor:once',
          },
        }
      },
      runAgent: async ({ role }) => ({
        stdout: JSON.stringify({ status: 'completed', summary: `${role} ok`, suggestions: [] }),
        stderr: '',
      }),
    })

    const resumed = await invokeRalph({
      cwd,
      mode: 'independent',
      resume: true,
      monitor: true,
      runMonitor: async () => {
        monitorCallCount += 1
        return {
          kind: 'attach',
          monitorSessionId: 'monitor:once',
          board: {
            url: 'http://127.0.0.1:3939?monitorSessionId=monitor:once',
          },
        }
      },
      runAgent: async ({ role }) => ({
        stdout: JSON.stringify({ status: 'completed', summary: `${role} resumed`, suggestions: [] }),
        stderr: '',
      }),
    })

    expect(monitorCallCount).toBe(1)
    expect(resumed.kind).toBe('resume')
    expect(resumed.monitorIntegration?.status).toBe('skipped')
  })

  it('supports resume after interruption and continues from persisted .ralph state', async () => {
    const cwd = createTempRoot()
    let interrupted = false

    const sharedTodo = [
      { id: 'task-1', title: '子任务1: 完成核心实现', status: 'pending', reviewRounds: 0, lastAdvicePath: null, history: [] },
      { id: 'task-2', title: '子任务2: 完成补充验证', status: 'pending', reviewRounds: 0, lastAdvicePath: null, history: [] },
    ]

    const firstRun = await invokeRalph({
      cwd,
      goal: '实现并验证完整流程',
      mode: 'independent',
      todoBuilder: () => sharedTodo,
    })

    expect(firstRun.kind).toBe('plan')

    const interruptedRun = await invokeRalph({
      cwd,
      mode: 'independent',
      resume: true,
      runAgent: async ({ role, prompt }) => {
        if (!interrupted && role === 'coding' && prompt.includes('子任务2')) {
          interrupted = true
          throw new Error('network disconnected')
        }

        return {
          stdout: JSON.stringify({ status: 'completed', summary: `${role} ok`, suggestions: [] }),
          stderr: '',
        }
      },
    })

    expect(interruptedRun.summary).toContain('blocked=1')

    const secondRun = await invokeRalph({
      cwd,
      mode: 'independent',
      resume: true,
      runAgent: async ({ role }) => ({
        stdout: JSON.stringify({ status: 'completed', summary: `${role} recovered`, suggestions: [] }),
        stderr: '',
      }),
    })

    expect(secondRun.kind).toBe('resume')
    expect(secondRun.summary).toContain('blocked=0')
    expect(secondRun.tasks.every((task: { status: string }) => task.status === 'done')).toBe(true)

    const checkpointFiles = readdirSync(resolve(cwd, '.ralph', 'checkpoints'))
    expect(checkpointFiles.length).toBeGreaterThan(0)
  })

  it('stores state in target directory when using --path (monorepo support)', async () => {
    const cwd = createTempRoot()
    const subprojectDir = resolve(cwd, 'packages', 'app-a')
    mkdirSync(subprojectDir, { recursive: true })
    writeFileSync(resolve(subprojectDir, 'design.md'), '# Feature\n## Step 1\n## Step 2\n', 'utf8')

    const result = await invokeRalph({
      cwd,
      path: resolve(subprojectDir, 'design.md'),
      mode: 'independent',
      dryRunPlan: true,
    })

    expect(result.kind).toBe('plan')
    expect(result.tasks.length).toBeGreaterThan(0)

    // 状态目录应该在子项目下，而不是 cwd
    const subprojectRalphDir = resolve(subprojectDir, '.ralph')
    const rootRalphDir = resolve(cwd, '.ralph')
    
    expect(existsSync(subprojectRalphDir)).toBe(true)
    expect(existsSync(resolve(subprojectRalphDir, 'session.json'))).toBe(true)
    expect(existsSync(resolve(subprojectRalphDir, 'tasks.json'))).toBe(true)
    
    // 根目录不应该有 .ralph
    expect(existsSync(rootRalphDir)).toBe(false)
  })

  it('stores state in target directory when using --dir (monorepo support)', async () => {
    const cwd = createTempRoot()
    const docsDir = resolve(cwd, 'packages', 'app-b', 'docs')
    mkdirSync(docsDir, { recursive: true })
    writeFileSync(resolve(docsDir, 'plan.md'), '# Module\n## Feature A\n## Feature B\n', 'utf8')

    const result = await invokeRalph({
      cwd,
      dir: docsDir,
      mode: 'independent',
      dryRunPlan: true,
    })

    expect(result.kind).toBe('plan')
    expect(result.tasks.length).toBeGreaterThan(0)

    // 状态目录应该在子项目下
    const subprojectRalphDir = resolve(docsDir, '.ralph')
    expect(existsSync(subprojectRalphDir)).toBe(true)
    expect(existsSync(resolve(subprojectRalphDir, 'session.json'))).toBe(true)
  })
})
