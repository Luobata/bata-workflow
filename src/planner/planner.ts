import type { GoalInput, Plan, Task, TaskType } from '../domain/types.js'
import { getTeamComposition, type TeamCompositionRegistry } from '../team/team-composition-loader.js'

function inferCompositionName(goal: string, registry: TeamCompositionRegistry): string {
  const normalized = goal.toLowerCase()
  const includesCode = /(实现|开发|编码|重构|接口|功能|fix|bug|feature|code)/i.test(goal)
  const includesResearch = /(分析|调研|研究|梳理|understand|explore)/i.test(goal)
  const includesTest = /(测试|验证|test|qa|review)/i.test(goal)

  if (includesCode && includesResearch) {
    return 'mixed-research-dev'
  }

  if (includesCode || normalized.includes('build')) {
    return 'feature-dev'
  }

  if (includesTest) {
    return 'qa-only'
  }

  if (includesResearch || !includesCode) {
    return 'research-only'
  }

  return registry.defaultComposition
}

function normalizeWorkstreams(registry: TeamCompositionRegistry, input: GoalInput): Array<{
  taskType: TaskType
  role: string
  title: string
  skills: string[]
  acceptance: string[]
}> {
  const compositionName = input.compositionName ?? inferCompositionName(input.goal, registry)
  const composition = getTeamComposition(registry, compositionName)
  return composition.workstreams.map((workstream) => ({
    taskType: workstream.taskType,
    role: workstream.role,
    title: workstream.title,
    skills: workstream.skills,
    acceptance: workstream.acceptance
  }))
}

export function buildPlan(input: GoalInput, compositionRegistry: TeamCompositionRegistry): Plan {
  const workstreams = normalizeWorkstreams(compositionRegistry, input)
  const tasks: Task[] = workstreams.map((stream, index) => ({
    id: `T${index + 1}`,
    title: stream.title,
    description: `${stream.title}，目标：${input.goal}`,
    role: stream.role,
    taskType: stream.taskType,
    dependsOn: [],
    acceptanceCriteria: stream.acceptance,
    skills: stream.skills,
    status: index === 0 ? 'ready' : 'pending',
    maxAttempts: 1
  }))

  const planningTask = tasks.find((task) => task.taskType === 'planning')
  const researchTask = tasks.find((task) => task.taskType === 'research')
  const codingTask = tasks.find((task) => task.taskType === 'coding')

  for (const task of tasks) {
    if (task.taskType === 'planning') {
      task.dependsOn = []
      continue
    }

    if (task.taskType === 'research') {
      task.dependsOn = planningTask ? [planningTask.id] : []
      continue
    }

    if (task.taskType === 'coding') {
      task.dependsOn = [planningTask, researchTask].filter(Boolean).map((item) => item!.id)
      continue
    }

    if (task.taskType === 'code-review' || task.taskType === 'testing') {
      task.dependsOn = codingTask ? [codingTask.id] : [planningTask].filter(Boolean).map((item) => item!.id)
      continue
    }

    if (task.taskType === 'coordination') {
      task.dependsOn = tasks.filter((item) => item.id !== task.id).map((item) => item.id)
    }
  }

  return {
    goal: input.goal,
    summary: `围绕目标“${input.goal}”生成 ${tasks.length} 个编排任务`,
    tasks
  }
}
