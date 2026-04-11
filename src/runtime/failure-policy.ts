import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { z } from 'zod'

import type { FixVerifyLoopPolicy, Plan, Task, TaskFailurePolicy } from '../domain/types.js'

const fixVerifyLoopPolicySchema = z.object({
  enabled: z.boolean().optional(),
  maxRounds: z.number().int().positive().optional(),
  remediationRole: z.string().min(1).nullable().optional(),
  remediationModel: z.string().min(1).nullable().optional(),
  remediationTaskType: z.string().min(1).nullable().optional(),
  remediationSkills: z.array(z.string().min(1)).default([]),
  remediationTitleTemplate: z.string().min(1).optional(),
  remediationDescriptionTemplate: z.string().min(1).optional()
})

const retryPolicySchema = z.object({
  maxAttempts: z.number().int().positive().optional(),
  retryDelayMs: z.number().int().nonnegative().optional(),
  fallbackRole: z.string().min(1).nullable().optional(),
  fallbackModel: z.string().min(1).nullable().optional(),
  fixVerifyLoop: fixVerifyLoopPolicySchema.nullable().optional(),
  retryOn: z.array(z.string().min(1)).default([]),
  terminalOn: z.array(z.string().min(1)).default([])
})

const failurePolicyConfigSchema = z.object({
  version: z.number().int().positive(),
  defaults: z.object({
    global: retryPolicySchema,
    taskTypes: z.record(retryPolicySchema).default({}),
    roles: z.record(retryPolicySchema).default({})
  })
})

export type RetryPolicyConfig = z.infer<typeof retryPolicySchema>
export type FailurePolicyConfig = z.infer<typeof failurePolicyConfigSchema>

function mergeFixVerifyLoopPolicy(
  base: FixVerifyLoopPolicy | null,
  override: RetryPolicyConfig['fixVerifyLoop']
): FixVerifyLoopPolicy | null {
  if (override === undefined) {
    return base
  }

  if (override === null) {
    return null
  }

  return {
    enabled: override.enabled ?? base?.enabled ?? false,
    maxRounds: override.maxRounds ?? base?.maxRounds ?? 1,
    remediationRole: override.remediationRole ?? base?.remediationRole ?? null,
    remediationModel: override.remediationModel ?? base?.remediationModel ?? null,
    remediationTaskType: (override.remediationTaskType as Task['taskType'] | null | undefined) ?? base?.remediationTaskType ?? null,
    remediationSkills: override.remediationSkills.length > 0 ? override.remediationSkills : (base?.remediationSkills ?? []),
    remediationTitleTemplate:
      override.remediationTitleTemplate ?? base?.remediationTitleTemplate ?? '修复 {{sourceTaskId}} 失败问题',
    remediationDescriptionTemplate:
      override.remediationDescriptionTemplate ??
      base?.remediationDescriptionTemplate ??
      '针对 {{sourceTaskId}} 的失败结果进行修复，并为后续重新验证做准备。原任务：{{sourceDescription}}'
  }
}

function mergeRetryPolicy(base: TaskFailurePolicy, override?: RetryPolicyConfig): TaskFailurePolicy {
  if (!override) {
    return base
  }

  return {
    maxAttempts: override.maxAttempts ?? base.maxAttempts,
    retryDelayMs: override.retryDelayMs ?? base.retryDelayMs,
    fallbackRole: override.fallbackRole ?? base.fallbackRole,
    fallbackModel: override.fallbackModel ?? base.fallbackModel,
    fixVerifyLoop: mergeFixVerifyLoopPolicy(base.fixVerifyLoop, override.fixVerifyLoop),
    retryOn: override.retryOn.length > 0 ? override.retryOn : base.retryOn,
    terminalOn: override.terminalOn.length > 0 ? override.terminalOn : base.terminalOn
  }
}

export function loadFailurePolicyConfig(configPath: string): FailurePolicyConfig {
  const raw = readFileSync(configPath, 'utf8')
  return failurePolicyConfigSchema.parse(parse(raw))
}

export function resolveTaskFailurePolicy(config: FailurePolicyConfig, task: Pick<Task, 'taskType' | 'role'>): TaskFailurePolicy {
  const globalPolicy = mergeRetryPolicy(
    {
      maxAttempts: 1,
      retryDelayMs: 0,
      fallbackRole: null,
      fallbackModel: null,
      fixVerifyLoop: null,
      retryOn: [],
      terminalOn: []
    },
    config.defaults.global
  )

  return mergeRetryPolicy(
    mergeRetryPolicy(globalPolicy, config.defaults.roles[task.role]),
    config.defaults.taskTypes[task.taskType]
  )
}

export function resolveTaskMaxAttempts(config: FailurePolicyConfig, task: Pick<Task, 'taskType' | 'role'>): number {
  return resolveTaskFailurePolicy(config, task).maxAttempts
}

export function applyFailurePolicies(plan: Plan, config: FailurePolicyConfig): Plan {
  return {
    ...plan,
    tasks: plan.tasks.map((task) => {
      const failurePolicy = resolveTaskFailurePolicy(config, task)
      return {
        ...task,
        maxAttempts: failurePolicy.maxAttempts,
        failurePolicy
      }
    })
  }
}

export function shouldPatternMatch(message: string, patterns: string[]): boolean {
  const normalizedMessage = message.toLowerCase()
  return patterns.some((pattern) => normalizedMessage.includes(pattern.toLowerCase()))
}

export function shouldRetryTask(task: Task, message: string, attempt: number): { retryable: boolean; reason: string } {
  const policy = task.failurePolicy ?? {
    maxAttempts: task.maxAttempts,
    retryDelayMs: 0,
    fallbackRole: null,
    fallbackModel: null,
    fixVerifyLoop: null,
    retryOn: [],
    terminalOn: []
  }

  if (shouldPatternMatch(message, policy.terminalOn)) {
    return { retryable: false, reason: '命中 terminalOn，终止重试' }
  }

  if (attempt >= policy.maxAttempts) {
    return { retryable: false, reason: '达到最大重试次数' }
  }

  if (policy.retryOn.length > 0 && !shouldPatternMatch(message, policy.retryOn)) {
    return { retryable: false, reason: '未命中 retryOn，不进行重试' }
  }

  return { retryable: true, reason: '允许重试' }
}
