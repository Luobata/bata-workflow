import type { GoalInput, RunReport } from '../domain/types.js'
import type { RoleModelConfig } from '../role-model-config/schema.js'
import { dispatchPlan } from '../dispatcher/dispatcher.js'
import { buildPlan } from '../planner/planner.js'
import type { CocoAdapter } from '../runtime/coco-adapter.js'
import type { RoleDefinition } from '../domain/types.js'
import { buildExecutionBatches } from '../runtime/scheduler.js'
import { applyFailurePolicies, type FailurePolicyConfig } from '../runtime/failure-policy.js'
import { runAssignmentsWithRuntime } from '../runtime/team-runtime.js'

export async function runGoal(params: {
  input: GoalInput
  adapter: CocoAdapter
  roleRegistry: Map<string, RoleDefinition>
  modelConfig: RoleModelConfig
  failurePolicyConfig: FailurePolicyConfig
}): Promise<RunReport> {
  const { input, adapter, roleRegistry, modelConfig, failurePolicyConfig } = params
  const plan = applyFailurePolicies(buildPlan(input), failurePolicyConfig)
  const assignments = dispatchPlan(plan, roleRegistry, modelConfig, input.teamName)
  const batches = buildExecutionBatches(assignments)
  const { runtime, results } = await runAssignmentsWithRuntime({ assignments, batches, adapter })

  return {
    goal: input.goal,
    plan,
    assignments,
    batches,
    runtime,
    results
  }
}
