import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadRoleModelConfig } from '../src/role-model-config/loader.js'
import { resolveModel } from '../src/role-model-config/resolver.js'

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
})
