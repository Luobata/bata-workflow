import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { DispatchAssignment, TaskExecutionResult, UpstreamTaskContext } from '../domain/types.js'
import { buildRolePromptSection } from '../team/prompt-templates.js'
import type { RolePromptTemplateRegistry } from '../team/prompt-loader.js'
import type { SkillRegistry } from '../team/skill-registry.js'

const execFileAsync = promisify(execFile)

export interface CocoExecutionRequest {
  assignment: DispatchAssignment
  dependencyResults: UpstreamTaskContext[]
}

export interface CocoRunner {
  run(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }>
}

export interface CocoAdapter {
  execute(request: CocoExecutionRequest): Promise<TaskExecutionResult>
}

export interface CocoCliAdapterOptions {
  command?: string
  timeoutMs?: number
  allowedTools?: string[]
  yolo?: boolean
  runner?: CocoRunner
  promptTemplates?: RolePromptTemplateRegistry
  skillRegistry?: SkillRegistry
}

interface CocoStructuredOutput {
  status?: 'completed' | 'failed'
  summary?: string
}

class ProcessCocoRunner implements CocoRunner {
  constructor(private readonly command: string) {}

  async run(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    const result = await execFileAsync(this.command, args, {
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024
    })

    return {
      stdout: result.stdout,
      stderr: result.stderr
    }
  }
}

export function buildCocoPrompt(
  assignment: DispatchAssignment,
  dependencyResults: UpstreamTaskContext[] = [],
  promptTemplates?: RolePromptTemplateRegistry,
  skillRegistry?: SkillRegistry
): string {
  const { task, modelResolution, roleDefinition } = assignment
  const acceptance = task.acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`).join('\n')
  const dependencySection =
    dependencyResults.length === 0
      ? ['上游任务结果:', '- none']
      : [
          '上游任务结果:',
          ...dependencyResults.flatMap((dependency, index) => [
            `${index + 1}. ${dependency.taskId} | role=${dependency.role} | taskType=${dependency.taskType} | status=${dependency.status} | attempt=${dependency.attempt ?? 'n/a'}`,
            `   summary: ${dependency.summary ?? '(no summary)'}`
          ])
        ]

  return [
    '你是一个被 harness 调度的执行角色。请只完成当前任务，不要扩展范围。',
    buildRolePromptSection(assignment, promptTemplates, skillRegistry),
    `任务ID: ${task.id}`,
    `角色: ${roleDefinition.name}`,
    `任务类型: ${task.taskType}`,
    `模型要求: ${modelResolution.model}`,
    `模型来源: ${modelResolution.source}`,
    `任务标题: ${task.title}`,
    `任务描述: ${task.description}`,
    ...dependencySection,
    '验收条件:',
    acceptance,
    '你必须只输出 JSON，不要输出 markdown 代码块，不要输出额外解释。',
    'JSON schema: {"status":"completed|failed","summary":"string"}'
  ].join('\n')
}

function parseJsonObject(raw: string): CocoStructuredOutput | null {
  const trimmed = raw.trim()

  const candidates = [trimmed]
  const codeFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (codeFenceMatch?.[1]) {
    candidates.unshift(codeFenceMatch[1].trim())
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/)
  if (objectMatch?.[0]) {
    candidates.push(objectMatch[0])
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as CocoStructuredOutput
    } catch {
      // continue
    }
  }

  return null
}

export function buildCocoCliArgs(params: {
  prompt: string
  timeoutMs: number
  allowedTools?: string[]
  yolo?: boolean
}): string[] {
  const args = ['-p']
  const timeoutSeconds = Math.max(1, Math.ceil(params.timeoutMs / 1000))
  args.push('--query-timeout', `${timeoutSeconds}s`)

  for (const tool of params.allowedTools ?? []) {
    args.push('--allowed-tool', tool)
  }

  if (params.yolo) {
    args.push('--yolo')
  }

  args.push(params.prompt)
  return args
}

export class CocoCliAdapter implements CocoAdapter {
  private readonly command: string
  private readonly timeoutMs: number
  private readonly allowedTools: string[]
  private readonly yolo: boolean
  private readonly runner: CocoRunner
  private readonly promptTemplates?: RolePromptTemplateRegistry
  private readonly skillRegistry?: SkillRegistry

  constructor(options: CocoCliAdapterOptions = {}) {
    this.command = options.command ?? 'coco'
    this.timeoutMs = options.timeoutMs ?? 120000
    this.allowedTools = options.allowedTools ?? []
    this.yolo = options.yolo ?? false
    this.runner = options.runner ?? new ProcessCocoRunner(this.command)
    this.promptTemplates = options.promptTemplates
    this.skillRegistry = options.skillRegistry
  }

  async execute({ assignment, dependencyResults }: CocoExecutionRequest): Promise<TaskExecutionResult> {
    const prompt = buildCocoPrompt(assignment, dependencyResults, this.promptTemplates, this.skillRegistry)
    const args = buildCocoCliArgs({
      prompt,
      timeoutMs: this.timeoutMs,
      allowedTools: this.allowedTools,
      yolo: this.yolo
    })
    const { stdout, stderr } = await this.runner.run(args, this.timeoutMs)
    const parsed = parseJsonObject(stdout)

    return {
      taskId: assignment.task.id,
      role: assignment.roleDefinition.name,
      model: assignment.modelResolution.model,
      status: parsed?.status === 'failed' ? 'failed' : 'completed',
      summary: parsed?.summary?.trim() || stdout.trim() || stderr.trim() || 'coco 未返回 summary',
      attempt: 1
    }
  }
}

export class DryRunCocoAdapter implements CocoAdapter {
  async execute({ assignment }: CocoExecutionRequest): Promise<TaskExecutionResult> {
    const { task, modelResolution, roleDefinition } = assignment

    return {
      taskId: task.id,
      role: roleDefinition.name,
      model: modelResolution.model,
      status: 'completed',
      attempt: 1,
      summary: [
        `[dry-run] role=${roleDefinition.name}`,
        `taskType=${task.taskType}`,
        `model=${modelResolution.model}`,
        `source=${modelResolution.source}`,
        `reason=${modelResolution.reason}`
      ].join(' | ')
    }
  }
}
