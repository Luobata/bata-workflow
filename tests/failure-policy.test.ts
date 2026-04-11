import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadFailurePolicyConfig, resolveTaskFailurePolicy, shouldRetryTask } from '../src/runtime/failure-policy.js'

const failurePolicyConfigPath = resolve(import.meta.dirname, '../configs/failure-policies.yaml')

describe('failure policy', () => {
  it('按 global/role/taskType 合并失败策略', () => {
    const config = loadFailurePolicyConfig(failurePolicyConfigPath)
    const codingPolicy = resolveTaskFailurePolicy(config, { taskType: 'coding', role: 'coder' })
    const reviewPolicy = resolveTaskFailurePolicy(config, { taskType: 'code-review', role: 'reviewer' })

    expect(codingPolicy.maxAttempts).toBe(2)
    expect(codingPolicy.retryDelayMs).toBe(10)
    expect(codingPolicy.fallbackRole).toBe('reviewer')
    expect(codingPolicy.fixVerifyLoop).toBeNull()
    expect(reviewPolicy.maxAttempts).toBe(1)
    expect(reviewPolicy.terminalOn).toEqual(['critical', 'security'])
    const testingPolicy = resolveTaskFailurePolicy(config, { taskType: 'testing', role: 'tester' })
    expect(testingPolicy.fallbackRole).toBe('reviewer')
    expect(testingPolicy.fixVerifyLoop?.enabled).toBe(true)
    expect(testingPolicy.fixVerifyLoop?.remediationRole).toBe('coder')
    expect(testingPolicy.fixVerifyLoop?.remediationModel).toBe('gpt5.3-codex-remediation')
  })

  it('根据 retryOn 与 terminalOn 判定是否重试', () => {
    const retryableTask = {
      taskType: 'coding' as const,
      role: 'coder',
      maxAttempts: 2,
      failurePolicy: {
        maxAttempts: 3,
        retryDelayMs: 0,
        fallbackRole: null,
        fallbackModel: null,
        fixVerifyLoop: null,
        retryOn: ['timeout'],
        terminalOn: ['security']
      }
    }

    expect(shouldRetryTask(retryableTask, 'request timeout', 1).retryable).toBe(true)
    expect(shouldRetryTask(retryableTask, 'security violation', 1).retryable).toBe(false)
    expect(shouldRetryTask(retryableTask, 'other error', 1).retryable).toBe(false)
  })
})
