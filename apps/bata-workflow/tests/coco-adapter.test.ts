import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { DispatchAssignment } from '../src/domain/types.js'
import { AutoFallbackCocoAdapter, CocoCliAdapter, buildCocoCliArgs, buildCocoPrompt, buildCocoPtyCliArgs } from '../src/runtime/coco-adapter.js'
import type { RolePromptTemplateRegistry } from '../src/team/prompt-loader.js'
import { loadSkills } from '../src/team/skill-loader.js'
import { buildSkillRegistry } from '../src/team/skill-registry.js'

const skillsConfigPath = resolve(import.meta.dirname, '../configs/skills.yaml')
const skillRegistry = buildSkillRegistry(loadSkills(skillsConfigPath))

function createRecordingCli(params: {
  directory: string
  name: string
  recordPath: string
  behavior?: 'success' | 'print-bad-pty-good'
}): string {
  const { directory, name, recordPath, behavior = 'success' } = params
  const scriptPath = resolve(directory, name)
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { basename } = require('node:path');

const bin = basename(process.argv[1]);
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ bin, argv, stdoutIsTTY: Boolean(process.stdout.isTTY) }) + "\\n", 'utf8');

if (${JSON.stringify(behavior)} === 'print-bad-pty-good') {
  const isPrint = argv.includes('-p') || argv.includes('--print');
  if (isPrint) {
    process.stdout.write('Explore(');
    process.exit(0);
  }

  process.stdout.write('✽ Thinking...\\n');
  setTimeout(() => {
    process.stdout.write('⏺ {"status":"completed","summary":"pty recovered real"}\\n');
    setTimeout(() => process.exit(0), 50);
  }, 50);
  return;
}

process.stdout.write(JSON.stringify({ status: 'completed', summary: bin + ' ok' }));
`,
    'utf8'
  )
  chmodSync(scriptPath, 0o755)
  return scriptPath
}

function createPtyRecordingCli(params: {
  directory: string
  name: string
  recordPath: string
  summary: string
}): string {
  const { directory, name, recordPath, summary } = params
  const scriptPath = resolve(directory, name)
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const { basename } = require('node:path');

const bin = basename(process.argv[1]);
const argv = process.argv.slice(2);
appendFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ bin, argv, stdoutIsTTY: Boolean(process.stdout.isTTY) }) + "\\n", 'utf8');
process.stdout.write('✽ Thinking...\\n');
setTimeout(() => {
  process.stdout.write('⏺ {"status":"completed","summary":${JSON.stringify(summary)}}\\n');
  setTimeout(() => process.exit(0), 50);
}, 50);
`,
    'utf8'
  )
  chmodSync(scriptPath, 0o755)
  return scriptPath
}

function readRecordedInvocations(recordPath: string): Array<{ bin: string; argv: string[]; stdoutIsTTY?: boolean }> {
  return readFileSync(recordPath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { bin: string; argv: string[]; stdoutIsTTY?: boolean })
}

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
  executionTarget: {
    backend: 'coco',
    model: 'gpt5.3-codex',
    source: 'taskType',
    reason: 'taskType=coding 命中 taskTypes 配置',
    transport: 'auto'
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

  it('prompt 会优先注入 executionTarget 字段而不是旧的 modelResolution 元数据', () => {
    const targetAwareAssignment: DispatchAssignment = {
      ...assignment,
      modelResolution: {
        model: 'legacy-model',
        source: 'taskType',
        reason: 'old resolution metadata'
      },
      executionTarget: {
        backend: 'local-cc',
        model: 'target-model',
        profile: 'cc-target',
        command: 'custom-cc',
        source: 'slot-override',
        reason: 'slot override target',
        transport: 'pty'
      }
    }

    const prompt = buildCocoPrompt(targetAwareAssignment, [], undefined, skillRegistry)

    expect(prompt).toContain('执行后端: local-cc')
    expect(prompt).toContain('模型要求: target-model')
    expect(prompt).toContain('模型来源: slot-override')
    expect(prompt).toContain('策略来源: taskType')
    expect(prompt).toContain('执行 profile: cc-target')
    expect(prompt).toContain('执行命令: custom-cc')
    expect(prompt).toContain('传输模式: pty')
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
    expect(result.backend).toBe('coco')
    expect(result.transport).toBe('auto')
    expect(result.attempt).toBe(1)
  })

  it('执行结果回填 executionTarget 元数据', async () => {
    const targetAwareAssignment: DispatchAssignment = {
      ...assignment,
      executionTarget: {
        backend: 'local-cc',
        model: 'sonnet',
        profile: 'cc-local',
        command: 'cc',
        source: 'slot-override',
        reason: 'slot 2 override',
        transport: 'print'
      }
    }
    const adapter = new CocoCliAdapter({
      runner: {
        async run() {
          return {
            stdout: '{"status":"completed","summary":"slot routed"}',
            stderr: ''
          }
        }
      }
    })

    const result = await adapter.execute({ assignment: targetAwareAssignment, dependencyResults: [] })

    expect(result.model).toBe('sonnet')
    expect(result.backend).toBe('local-cc')
    expect(result.profile).toBe('cc-local')
    expect(result.command).toBe('cc')
    expect(result.transport).toBe('print')
  })

  it('默认命令下也会按 executionTarget.transport 切到真实 PTY runner', async () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-coco-pty-route-'))
    const binDir = resolve(tempRoot, 'bin')
    mkdirSync(binDir, { recursive: true })
    const recordPath = resolve(tempRoot, 'pty-route-record.ndjson')
    createPtyRecordingCli({ directory: binDir, name: 'cc', recordPath, summary: 'pty route ok' })

    const transportAwareAssignment: DispatchAssignment = {
      ...assignment,
      executionTarget: {
        backend: 'local-cc',
        model: 'sonnet-pty',
        profile: 'cc-pty',
        source: 'slot-override',
        reason: 'transport routing test',
        transport: 'pty'
      }
    }
    const previousPath = process.env.PATH ?? ''
    process.env.PATH = `${binDir}:${previousPath}`

    try {
      const adapter = new CocoCliAdapter({ mode: 'print' })
      const result = await adapter.execute({ assignment: transportAwareAssignment, dependencyResults: [] })
      const [invocation] = readRecordedInvocations(recordPath)

      expect(result.summary).toBe('pty route ok')
      expect(result.transport).toBe('pty')
      expect(invocation?.bin).toBe('cc')
      expect(invocation?.stdoutIsTTY).toBe(true)
      expect(invocation?.argv).toEqual(expect.arrayContaining(['--dangerously-skip-permissions', '--profile', 'cc-pty', '--model', 'sonnet-pty']))
      expect(invocation?.argv).not.toContain('--print')
    } finally {
      process.env.PATH = previousPath
    }
  })

  it('未显式 command 时会按 backend 路由到 claude 与 cc', async () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-coco-backend-route-'))
    const binDir = resolve(tempRoot, 'bin')
    mkdirSync(binDir, { recursive: true })
    const recordPath = resolve(tempRoot, 'backend-record.ndjson')
    createRecordingCli({ directory: binDir, name: 'claude', recordPath })
    createRecordingCli({ directory: binDir, name: 'cc', recordPath })

    const previousPath = process.env.PATH ?? ''
    process.env.PATH = `${binDir}:${previousPath}`

    try {
      const claudeAssignment: DispatchAssignment = {
        ...assignment,
        executionTarget: {
          backend: 'claude-code',
          model: 'sonnet',
          profile: 'review-profile',
          source: 'role',
          reason: 'review role target',
          transport: 'print'
        }
      }
      const localCcAssignment: DispatchAssignment = {
        ...assignment,
        executionTarget: {
          backend: 'local-cc',
          model: 'sonnet-local',
          profile: 'cc-local',
          source: 'slot-override',
          reason: 'slot 2 local cc',
          transport: 'print'
        }
      }

      const adapter = new CocoCliAdapter()
      const claudeResult = await adapter.execute({ assignment: claudeAssignment, dependencyResults: [] })
      const localCcResult = await adapter.execute({ assignment: localCcAssignment, dependencyResults: [] })
      const invocations = readRecordedInvocations(recordPath)
      const claudeInvocation = invocations.find((item) => item.bin === 'claude')
      const localCcInvocation = invocations.find((item) => item.bin === 'cc')

      expect(claudeResult.summary).toBe('claude ok')
      expect(localCcResult.summary).toBe('cc ok')
      expect(claudeInvocation?.argv).toEqual(expect.arrayContaining(['--dangerously-skip-permissions', '--profile', 'review-profile', '--model', 'sonnet', '--print']))
      expect(localCcInvocation?.argv).toEqual(expect.arrayContaining(['--dangerously-skip-permissions', '--profile', 'cc-local', '--model', 'sonnet-local', '--print']))
    } finally {
      process.env.PATH = previousPath
    }
  })

  it('coco-auto 在固定 transport 下也会按 backend 路由到对应命令', async () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-coco-auto-route-'))
    const binDir = resolve(tempRoot, 'bin')
    mkdirSync(binDir, { recursive: true })
    const recordPath = resolve(tempRoot, 'auto-route-record.ndjson')
    createRecordingCli({ directory: binDir, name: 'claude', recordPath })
    createRecordingCli({ directory: binDir, name: 'cc', recordPath })

    const previousPath = process.env.PATH ?? ''
    process.env.PATH = `${binDir}:${previousPath}`

    try {
      const autoAdapter = new AutoFallbackCocoAdapter()
      const claudeAssignment: DispatchAssignment = {
        ...assignment,
        executionTarget: {
          backend: 'claude-code',
          model: 'sonnet-auto',
          profile: 'review-auto',
          source: 'role',
          reason: 'auto claude route',
          transport: 'print'
        }
      }
      const localCcAssignment: DispatchAssignment = {
        ...assignment,
        executionTarget: {
          backend: 'local-cc',
          model: 'cc-sonnet-auto',
          profile: 'cc-auto',
          source: 'slot-override',
          reason: 'auto local cc route',
          transport: 'print'
        }
      }

      const claudeResult = await autoAdapter.execute({ assignment: claudeAssignment, dependencyResults: [] })
      const localCcResult = await autoAdapter.execute({ assignment: localCcAssignment, dependencyResults: [] })
      const invocations = readRecordedInvocations(recordPath)
      const claudeInvocations = invocations.filter((item) => item.bin === 'claude')
      const localCcInvocations = invocations.filter((item) => item.bin === 'cc')
      const claudeInvocation = claudeInvocations[0]
      const localCcInvocation = localCcInvocations[0]

      expect(claudeResult.summary).toBe('claude ok')
      expect(localCcResult.summary).toBe('cc ok')
      expect(invocations).toHaveLength(2)
      expect(claudeInvocations).toHaveLength(1)
      expect(localCcInvocations).toHaveLength(1)
      expect(claudeInvocation?.argv).toEqual(expect.arrayContaining(['--dangerously-skip-permissions', '--profile', 'review-auto', '--model', 'sonnet-auto', '--print']))
      expect(localCcInvocation?.argv).toEqual(expect.arrayContaining(['--dangerously-skip-permissions', '--profile', 'cc-auto', '--model', 'cc-sonnet-auto', '--print']))
    } finally {
      process.env.PATH = previousPath
    }
  })

  it('coco-auto 在固定 transport=pty 下会直接走 PTY backend 命令', async () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-coco-auto-pty-'))
    const binDir = resolve(tempRoot, 'bin')
    mkdirSync(binDir, { recursive: true })
    const recordPath = resolve(tempRoot, 'auto-pty-record.ndjson')
    createPtyRecordingCli({ directory: binDir, name: 'cc', recordPath, summary: 'auto pty ok' })

    const previousPath = process.env.PATH ?? ''
    process.env.PATH = `${binDir}:${previousPath}`

    try {
      const autoPtyAssignment: DispatchAssignment = {
        ...assignment,
        executionTarget: {
          backend: 'local-cc',
          model: 'cc-pty-auto',
          profile: 'cc-auto-pty',
          source: 'slot-override',
          reason: 'auto adapter pty route',
          transport: 'pty'
        }
      }

      const adapter = new AutoFallbackCocoAdapter()
      const result = await adapter.execute({ assignment: autoPtyAssignment, dependencyResults: [] })
      const [invocation] = readRecordedInvocations(recordPath)

      expect(result.status).toBe('completed')
      expect(result.summary).toBe('auto pty ok')
      expect(result.transport).toBe('pty')
      expect(invocation?.bin).toBe('cc')
      expect(invocation?.stdoutIsTTY).toBe(true)
      expect(invocation?.argv).toEqual(expect.arrayContaining(['--dangerously-skip-permissions', '--profile', 'cc-auto-pty', '--model', 'cc-pty-auto']))
      expect(invocation?.argv).not.toContain('--print')
    } finally {
      process.env.PATH = previousPath
    }
  })

  it('显式 executionTarget.command 会优先于 backend 默认命令', async () => {
    const tempRoot = mkdtempSync(resolve(tmpdir(), 'bata-workflow-coco-command-priority-'))
    const binDir = resolve(tempRoot, 'bin')
    mkdirSync(binDir, { recursive: true })
    const recordPath = resolve(tempRoot, 'command-priority-record.ndjson')
    createRecordingCli({ directory: binDir, name: 'custom-cc', recordPath })
    createRecordingCli({ directory: binDir, name: 'cc', recordPath })

    const previousPath = process.env.PATH ?? ''
    process.env.PATH = `${binDir}:${previousPath}`

    try {
      const commandAwareAssignment: DispatchAssignment = {
        ...assignment,
        executionTarget: {
          backend: 'local-cc',
          model: 'sonnet-custom',
          profile: 'cc-custom',
          command: 'custom-cc',
          source: 'slot-override',
          reason: 'explicit command should win',
          transport: 'print'
        }
      }

      const adapter = new CocoCliAdapter()
      const result = await adapter.execute({ assignment: commandAwareAssignment, dependencyResults: [] })
      const invocations = readRecordedInvocations(recordPath)

      expect(result.summary).toBe('custom-cc ok')
      expect(invocations).toHaveLength(1)
      expect(invocations[0]?.bin).toBe('custom-cc')
      expect(invocations[0]?.argv).toEqual(expect.arrayContaining(['--dangerously-skip-permissions', '--profile', 'cc-custom', '--model', 'sonnet-custom', '--print']))
    } finally {
      process.env.PATH = previousPath
    }
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
