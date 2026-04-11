import type { ModelResolution, ModelResolutionInput } from '../domain/types.js'

import type { RoleModelConfig } from './schema.js'

export function resolveModel(
  config: RoleModelConfig,
  input: ModelResolutionInput
): ModelResolution {
  const { taskType, skills = [], role, teamName = 'default' } = input

  if (config.taskTypes[taskType]) {
    return {
      model: config.taskTypes[taskType],
      source: 'taskType',
      reason: `taskType=${taskType} 命中 taskTypes 配置`
    }
  }

  for (const skill of skills) {
    if (config.skills[skill]) {
      return {
        model: config.skills[skill],
        source: 'skill',
        reason: `skill=${skill} 命中 skills 配置`
      }
    }
  }

  if (config.roles[role]) {
    return {
      model: config.roles[role],
      source: 'role',
      reason: `role=${role} 命中 roles 配置`
    }
  }

  if (config.defaults.teams[teamName]) {
    return {
      model: config.defaults.teams[teamName],
      source: 'team',
      reason: `team=${teamName} 命中 teams 默认配置`
    }
  }

  return {
    model: config.defaults.global,
    source: 'global',
    reason: '回退到 global 默认模型'
  }
}
