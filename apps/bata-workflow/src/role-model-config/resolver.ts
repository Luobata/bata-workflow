import type { ExecutionTarget, ExecutionTargetSpec, ModelResolution, ModelResolutionInput } from '../domain/types.js'

import type { RoleModelConfig, RoleModelTarget } from './schema.js'

export interface ModelOverride {
  model: string
  source: Extract<ModelResolution['source'], 'fallback' | 'remediation'>
  reason: string
  backend?: ExecutionTarget['backend']
  profile?: string
  command?: string
  transport?: ExecutionTarget['transport']
}

interface ResolvedConfigTarget {
  model: string
  spec: ExecutionTargetSpec
  source: Extract<ModelResolution['source'], 'taskType' | 'skill' | 'role' | 'team' | 'global'>
  reason: string
}

function normalizeRoleModelTarget(target: RoleModelTarget): { model: string; spec: ExecutionTargetSpec } {
  if (typeof target === 'string') {
    return {
      model: target,
      spec: {}
    }
  }

  return {
    model: target.model,
    spec: {
      backend: target.backend,
      profile: target.profile,
      command: target.command,
      transport: target.transport
    }
  }
}

function resolveConfiguredTarget(config: RoleModelConfig, input: ModelResolutionInput): ResolvedConfigTarget {
  const { taskType, skills = [], role, teamName = 'default' } = input

  if (config.taskTypes[taskType]) {
    const resolved = normalizeRoleModelTarget(config.taskTypes[taskType])
    return {
      ...resolved,
      source: 'taskType',
      reason: `taskType=${taskType} 命中 taskTypes 配置`
    }
  }

  for (const skill of skills) {
    if (config.skills[skill]) {
      const resolved = normalizeRoleModelTarget(config.skills[skill])
      return {
        ...resolved,
        source: 'skill',
        reason: `skill=${skill} 命中 skills 配置`
      }
    }
  }

  if (config.roles[role]) {
    const resolved = normalizeRoleModelTarget(config.roles[role])
    return {
      ...resolved,
      source: 'role',
      reason: `role=${role} 命中 roles 配置`
    }
  }

  if (config.defaults.teams[teamName]) {
    const resolved = normalizeRoleModelTarget(config.defaults.teams[teamName])
    return {
      ...resolved,
      source: 'team',
      reason: `team=${teamName} 命中 teams 默认配置`
    }
  }

  const resolved = normalizeRoleModelTarget(config.defaults.global)
  return {
    ...resolved,
    source: 'global',
    reason: '回退到 global 默认模型'
  }
}

export function resolveModel(
  config: RoleModelConfig,
  input: ModelResolutionInput
): ModelResolution {
  const resolved = resolveConfiguredTarget(config, input)
  return {
    model: resolved.model,
    source: resolved.source,
    reason: resolved.reason
  }
}

export function resolveModelWithOverride(
  config: RoleModelConfig,
  input: ModelResolutionInput,
  override?: ModelOverride | null
): ModelResolution {
  if (override) {
    return {
      model: override.model,
      source: override.source,
      reason: override.reason
    }
  }

  return resolveModel(config, input)
}

export function resolveExecutionTarget(
  config: RoleModelConfig,
  input: ModelResolutionInput,
  override?: ModelOverride | null
): ExecutionTarget {
  const resolved = resolveConfiguredTarget(config, input)
  const modelResolution = resolveModelWithOverride(config, input, override)

  return {
    backend: override?.backend ?? resolved.spec.backend ?? 'coco',
    model: modelResolution.model,
    profile: override?.profile ?? resolved.spec.profile,
    command: override?.command ?? resolved.spec.command,
    transport: override?.transport ?? resolved.spec.transport ?? 'auto',
    source: modelResolution.source,
    reason: modelResolution.reason
  }
}
