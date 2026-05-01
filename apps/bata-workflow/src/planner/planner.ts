import type { GoalInput, Plan, Task, TaskType } from '../domain/types.js'
import { getTeamComposition, type TeamCompositionRegistry } from '../team/team-composition-loader.js'

interface WorkstreamTemplate {
  taskType: TaskType
  role: string
  title: string
  skills: string[]
  acceptance: string[]
}

interface PlanningItem {
  title: string
  taskType: TaskType
  sourcePath: string
}

const MAX_PLANNING_ITEMS = 6
const MAX_ITEM_TITLE_LENGTH = 48

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

function truncateTitle(text: string): string {
  return text.length > MAX_ITEM_TITLE_LENGTH ? `${text.slice(0, MAX_ITEM_TITLE_LENGTH)}…` : text
}

function normalizePlanningItem(text: string): string {
  return text
    .replace(/^[-*+]\s+\[(?: |x|X)\]\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/[：:；;，,。]+$/g, '')
    .trim()
}

function matchPlanningItem(line: string): string | null {
  const checklistMatch = line.match(/^[-*+]\s+\[(?: |x|X)\]\s+(.+)$/)
  if (checklistMatch?.[1]) {
    return normalizePlanningItem(checklistMatch[1])
  }

  const orderedMatch = line.match(/^\d+[.)]\s+(.+)$/)
  if (orderedMatch?.[1]) {
    return normalizePlanningItem(orderedMatch[1])
  }

  const bulletMatch = line.match(/^[-*+]\s+(.+)$/)
  if (bulletMatch?.[1]) {
    return normalizePlanningItem(bulletMatch[1])
  }

  return null
}

function inferPlanningItemTaskType(text: string): TaskType {
  if (/(调研|梳理|分析|研究|排查|确认|现状|风险|约束|依赖)/i.test(text)) {
    return 'research'
  }

  if (/(测试|回归|验证|验收|qa|e2e|集成测试)/i.test(text)) {
    return 'testing'
  }

  if (/(审查|评审|review|代码审查)/i.test(text)) {
    return 'code-review'
  }

  return 'coding'
}

function extractPlanningItems(input: GoalInput): PlanningItem[] {
  const targetFiles = getTargetFiles(input)
  const seen = new Set<string>()
  const items: PlanningItem[] = []

  for (const targetFile of targetFiles) {
    for (const rawLine of targetFile.content.split('\n')) {
      const candidate = matchPlanningItem(rawLine.trim())
      if (!candidate || candidate.length < 4 || candidate.length > 80) {
        continue
      }

      if (/^(核心任务|任务拆解|待办|todo|说明|背景|目标|范围)$/i.test(candidate)) {
        continue
      }

      const normalized = candidate.toLowerCase()
      if (seen.has(normalized)) {
        continue
      }

      seen.add(normalized)
      items.push({
        title: candidate,
        taskType: inferPlanningItemTaskType(candidate),
        sourcePath: targetFile.path
      })

      if (items.length >= MAX_PLANNING_ITEMS) {
        return items
      }
    }
  }

  return items
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

function normalizeWorkstreams(registry: TeamCompositionRegistry, input: GoalInput): WorkstreamTemplate[] {
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

function buildTask(
  template: Pick<WorkstreamTemplate, 'taskType' | 'role' | 'skills' | 'acceptance'>,
  title: string,
  description: string,
  ready = false,
  acceptanceCriteria?: string[]
): Task {
  return {
    id: '',
    title,
    description,
    role: template.role,
    taskType: template.taskType,
    dependsOn: [],
    acceptanceCriteria: acceptanceCriteria ?? template.acceptance,
    skills: template.skills,
    status: ready ? 'ready' : 'pending',
    maxAttempts: 1
  }
}

function assignTaskIds(tasks: Task[]): Task[] {
  return tasks.map((task, index) => ({
    ...task,
    id: `T${index + 1}`,
    status: index === 0 ? 'ready' : 'pending'
  }))
}

function applyTaskDependencies(tasks: Task[]): void {
  const planningTaskIds = tasks.filter((task) => task.taskType === 'planning').map((task) => task.id)
  const researchTaskIds = tasks.filter((task) => task.taskType === 'research').map((task) => task.id)
  const codingTaskIds = tasks.filter((task) => task.taskType === 'coding').map((task) => task.id)
  const executionPrerequisites = [...planningTaskIds, ...researchTaskIds]
  const reviewPrerequisites = codingTaskIds.length > 0 ? codingTaskIds : executionPrerequisites

  for (const task of tasks) {
    if (task.taskType === 'planning') {
      task.dependsOn = []
      continue
    }

    if (task.taskType === 'research') {
      task.dependsOn = planningTaskIds
      continue
    }

    if (task.taskType === 'coding') {
      task.dependsOn = executionPrerequisites
      continue
    }

    if (task.taskType === 'code-review' || task.taskType === 'testing') {
      task.dependsOn = reviewPrerequisites.length > 0 ? reviewPrerequisites : planningTaskIds
      continue
    }

    if (task.taskType === 'coordination') {
      task.dependsOn = tasks.filter((item) => item.id !== task.id).map((item) => item.id)
    }
  }
}

function buildDocDrivenTasks(input: GoalInput, displayGoal: string, targetContextSuffix: string, workstreams: WorkstreamTemplate[]): Task[] | null {
  const planningItems = extractPlanningItems(input)
  if (planningItems.length < 2) {
    return null
  }

  const planningTemplate = workstreams.find((stream) => stream.taskType === 'planning')
  const coordinationTemplate = workstreams.find((stream) => stream.taskType === 'coordination')
  if (!planningTemplate || !coordinationTemplate) {
    return null
  }

  const templatesByTaskType = new Map(workstreams.map((stream) => [stream.taskType, stream] as const))
  const researchTemplate = templatesByTaskType.get('research')
  const codingTemplate = templatesByTaskType.get('coding')
  const reviewTemplate = templatesByTaskType.get('code-review')
  const testingTemplate = templatesByTaskType.get('testing')

  const tasks: Task[] = [
    buildTask(planningTemplate, planningTemplate.title, `${planningTemplate.title}，目标：${displayGoal}${targetContextSuffix}`, true)
  ]

  const explicitReviewItems = planningItems.filter((item) => item.taskType === 'code-review' && reviewTemplate)
  const explicitTestingItems = planningItems.filter((item) => item.taskType === 'testing' && testingTemplate)
  const codingLikeItems = planningItems.filter((item) => item.taskType === 'coding' && codingTemplate)

  for (const item of planningItems) {
    const template =
      item.taskType === 'research' && researchTemplate
        ? researchTemplate
        : item.taskType === 'testing' && testingTemplate
          ? testingTemplate
          : item.taskType === 'code-review' && reviewTemplate
            ? reviewTemplate
            : item.taskType === 'coding' && codingTemplate
              ? codingTemplate
              : null

    if (!template) {
      continue
    }

    tasks.push(
      buildTask(
        template,
        `${template.taskType === 'research' ? '调研事项' : template.taskType === 'testing' ? '验证事项' : template.taskType === 'code-review' ? '审查事项' : '推进事项'}：${truncateTitle(item.title)}`,
        `${template.title}，目标：${displayGoal}\n来源文件：${item.sourcePath}\n来源事项：${item.title}${targetContextSuffix}`,
        false,
        [`完成事项：${item.title}`, ...template.acceptance]
      )
    )
  }

  if (codingTemplate && reviewTemplate && codingLikeItems.length > 0 && explicitReviewItems.length === 0) {
    tasks.push(
      buildTask(reviewTemplate, reviewTemplate.title, `${reviewTemplate.title}，目标：${displayGoal}\n重点审查 ${codingLikeItems.length} 个推进事项的实现质量。${targetContextSuffix}`)
    )
  }

  if (codingTemplate && testingTemplate && codingLikeItems.length > 0 && explicitTestingItems.length === 0) {
    tasks.push(
      buildTask(testingTemplate, testingTemplate.title, `${testingTemplate.title}，目标：${displayGoal}\n重点验证 ${codingLikeItems.length} 个推进事项的交付结果。${targetContextSuffix}`)
    )
  }

  if (tasks.length <= 2) {
    return null
  }

  tasks.push(buildTask(coordinationTemplate, coordinationTemplate.title, `${coordinationTemplate.title}，目标：${displayGoal}${targetContextSuffix}`))

  const tasksWithIds = assignTaskIds(tasks)
  applyTaskDependencies(tasksWithIds)
  return tasksWithIds
}

export function buildPlan(input: GoalInput, compositionRegistry: TeamCompositionRegistry): Plan {
  const displayGoal = buildDisplayGoal(input)
  const targetContextSuffix = buildTargetContextSuffix(input)
  const targetFiles = getTargetFiles(input)
  const workstreams = normalizeWorkstreams(compositionRegistry, input)
  const tasks =
    buildDocDrivenTasks(input, displayGoal, targetContextSuffix, workstreams) ??
    (() => {
      const defaultTasks = assignTaskIds(
        workstreams.map((stream, index) =>
          buildTask(stream, stream.title, `${stream.title}，目标：${displayGoal}${targetContextSuffix}`, index === 0)
        )
      )
      applyTaskDependencies(defaultTasks)
      return defaultTasks
    })()

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
