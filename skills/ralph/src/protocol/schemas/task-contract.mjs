#!/usr/bin/env node

/**
 * Task Contract Schema - 任务契约Schema定义
 */

import { z } from 'zod'

/**
 * Task Phase - 任务阶段
 */
export const TaskPhaseSchema = z.enum(['analysis', 'implementation', 'validation'])

/**
 * Task Status - 任务状态
 */
export const TaskStatusSchema = z.enum(['pending', 'in_progress', 'done', 'blocked'])

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

/**
 * Review Focus - 审查重点
 */
export const ReviewFocusSchema = z.object({
  primary: z.array(z.string()),      // 主要审查点（必须检查）
  secondary: z.array(z.string()),    // 次要审查点（建议检查）
  riskAreas: z.array(z.string()),    // 风险区域
})

/**
 * Risk Point - 风险点
 */
export const RiskPointSchema = z.object({
  category: z.enum(['performance', 'security', 'compatibility', 'maintainability', 'correctness']),
  description: z.string(),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  mitigation: z.string().optional(),
})

/**
 * Test Requirement - 测试要求
 */
export const TestRequirementSchema = z.object({
  type: z.enum(['unit', 'integration', 'e2e', 'manual']),
  description: z.string(),
  priority: z.enum(['must', 'should', 'nice-to-have']),
  relatedAcceptance: z.array(z.string()),  // 关联的acceptance条款
})

/**
 * Acceptance Criterion - 验收标准（增强版）
 */
export const AcceptanceCriterionSchema = z.object({
  id: z.string(),
  description: z.string(),
  verification: z.enum(['automated', 'manual', 'review']),
  priority: z.enum(['must', 'should', 'nice-to-have']),
})

/**
 * Review Contract - 审查契约
 */
export const ReviewContractSchema = z.object({
  reviewFocus: ReviewFocusSchema,
  riskPoints: z.array(RiskPointSchema),
  testRequirements: z.array(TestRequirementSchema),
  acceptanceCriteria: z.array(AcceptanceCriterionSchema),
  generatedAt: z.string().datetime(),
  sourceDocument: z.string().optional(),  // 来源文档路径
})

/**
 * Coding Agent Context - Coding Agent 提供的上下文
 */
export const CodingAgentContextSchema = z.object({
  summary: z.string(),
  filesModified: z.array(z.string()),
  testsSuggested: z.array(z.string()),
  contextForPeer: z.string(),
  risksIdentified: z.array(z.object({
    category: z.string(),
    description: z.string(),
    severity: z.enum(['low', 'medium', 'high']),
  })),
  assumptions: z.array(z.string()).optional(),
  pendingDecisions: z.array(z.string()).optional(),
})

/**
 * Review Agent Context - Review Agent 提供的上下文
 */
export const ReviewAgentContextSchema = z.object({
  summary: z.string(),
  requiredFixes: z.array(z.string()),
  requiredTests: z.array(z.string()),
  acceptanceStatus: z.enum(['passed', 'partial', 'failed']),
  severity: z.enum(['none', 'minor', 'major', 'critical']),
  nextAction: z.enum(['continue', 'revise', 'escalate']).optional(),
  adviceToCoding: z.string().optional(),
  blockedReason: z.string().optional(),
})

/**
 * Communication History Entry - 通信历史记录
 */
export const CommunicationHistoryEntrySchema = z.object({
  round: z.number().int().nonnegative(),
  type: z.enum(['communication', 'validation']),
  from: z.enum(['coding', 'review']),
  timestamp: z.string().datetime(),
  summary: z.string(),
})

/**
 * Enhanced Task Channel - 增强的任务通信渠道
 */
export const EnhancedTaskChannelSchema = z.object({
  codingToReview: CodingAgentContextSchema,
  reviewToCoding: ReviewAgentContextSchema,
  communicationHistory: z.array(CommunicationHistoryEntrySchema),
  lastUpdatedAt: z.string().nullable(),
  totalRounds: z.number().int().nonnegative().default(0),
})

/**
 * Task Channel - 任务间通信上下文（旧版，保持兼容）
 */
export const TaskChannelSchema = z.object({
  codingToReview: z.string(),
  reviewToCoding: z.string(),
  lastUpdatedAt: z.string().nullable(),
})

/**
 * Task Contract - 任务契约（完整任务定义）
 */
export const TaskContractSchema = z.object({
  // 基础字段
  id: z.string().min(1),
  title: z.string().min(1),
  status: TaskStatusSchema,
  phase: TaskPhaseSchema.optional(),
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

  // 新增：审查契约（在任务拆分时生成）
  reviewContract: ReviewContractSchema.optional(),

  // 执行状态
  reviewRounds: z.number().int().nonnegative(),
  communicationRounds: z.number().int().nonnegative().default(0),  // 通信轮次
  validationRounds: z.number().int().nonnegative().default(0),     // 校验轮次
  lastAdvicePath: z.string().nullable(),
  history: z.array(TaskHistoryEntrySchema),

  // Channel通信（支持新旧两种格式）
  channel: z.union([
    EnhancedTaskChannelSchema,
    TaskChannelSchema,
  ]),
})

/**
 * Migrate Channel Format - 迁移Channel格式（旧版字符串→新版对象）
 */
const migrateChannelFormat = (channel) => {
  if (!channel) {
    return {
      codingToReview: {
        summary: '',
        filesModified: [],
        testsSuggested: [],
        contextForPeer: '',
        risksIdentified: [],
      },
      reviewToCoding: {
        summary: '',
        requiredFixes: [],
        requiredTests: [],
        acceptanceStatus: 'partial',
        severity: 'none',
      },
      communicationHistory: [],
      lastUpdatedAt: null,
      totalRounds: 0,
    }
  }

  // Check if already enhanced format (object with nested objects)
  if (typeof channel.codingToReview === 'object' && channel.codingToReview !== null) {
    return {
      codingToReview: {
        summary: channel.codingToReview.summary ?? '',
        filesModified: channel.codingToReview.filesModified ?? [],
        testsSuggested: channel.codingToReview.testsSuggested ?? [],
        contextForPeer: channel.codingToReview.contextForPeer ?? '',
        risksIdentified: channel.codingToReview.risksIdentified ?? [],
        assumptions: channel.codingToReview.assumptions ?? [],
        pendingDecisions: channel.codingToReview.pendingDecisions ?? [],
      },
      reviewToCoding: {
        summary: channel.reviewToCoding?.summary ?? '',
        requiredFixes: channel.reviewToCoding?.requiredFixes ?? [],
        requiredTests: channel.reviewToCoding?.requiredTests ?? [],
        acceptanceStatus: channel.reviewToCoding?.acceptanceStatus ?? 'partial',
        severity: channel.reviewToCoding?.severity ?? 'none',
        nextAction: channel.reviewToCoding?.nextAction,
        adviceToCoding: channel.reviewToCoding?.adviceToCoding,
        blockedReason: channel.reviewToCoding?.blockedReason,
      },
      communicationHistory: channel.communicationHistory ?? [],
      lastUpdatedAt: channel.lastUpdatedAt ?? null,
      totalRounds: channel.totalRounds ?? 0,
    }
  }

  // Migrate from string format to enhanced format
  return {
    codingToReview: {
      summary: typeof channel.codingToReview === 'string' ? channel.codingToReview : '',
      filesModified: [],
      testsSuggested: [],
      contextForPeer: typeof channel.codingToReview === 'string' ? channel.codingToReview : '',
      risksIdentified: [],
    },
    reviewToCoding: {
      summary: typeof channel.reviewToCoding === 'string' ? channel.reviewToCoding : '',
      requiredFixes: [],
      requiredTests: [],
      acceptanceStatus: 'partial',
      severity: 'none',
    },
    communicationHistory: [],
    lastUpdatedAt: channel.lastUpdatedAt ?? null,
    totalRounds: 0,
  }
}

/**
 * Normalize Task - 归一化任务数据
 */
export function normalizeTask(
  task,
  index,
  previousTaskId = null
) {
  const title = typeof task?.title === 'string' && task.title.trim() ? task.title.trim() : `子任务${index + 1}`
  const defaultAcceptance = [`完成: ${title}`, '输出可验证结果，不留占位符']
  const defaultVerificationCommands = ['echo "manual verification required"']
  const depsFromTask = Array.isArray(task?.deps) ? task.deps : Array.isArray(task?.dependsOn) ? task.dependsOn : []
  const deps = depsFromTask.length > 0 ? depsFromTask : (previousTaskId ? [previousTaskId] : [])

  // Migrate channel format
  const migratedChannel = migrateChannelFormat(task?.channel)

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
    reviewContract: task.reviewContract ?? undefined,
    reviewRounds: task.reviewRounds ?? 0,
    communicationRounds: task.communicationRounds ?? 0,
    validationRounds: task.validationRounds ?? 0,
    lastAdvicePath: task.lastAdvicePath ?? null,
    history: task.history ?? [],
    channel: migratedChannel,
  }
}

/**
 * Normalize Tasks - 批量归一化任务列表
 */
export function normalizeTasks(tasks) {
  const normalized = []
  for (let index = 0; index < tasks.length; index++) {
    const previousTaskId = normalized[index - 1]?.id ?? null
    normalized.push(normalizeTask(tasks[index], index, previousTaskId))
  }
  return normalized
}
