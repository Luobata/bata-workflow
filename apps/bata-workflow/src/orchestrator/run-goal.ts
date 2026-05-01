import type { GoalInput, RunReport } from '../domain/types.js'
import type { RoleModelConfig } from '../role-model-config/schema.js'
import { dispatchPlan } from '../dispatcher/dispatcher.js'
import { buildPlan } from '../planner/planner.js'
import type { CocoAdapter } from '../runtime/coco-adapter.js'
import type { RoleDefinition } from '../domain/types.js'
import { buildExecutionBatches } from '../runtime/scheduler.js'
import { applyFailurePolicies, type FailurePolicyConfig } from '../runtime/failure-policy.js'
import { runAssignmentsWithRuntime } from '../runtime/team-runtime.js'
import { buildRunSummary } from '../runtime/task-queue.js'
import type { TeamCompositionRegistry } from '../team/team-composition-loader.js'

export async function runGoal(params: {
  workspaceRoot?: string
  input: GoalInput
  adapter: CocoAdapter
  roleRegistry: Map<string, RoleDefinition>
  modelConfig: RoleModelConfig
  failurePolicyConfig: FailurePolicyConfig
  teamCompositionRegistry: TeamCompositionRegistry
  runDirectory: string
  maxConcurrency?: number
}): Promise<RunReport> {
  const { workspaceRoot, input, adapter, roleRegistry, modelConfig, failurePolicyConfig, teamCompositionRegistry, runDirectory, maxConcurrency = 2 } = params
  const plan = applyFailurePolicies(buildPlan(input, teamCompositionRegistry), failurePolicyConfig)
  const assignments = dispatchPlan(plan, roleRegistry, modelConfig, input.teamName)
  const batches = buildExecutionBatches(assignments)
  const { runtime, results, artifactsByTaskId } = await runAssignmentsWithRuntime({
    workspaceRoot,
    runDirectory,
    goal: input.goal,
    plan,
    assignments,
    batches,
    adapter,
    workerPool: {
      maxConcurrency,
      slotCount: input.teamRunSpec?.teamSize,
      slots: input.teamRunSpec?.slots
    }
  })

  return {
    goal: input.goal,
    plan,
    assignments,
    batches,
    runtime,
    results,
    summary: buildRunSummary({ runtime, results }),
    artifactsByTaskId
  }
}
