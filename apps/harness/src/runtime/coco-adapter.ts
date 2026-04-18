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
  mode?: 'print' | 'pty'
  runner?: CocoRunner
  promptTemplates?: RolePromptTemplateRegistry
  skillRegistry?: SkillRegistry
}

export interface AutoFallbackCocoAdapterOptions {
  command?: string
  timeoutMs?: number
  allowedTools?: string[]
  yolo?: boolean
  printRunner?: CocoRunner
  ptyRunner?: CocoRunner
  promptTemplates?: RolePromptTemplateRegistry
  skillRegistry?: SkillRegistry
}

interface CocoStructuredOutput {
  status?: 'completed' | 'failed'
  summary?: string
}

interface CocoExecutionError extends Error {
  stdout?: string
  stderr?: string
  code?: string | number
  signal?: string
}

interface CocoExecutionOutcome {
  result: TaskExecutionResult
  parsed: CocoStructuredOutput | null
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

class PtyCocoRunner implements CocoRunner {
  constructor(private readonly command: string) {}

  async run(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    const result = await execFileAsync(
      'python3',
      [
        '-c',
        String.raw`import os, pty, select, subprocess, sys, time

command = sys.argv[1]
timeout_ms = int(sys.argv[2])
args = [command, *sys.argv[3:]]

master, slave = pty.openpty()
proc = subprocess.Popen(args, stdin=slave, stdout=slave, stderr=slave, close_fds=True)
os.close(slave)

chunks = []
start = time.time()
last_output = start
response_seen = False

while True:
    now = time.time()
    if now - start > timeout_ms / 1000.0:
        break

    readable, _, _ = select.select([master], [], [], 0.2)
    if master in readable:
        try:
            data = os.read(master, 4096)
        except OSError:
            break

        if not data:
            break

        chunks.append(data)
        last_output = time.time()

        if b'\xe2\x8f\xba' in data or b'{"status' in data or b'"summary"' in data:
            response_seen = True

    if proc.poll() is not None:
        break

    if response_seen and now - last_output > 1.0:
        break

if proc.poll() is None:
    proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()

sys.stdout.buffer.write(b''.join(chunks))`,
        this.command,
        `${timeoutMs}`,
        ...args
      ],
      {
        timeout: timeoutMs + 3000,
        maxBuffer: 1024 * 1024 * 8
      }
    )

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

export function isCredibleCompletedSummary(summary: string): boolean {
  const trimmed = summary.trim()

  if (!trimmed) {
    return false
  }

  if (/^[A-Z][A-Za-z0-9_.-]*\($/.test(trimmed)) {
    return false
  }

  if (/[({\[]$/.test(trimmed)) {
    return false
  }

  return true
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

export function buildCocoPtyCliArgs(params: {
  prompt: string
  timeoutMs: number
  allowedTools?: string[]
  yolo?: boolean
}): string[] {
  const args: string[] = []
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

function stripTerminalControl(raw: string): string {
  return raw
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
}

function isPtyChromeLine(line: string): boolean {
  const trimmed = line.trim()
  return (
    trimmed.length === 0 ||
    trimmed.startsWith('╭') ||
    trimmed.startsWith('╰') ||
    trimmed.startsWith('│ >') ||
    trimmed.startsWith('$/!') ||
    trimmed.startsWith('⬡ ') ||
    trimmed.startsWith('initializing MCP servers') ||
    trimmed.startsWith('upgrading') ||
    trimmed.includes('Thinking...') ||
    trimmed.startsWith('Thought')
  )
}

export function extractPtyAssistantOutput(raw: string): string {
  const cleaned = stripTerminalControl(raw)
  const lines = cleaned.split('\n')
  const blocks: string[][] = []

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const markerIndex = line.indexOf('⏺')
    if (markerIndex < 0) {
      continue
    }

    const block: string[] = []
    const firstLine = line.slice(markerIndex + 1).trim()
    if (firstLine) {
      block.push(firstLine)
    }

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const continuation = lines[cursor]!
      if (continuation.includes('⏺') || isPtyChromeLine(continuation)) {
        break
      }

      const trimmed = continuation.trim()
      if (trimmed) {
        block.push(trimmed)
      }
    }

    if (block.length > 0) {
      blocks.push(block)
    }
  }

  const lastBlock = blocks.at(-1)
  if (!lastBlock) {
    return cleaned.trim()
  }

  const compact = lastBlock.join('').trim()
  if (compact.startsWith('{') || compact.startsWith('[')) {
    return compact
  }

  return lastBlock.join(' ').replace(/\s+/g, ' ').trim()
}

async function executeWithRunner(params: {
  assignment: DispatchAssignment
  dependencyResults: UpstreamTaskContext[]
  timeoutMs: number
  allowedTools: string[]
  yolo: boolean
  mode: 'print' | 'pty'
  runner: CocoRunner
  promptTemplates?: RolePromptTemplateRegistry
  skillRegistry?: SkillRegistry
}): Promise<CocoExecutionOutcome> {
  const { assignment, dependencyResults, timeoutMs, allowedTools, yolo, mode, runner, promptTemplates, skillRegistry } = params
  const prompt = buildCocoPrompt(assignment, dependencyResults, promptTemplates, skillRegistry)
  const args = (mode === 'pty' ? buildCocoPtyCliArgs : buildCocoCliArgs)({
    prompt,
    timeoutMs,
    allowedTools,
    yolo
  })

  try {
    const { stdout, stderr } = await runner.run(args, timeoutMs)
    const normalizedStdout = mode === 'pty' ? extractPtyAssistantOutput(stdout) : stdout
    const parsed = parseJsonObject(normalizedStdout)

    return {
      parsed,
      result: {
        taskId: assignment.task.id,
        role: assignment.roleDefinition.name,
        model: assignment.modelResolution.model,
        status: parsed?.status === 'failed' ? 'failed' : 'completed',
        summary: parsed?.summary?.trim() || normalizedStdout.trim() || stderr.trim() || 'coco 未返回 summary',
        attempt: 1
      }
    }
  }
  catch (error) {
    const cocoError = error as CocoExecutionError
    const parts = [
      cocoError.stderr?.trim(),
      cocoError.stdout?.trim(),
      cocoError.message?.trim(),
      cocoError.signal ? `signal=${cocoError.signal}` : null,
      cocoError.code != null ? `code=${cocoError.code}` : null
    ].filter((part): part is string => Boolean(part))

    return {
      parsed: null,
      result: {
        taskId: assignment.task.id,
        role: assignment.roleDefinition.name,
        model: assignment.modelResolution.model,
        status: 'failed',
        summary: parts.join(' | ') || 'coco 执行失败',
        attempt: 1
      }
    }
  }
}

function isTrustworthyCompletedOutcome(outcome: CocoExecutionOutcome): boolean {
  return (
    outcome.result.status === 'completed' &&
    outcome.parsed?.status === 'completed' &&
    isCredibleCompletedSummary(outcome.result.summary)
  )
}

function summarizeFallbackOutcome(label: 'print' | 'pty', outcome: CocoExecutionOutcome): string {
  if (isTrustworthyCompletedOutcome(outcome)) {
    return `${label}: completed`
  }

  if (outcome.result.status === 'completed') {
    if (outcome.parsed?.status !== 'completed') {
      return `${label}: 输出缺少可信 JSON completed 结果 | summary=${outcome.result.summary}`
    }

    return `${label}: completed 摘要不可信 | summary=${outcome.result.summary}`
  }

  return `${label}: ${outcome.result.summary}`
}

export class CocoCliAdapter implements CocoAdapter {
  private readonly command: string
  private readonly timeoutMs: number
  private readonly allowedTools: string[]
  private readonly yolo: boolean
  private readonly mode: 'print' | 'pty'
  private readonly runner: CocoRunner
  private readonly promptTemplates?: RolePromptTemplateRegistry
  private readonly skillRegistry?: SkillRegistry

  constructor(options: CocoCliAdapterOptions = {}) {
    this.command = options.command ?? 'coco'
    this.timeoutMs = options.timeoutMs ?? 120000
    this.allowedTools = options.allowedTools ?? []
    this.yolo = options.yolo ?? false
    this.mode = options.mode ?? 'print'
    this.runner = options.runner ?? (this.mode === 'pty' ? new PtyCocoRunner(this.command) : new ProcessCocoRunner(this.command))
    this.promptTemplates = options.promptTemplates
    this.skillRegistry = options.skillRegistry
  }

  async execute({ assignment, dependencyResults }: CocoExecutionRequest): Promise<TaskExecutionResult> {
    const outcome = await executeWithRunner({
      assignment,
      dependencyResults,
      timeoutMs: this.timeoutMs,
      allowedTools: this.allowedTools,
      yolo: this.yolo,
      mode: this.mode,
      runner: this.runner,
      promptTemplates: this.promptTemplates,
      skillRegistry: this.skillRegistry
    })

    return outcome.result
  }
}

export class AutoFallbackCocoAdapter implements CocoAdapter {
  private readonly timeoutMs: number
  private readonly allowedTools: string[]
  private readonly yolo: boolean
  private readonly printRunner: CocoRunner
  private readonly ptyRunner: CocoRunner
  private readonly promptTemplates?: RolePromptTemplateRegistry
  private readonly skillRegistry?: SkillRegistry

  constructor(options: AutoFallbackCocoAdapterOptions = {}) {
    const command = options.command ?? 'coco'
    this.timeoutMs = options.timeoutMs ?? 120000
    this.allowedTools = options.allowedTools ?? []
    this.yolo = options.yolo ?? false
    this.printRunner = options.printRunner ?? new ProcessCocoRunner(command)
    this.ptyRunner = options.ptyRunner ?? new PtyCocoRunner(command)
    this.promptTemplates = options.promptTemplates
    this.skillRegistry = options.skillRegistry
  }

  async execute({ assignment, dependencyResults }: CocoExecutionRequest): Promise<TaskExecutionResult> {
    const printOutcome = await executeWithRunner({
      assignment,
      dependencyResults,
      timeoutMs: this.timeoutMs,
      allowedTools: this.allowedTools,
      yolo: this.yolo,
      mode: 'print',
      runner: this.printRunner,
      promptTemplates: this.promptTemplates,
      skillRegistry: this.skillRegistry
    })

    if (isTrustworthyCompletedOutcome(printOutcome)) {
      return printOutcome.result
    }

    const ptyOutcome = await executeWithRunner({
      assignment,
      dependencyResults,
      timeoutMs: this.timeoutMs,
      allowedTools: this.allowedTools,
      yolo: this.yolo,
      mode: 'pty',
      runner: this.ptyRunner,
      promptTemplates: this.promptTemplates,
      skillRegistry: this.skillRegistry
    })

    if (isTrustworthyCompletedOutcome(ptyOutcome)) {
      return ptyOutcome.result
    }

    return {
      taskId: assignment.task.id,
      role: assignment.roleDefinition.name,
      model: assignment.modelResolution.model,
      status: 'failed',
      summary: [summarizeFallbackOutcome('print', printOutcome), summarizeFallbackOutcome('pty', ptyOutcome)].join(' | '),
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
