import { z } from 'zod'

/**
 * Task Phase - 任务阶段
 */
export const TaskPhaseSchema = z.enum(['analysis', 'implementation', 'validation'])
export type TaskPhase = z.infer<typeof TaskPhaseSchema>

/**
 * Task Status - 任务状态
 */
export const TaskStatusSchema = z.enum(['pending', 'in_progress', 'done', 'blocked'])
export type TaskStatus = z.infer<typeof TaskStatusSchema>

/**
 * Task History Entry - 任务历史记录
 */
export const TaskHistoryEntrySchema = z.object({
  at: z.string().datetime(),
  event: z.string(),
  round: z.number().int().nonnegative().optional(),
  summary: z.string().optional(),
  message: z.string().optional(),
})
export type TaskHistoryEntry = z.infer<typeof TaskHistoryEntrySchema>

/**
 * Task Channel - 任务间通信上下文
 */
export const TaskChannelSchema = z.object({
  codingToReview: z.string(),
  reviewToCoding: z.string(),
  lastUpdatedAt: z.string().nullable(),
})
export type TaskChannel = z.infer<typeof TaskChannelSchema>

/**
 * Task Contract - 任务契约（完整任务定义）
 */
export const TaskContractSchema = z.object({
  // 基础字段
  id: z.string().min(1),
  title: z.string().min(1),
  status: TaskStatusSchema,
  phase: TaskPhaseSchema.optional(), // 可选，用于向后兼容
  deps: z.array(z.string()),

  // 契约字段
  acceptance: z.array(z.string()).min(1),
  verification_cmds: z.array(z.string()),
  deliverables: z.array(z.string()),
  handoffChecklist: z.array(z.string()),
  scopeRules: z.array(z.string()),
  executionHints: z.array(z.string()),
  completionDefinition: z.string(),

  // 上下文字段
  backgroundContext: z.string(),
  sourceRefs: z.array(z.string()),

  // 执行状态
  reviewRounds: z.number().int().nonnegative(),
  lastAdvicePath: z.string().nullable(),
  history: z.array(TaskHistoryEntrySchema),

  // Channel通信
  channel: TaskChannelSchema,
})
export type TaskContract = z.infer<typeof TaskContractSchema>

/**
 * Normalize Task - 归一化任务数据（处理旧格式数据）
 */
export function normalizeTask(
  task: Partial<TaskContract> & { id: string; title: string },
  index: number,
  previousTaskId: string | null = null
): TaskContract {
  const title = typeof task?.title === 'string' && task.title.trim() ? task.title.trim() : `子任务${index + 1}`
  const defaultAcceptance = [`完成: ${title}`, '输出可验证结果，不留占位符']
  const defaultVerificationCommands = ['echo "manual verification required"']
  const depsFromTask = Array.isArray(task?.deps) ? task.deps : Array.isArray(task?.dependsOn) ? task.dependsOn : []
  const deps = depsFromTask.length > 0 ? depsFromTask : (previousTaskId ? [previousTaskId] : [])

  return {
    id: task.id,
    title,
    status: task.status ?? 'pending',
    phase: task.phase,
    deps,
    acceptance: task.acceptance ?? defaultAcceptance,
    verification_cmds: task.verification_cmds ?? defaultVerificationCommands,
    deliverables: task.deliverables ?? [
      '本轮完成项与对应证据',
      '关键风险、限制与后续建议',
    ],
    handoffChecklist: task.handoffChecklist ?? [
      '总结已完成/未完成内容',
      '给下一角色提供最小充分上下文',
    ],
    scopeRules: task.scopeRules ?? [
      '只处理当前子任务范围，不跨任务实现。',
      '不允许占位符实现，输出必须可验证。',
      '缺少关键上下文时返回 NEEDS_CONTEXT 并列出缺失信息。',
    ],
    executionHints: task.executionHints ?? [
      '严格对齐当前功能点与 acceptance 执行。',
      '输出可复验证据，避免描述性空话。',
    ],
    completionDefinition: task.completionDefinition ?? '完成当前子任务并满足验收标准。',
    backgroundContext: task.backgroundContext ?? '',
    sourceRefs: task.sourceRefs ?? [],
    reviewRounds: task.reviewRounds ?? 0,
    lastAdvicePath: task.lastAdvicePath ?? null,
    history: task.history ?? [],
    channel: task.channel ?? {
      codingToReview: '',
      reviewToCoding: '',
      lastUpdatedAt: null,
    },
  }
}

/**
 * Normalize Tasks - 批量归一化任务列表
 */
export function normalizeTasks(tasks: Array<Partial<TaskContract> & { id: string; title: string }>): TaskContract[] {
  const normalized: TaskContract[] = []
  for (let index = 0; index < tasks.length; index++) {
    const previousTaskId = normalized[index - 1]?.id ?? null
    normalized.push(normalizeTask(tasks[index], index, previousTaskId))
  }
  return normalized
}
