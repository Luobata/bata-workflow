import type { DispatchAssignment, Plan, RoleDefinition, TaskType } from '../domain/types.js'
import type { RoleModelConfig } from '../role-model-config/schema.js'
import { resolveExecutionTarget, resolveModelWithOverride } from '../role-model-config/resolver.js'

function requireRoleDefinition(roleRegistry: Map<string, RoleDefinition>, roleName: string, label: string): RoleDefinition {
  const roleDefinition = roleRegistry.get(roleName)
  if (!roleDefinition) {
    throw new Error(`未找到${label}角色定义: ${roleName}`)
  }
  return roleDefinition
}

function resolveTarget(params: {
  roleName: string
  taskType: TaskType
  skills: string[]
  teamName: string
  roleRegistry: Map<string, RoleDefinition>
  modelConfig: RoleModelConfig
  overrideModel?: {
    model: string
    source: 'fallback' | 'remediation'
    reason: string
  } | null
  label: string
}) {
  const { roleName, taskType, skills, teamName, roleRegistry, modelConfig, overrideModel, label } = params
  const roleDefinition = requireRoleDefinition(roleRegistry, roleName, label)

  return {
    roleDefinition,
    modelResolution: resolveModelWithOverride(
      modelConfig,
      {
        role: roleName,
        taskType,
        skills,
        teamName
      },
      overrideModel
    ),
    executionTarget: resolveExecutionTarget(
      modelConfig,
      {
        role: roleName,
        taskType,
        skills,
        teamName
      },
      overrideModel
    )
  }
}

function resolveFallback(
  planAssignment: Omit<DispatchAssignment, 'fallback' | 'remediation'>,
  roleRegistry: Map<string, RoleDefinition>,
  modelConfig: RoleModelConfig,
  teamName: string
): DispatchAssignment['fallback'] {
  const failurePolicy = planAssignment.task.failurePolicy
  if (!failurePolicy?.fallbackRole && !failurePolicy?.fallbackModel) {
    return null
  }

  const fallbackRoleName = failurePolicy.fallbackRole ?? planAssignment.task.role
  const fallbackTaskType = roleRegistry.get(fallbackRoleName)?.defaultTaskTypes[0] ?? planAssignment.task.taskType

  return resolveTarget({
    roleName: fallbackRoleName,
    taskType: fallbackTaskType,
    skills: planAssignment.task.skills,
    teamName,
    roleRegistry,
    modelConfig,
    overrideModel: failurePolicy.fallbackModel
      ? {
          model: failurePolicy.fallbackModel,
          source: 'fallback',
          reason: `failurePolicy.fallbackModel=${failurePolicy.fallbackModel}`
        }
      : null,
    label: 'fallback '
  })
}

function resolveRemediation(
  planAssignment: Omit<DispatchAssignment, 'fallback' | 'remediation'>,
  roleRegistry: Map<string, RoleDefinition>,
  modelConfig: RoleModelConfig,
  teamName: string
): DispatchAssignment['remediation'] {
  const loopPolicy = planAssignment.task.failurePolicy?.fixVerifyLoop
  if (!loopPolicy?.enabled) {
    return null
  }

  const remediationRoleName = loopPolicy.remediationRole ?? planAssignment.task.role
  const remediationRoleDefinition = requireRoleDefinition(roleRegistry, remediationRoleName, 'remediation ')
  const remediationTaskType = loopPolicy.remediationTaskType ?? remediationRoleDefinition.defaultTaskTypes[0] ?? planAssignment.task.taskType
  const remediationSkills =
    loopPolicy.remediationSkills.length > 0
      ? loopPolicy.remediationSkills
      : remediationRoleDefinition.defaultSkills.length > 0
        ? remediationRoleDefinition.defaultSkills
        : planAssignment.task.skills
  const remediationTarget = resolveTarget({
    roleName: remediationRoleName,
    taskType: remediationTaskType,
    skills: remediationSkills,
    teamName,
    roleRegistry,
    modelConfig,
    overrideModel: loopPolicy.remediationModel
      ? {
          model: loopPolicy.remediationModel,
          source: 'remediation',
          reason: `fixVerifyLoop.remediationModel=${loopPolicy.remediationModel}`
        }
      : null,
    label: 'remediation '
  })

  return {
    ...remediationTarget,
    taskType: remediationTaskType,
    skills: remediationSkills
  }
}

export function dispatchPlan(
  plan: Plan,
  roleRegistry: Map<string, RoleDefinition>,
  modelConfig: RoleModelConfig,
  teamName = 'default'
): DispatchAssignment[] {
  return plan.tasks.map((task) => {
    const roleDefinition = roleRegistry.get(task.role)

    if (!roleDefinition) {
      throw new Error(`未找到角色定义: ${task.role}`)
    }

    const baseAssignment = {
      task,
      roleDefinition,
      modelResolution: resolveModelWithOverride(modelConfig, {
        role: task.role,
        taskType: task.taskType,
        skills: task.skills,
        teamName
      }),
      executionTarget: resolveExecutionTarget(modelConfig, {
        role: task.role,
        taskType: task.taskType,
        skills: task.skills,
        teamName
      })
    }

    return {
      ...baseAssignment,
      fallback: resolveFallback(baseAssignment, roleRegistry, modelConfig, teamName),
      remediation: resolveRemediation(baseAssignment, roleRegistry, modelConfig, teamName)
    }
  })
}
