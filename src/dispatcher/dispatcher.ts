import type { DispatchAssignment, Plan, RoleDefinition } from '../domain/types.js'
import type { RoleModelConfig } from '../role-model-config/schema.js'
import { resolveModel } from '../role-model-config/resolver.js'

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

    return {
      task,
      roleDefinition,
      modelResolution: resolveModel(modelConfig, {
        role: task.role,
        taskType: task.taskType,
        skills: task.skills,
        teamName
      })
    }
  })
}
