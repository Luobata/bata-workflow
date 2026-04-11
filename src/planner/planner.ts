import type { GoalInput, Plan, Task, TaskType } from '../domain/types.js'
import { getTeamComposition, type TeamCompositionRegistry } from '../team/team-composition-loader.js'

function getTargetFiles(input: GoalInput) {
  return input.targetFiles ?? (input.targetFile ? [input.targetFile] : [])
}

function buildGoalSignal(input: GoalInput): string {
  return [input.goal, ...getTargetFiles(input).map((file) => file.content)].filter(Boolean).join('\n')
}

function buildDisplayGoal(input: GoalInput): string {
  if (input.goal.trim()) {
    return input.goal
  }

  const targetFiles = getTargetFiles(input)
  if (targetFiles.length === 1) {
    return `基于目标文件 ${targetFiles[0]!.path} 执行`
  }

  if (targetFiles.length > 1) {
    return `基于 ${targetFiles.length} 个目标文件执行`
  }

  return '未命名目标'
}

function buildTargetContextSuffix(input: GoalInput): string {
  const targetFiles = getTargetFiles(input)
  if (targetFiles.length === 0) {
    return ''
  }

  return targetFiles
    .map((targetFile, index) => `\n参考文件${targetFiles.length > 1 ? ` ${index + 1}` : ''}: ${targetFile.path}\n文件内容:\n${targetFile.content}`)
    .join('')
}

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
  const compositionName = input.compositionName ?? inferCompositionName(buildGoalSignal(input), registry)
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
  const displayGoal = buildDisplayGoal(input)
  const targetContextSuffix = buildTargetContextSuffix(input)
  const targetFiles = getTargetFiles(input)
  const workstreams = normalizeWorkstreams(compositionRegistry, input)
  const tasks: Task[] = workstreams.map((stream, index) => ({
    id: `T${index + 1}`,
    title: stream.title,
    description: `${stream.title}，目标：${displayGoal}${targetContextSuffix}`,
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
    goal: displayGoal,
    summary: targetFiles.length === 1
      ? `围绕目标“${displayGoal}”与参考文件“${targetFiles[0]!.path}”生成 ${tasks.length} 个编排任务`
      : targetFiles.length > 1
        ? `围绕目标“${displayGoal}”与 ${targetFiles.length} 个参考文件生成 ${tasks.length} 个编排任务`
      : `围绕目标“${displayGoal}”生成 ${tasks.length} 个编排任务`,
    tasks
  }
}
