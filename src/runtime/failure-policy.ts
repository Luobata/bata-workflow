import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { z } from 'zod'

import type { Plan, Task } from '../domain/types.js'

const retryPolicySchema = z.object({
  maxAttempts: z.number().int().positive()
})

const failurePolicyConfigSchema = z.object({
  version: z.number().int().positive(),
  defaults: z.object({
    global: retryPolicySchema,
    taskTypes: z.record(retryPolicySchema).default({}),
    roles: z.record(retryPolicySchema).default({})
  })
})

export type FailurePolicyConfig = z.infer<typeof failurePolicyConfigSchema>

export function loadFailurePolicyConfig(configPath: string): FailurePolicyConfig {
  const raw = readFileSync(configPath, 'utf8')
  return failurePolicyConfigSchema.parse(parse(raw))
}

export function resolveTaskMaxAttempts(config: FailurePolicyConfig, task: Pick<Task, 'taskType' | 'role'>): number {
  return (
    config.defaults.taskTypes[task.taskType]?.maxAttempts ??
    config.defaults.roles[task.role]?.maxAttempts ??
    config.defaults.global.maxAttempts
  )
}

export function applyFailurePolicies(plan: Plan, config: FailurePolicyConfig): Plan {
  return {
    ...plan,
    tasks: plan.tasks.map((task) => ({
      ...task,
      maxAttempts: resolveTaskMaxAttempts(config, task)
    }))
  }
}
