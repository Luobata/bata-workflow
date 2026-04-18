import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { DispatchAssignment } from '../src/domain/types.js'
import { AutoFallbackCocoAdapter, CocoCliAdapter, buildCocoCliArgs, buildCocoPrompt, buildCocoPtyCliArgs } from '../src/runtime/coco-adapter.js'
import type { RolePromptTemplateRegistry } from '../src/team/prompt-loader.js'
import { loadSkills } from '../src/team/skill-loader.js'
import { buildSkillRegistry } from '../src/team/skill-registry.js'

const skillsConfigPath = resolve(import.meta.dirname, '../configs/skills.yaml')
const skillRegistry = buildSkillRegistry(loadSkills(skillsConfigPath))

const assignment: DispatchAssignment = {
  task: {
    id: 'T1',
    title: '完成核心实现',
    description: '完成核心实现，目标：实现登录功能并补测试',
    role: 'coder',
    taskType: 'coding',
    dependsOn: [],
    acceptanceCriteria: ['实现关键功能', '产出可验证的变更说明'],
    skills: ['implementation'],
    status: 'ready',
    maxAttempts: 2
  },
  roleDefinition: {
    name: 'coder',
    description: '负责编码、重构与实现交付',
    defaultTaskTypes: ['coding'],
    defaultSkills: ['implementation']
  },
  modelResolution: {
    model: 'gpt5.3-codex',
    source: 'taskType',
    reason: 'taskType=coding 命中 taskTypes 配置'
  },
  fallback: null,
  remediation: null
}

describe('coco adapter', () => {
  it('构造 coco CLI 参数', () => {
    const args = buildCocoCliArgs({
      prompt: 'hello',
      timeoutMs: 1500,
      allowedTools: ['Bash', 'Read'],
      yolo: true
    })

    expect(args).toEqual(['-p', '--query-timeout', '2s', '--allowed-tool', 'Bash', '--allowed-tool', 'Read', '--yolo', 'hello'])
  })

  it('构造实验性 PTY coco 参数', () => {
    const args = buildCocoPtyCliArgs({
      prompt: 'hello',
      timeoutMs: 1500,
      allowedTools: ['Bash', 'Read'],
      yolo: true
    })

    expect(args).toEqual(['--query-timeout', '2s', '--allowed-tool', 'Bash', '--allowed-tool', 'Read', '--yolo', 'hello'])
  })

  it('生成带角色模板和技能说明的 prompt', () => {
    const prompt = buildCocoPrompt(assignment, [], undefined, skillRegistry)
    expect(prompt).toContain('你是实现者')
    expect(prompt).toContain('implementation: 实现与重构代码')
    expect(prompt).toContain('JSON schema')
  })

  it('把上游任务结果注入 prompt', () => {
    const prompt = buildCocoPrompt(
      assignment,
      [
        {
          taskId: 'T0',
          role: 'planner',
          taskType: 'planning',
          status: 'completed',
          summary: '已经完成方案拆解',
          attempt: 1
        }
      ],
      undefined,
      skillRegistry
    )
    expect(prompt).toContain('上游任务结果:')
    expect(prompt).toContain('T0 | role=planner | taskType=planning | status=completed | attempt=1')
    expect(prompt).toContain('summary: 已经完成方案拆解')
  })

  it('允许通过外部 prompt 配置覆盖角色 opening', () => {
    const templates: RolePromptTemplateRegistry = {
      roles: {
        coder: {
          role: 'coder',
          opening: '你是外部配置的实现者。',
          responsibilities: ['按配置执行'],
          outputContract: ['只输出 JSON']
        }
      }
    }

    const prompt = buildCocoPrompt(assignment, [], templates, skillRegistry)
    expect(prompt).toContain('你是外部配置的实现者。')
  })

  it('解析 coco JSON 输出', async () => {
    const adapter = new CocoCliAdapter({
      runner: {
        async run() {
          return {
            stdout: '{"status":"completed","summary":"mock success"}',
            stderr: ''
          }
        }
      }
    })

    const result = await adapter.execute({ assignment, dependencyResults: [] })
    expect(result.status).toBe('completed')
    expect(result.summary).toBe('mock success')
    expect(result.model).toBe('gpt5.3-codex')
    expect(result.attempt).toBe(1)
  })

  it('在非 JSON 输出时回退为原始 summary', async () => {
    const adapter = new CocoCliAdapter({
      runner: {
        async run() {
          return {
            stdout: 'plain text summary',
            stderr: ''
          }
        }
      }
    })

    const result = await adapter.execute({ assignment, dependencyResults: [] })
    expect(result.status).toBe('completed')
    expect(result.summary).toBe('plain text summary')
  })

  it('PTY 模式会从终端屏幕输出中提取 JSON 结果', async () => {
    const adapter = new CocoCliAdapter({
      mode: 'pty',
      runner: {
        async run() {
          return {
            stdout: [
              '✽ Thinking...',
              '⏺ {"status',
              '  ":"compl',
              '  eted","s',
              '  ummary":',
              '  "mock ok"}',
              '╭─────╮',
              '│ > A │'
            ].join('\n'),
            stderr: ''
          }
        }
      }
    })

    const result = await adapter.execute({ assignment, dependencyResults: [] })
    expect(result.status).toBe('completed')
    expect(result.summary).toBe('mock ok')
  })

  it('auto 模式会在 print 返回坏摘要时降级到 pty', async () => {
    const adapter = new AutoFallbackCocoAdapter({
      printRunner: {
        async run() {
          return {
            stdout: 'Explore(',
            stderr: ''
          }
        }
      },
      ptyRunner: {
        async run() {
          return {
            stdout: [
              '✽ Thinking...',
              '⏺ {"status',
              '  ":"compl',
              '  eted","s',
              '  ummary":',
              '  "fallback ok"}'
            ].join('\n'),
            stderr: ''
          }
        }
      }
    })

    const result = await adapter.execute({ assignment, dependencyResults: [] })
    expect(result.status).toBe('completed')
    expect(result.summary).toBe('fallback ok')
  })

  it('auto 模式会在 print 出现 SIGPIPE 时降级到 pty', async () => {
    const adapter = new AutoFallbackCocoAdapter({
      printRunner: {
        async run() {
          const error = new Error('Command failed: coco print broken') as Error & {
            signal?: string
            stderr?: string
          }
          error.signal = 'SIGPIPE'
          error.stderr = 'broken pipe'
          throw error
        }
      },
      ptyRunner: {
        async run() {
          return {
            stdout: '{"status":"completed","summary":"pty recovered"}',
            stderr: ''
          }
        }
      }
    })

    const result = await adapter.execute({ assignment, dependencyResults: [] })
    expect(result.status).toBe('completed')
    expect(result.summary).toBe('pty recovered')
  })

  it('auto 模式在两条路径都不可信时返回 failed', async () => {
    const adapter = new AutoFallbackCocoAdapter({
      printRunner: {
        async run() {
          return {
            stdout: 'Explore(',
            stderr: ''
          }
        }
      },
      ptyRunner: {
        async run() {
          return {
            stdout: 'broken output',
            stderr: ''
          }
        }
      }
    })

    const result = await adapter.execute({ assignment, dependencyResults: [] })
    expect(result.status).toBe('failed')
    expect(result.summary).toContain('print')
    expect(result.summary).toContain('pty')
  })

  it('在 runner 超时时保留 stdout 和 stderr 作为失败摘要', async () => {
    const adapter = new CocoCliAdapter({
      timeoutMs: 120000,
      runner: {
        async run() {
          const error = new Error('Command failed: coco timed out') as Error & {
            stdout?: string
            stderr?: string
            code?: string
            signal?: string
          }
          error.stdout = 'partial stdout'
          error.stderr = 'Request timeout after 120000ms'
          error.signal = 'SIGTERM'
          throw error
        }
      }
    })

    const result = await adapter.execute({ assignment, dependencyResults: [] })
    expect(result.status).toBe('failed')
    expect(result.summary).toContain('Request timeout after 120000ms')
    expect(result.summary).toContain('partial stdout')
  })
})
