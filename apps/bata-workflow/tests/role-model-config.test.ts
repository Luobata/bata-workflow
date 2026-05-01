import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadRoleModelConfig } from '../src/role-model-config/loader.js'
import { resolveExecutionTarget, resolveModel } from '../src/role-model-config/resolver.js'
import { roleModelConfigSchema } from '../src/role-model-config/schema.js'

const configPath = resolve(import.meta.dirname, '../configs/role-models.yaml')

describe('role model resolver', () => {
  it('为 coding 任务命中 gpt5.3-codex', () => {
    const config = loadRoleModelConfig(configPath)
    const result = resolveModel(config, {
      role: 'coder',
      taskType: 'coding',
      skills: ['implementation'],
      teamName: 'default'
    })

    expect(result.model).toBe('gpt5.3-codex')
    expect(result.source).toBe('taskType')
  })

  it('为 planning 任务回退到 gpt5.4', () => {
    const config = loadRoleModelConfig(configPath)
    const result = resolveModel(config, {
      role: 'planner',
      taskType: 'planning',
      skills: ['analysis'],
      teamName: 'default'
    })

    expect(result.model).toBe('gpt5.4')
    expect(['team', 'global']).toContain(result.source)
  })

  it('支持解析 backend-aware object 形式的模型配置', () => {
    const config = roleModelConfigSchema.parse({
      version: 1,
      defaults: {
        global: {
          backend: 'claude-code',
          model: 'sonnet',
          profile: 'cc-default',
          transport: 'print'
        },
        teams: {}
      },
      taskTypes: {
        coding: {
          backend: 'local-cc',
          model: 'gpt5.4',
          profile: 'cc-local',
          command: 'cc',
          transport: 'pty'
        }
      },
      roles: {},
      skills: {}
    })

    const target = resolveExecutionTarget(config, {
      role: 'coder',
      taskType: 'coding',
      skills: ['implementation'],
      teamName: 'default'
    })

    expect(target).toEqual({
      backend: 'local-cc',
      model: 'gpt5.4',
      profile: 'cc-local',
      command: 'cc',
      transport: 'pty',
      source: 'taskType',
      reason: 'taskType=coding 命中 taskTypes 配置'
    })
  })

  it('fallback override 会保留 backend/profile 并仅覆盖模型来源', () => {
    const config = roleModelConfigSchema.parse({
      version: 1,
      defaults: {
        global: 'gpt5.4',
        teams: {}
      },
      taskTypes: {},
      roles: {
        reviewer: {
          backend: 'claude-code',
          model: 'sonnet',
          profile: 'review-profile',
          transport: 'print'
        }
      },
      skills: {}
    })

    const target = resolveExecutionTarget(
      config,
      {
        role: 'reviewer',
        taskType: 'code-review',
        skills: ['review'],
        teamName: 'default'
      },
      {
        model: 'opus',
        source: 'fallback',
        reason: 'failurePolicy.fallbackModel=opus'
      }
    )

    expect(target).toEqual({
      backend: 'claude-code',
      model: 'opus',
      profile: 'review-profile',
      command: undefined,
      transport: 'print',
      source: 'fallback',
      reason: 'failurePolicy.fallbackModel=opus'
    })
  })
})
