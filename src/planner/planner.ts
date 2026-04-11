import type { GoalInput, Plan, Task, TaskType } from '../domain/types.js'

function inferWorkstreams(goal: string): Array<{ taskType: TaskType; role: string; title: string; skills: string[]; acceptance: string[] }> {
  const normalized = goal.toLowerCase()
  const includesCode = /(实现|开发|编码|重构|接口|功能|fix|bug|feature|code)/i.test(goal)
  const includesResearch = /(分析|调研|研究|梳理|understand|explore)/i.test(goal)
  const includesTest = /(测试|验证|test|qa|review)/i.test(goal)

  const workstreams: Array<{ taskType: TaskType; role: string; title: string; skills: string[]; acceptance: string[] }> = [
    {
      taskType: 'planning',
      role: 'planner',
      title: '拆解目标与定义执行计划',
      skills: ['analysis', 'decomposition'],
      acceptance: ['输出结构化任务列表', '明确依赖关系与验收条件']
    }
  ]

  if (includesResearch || !includesCode) {
    workstreams.push({
      taskType: 'research',
      role: 'researcher',
      title: '补充上下文调研与约束梳理',
      skills: ['analysis', 'discovery'],
      acceptance: ['识别关键上下文', '给出风险与前置条件']
    })
  }

  if (includesCode || normalized.includes('build')) {
    workstreams.push({
      taskType: 'coding',
      role: 'coder',
      title: '完成核心实现',
      skills: ['implementation'],
      acceptance: ['实现关键功能', '产出可验证的变更说明']
    })
    workstreams.push({
      taskType: 'code-review',
      role: 'reviewer',
      title: '执行代码审查与修正建议',
      skills: ['review', 'verification'],
      acceptance: ['指出主要风险', '输出审查结论']
    })
  }

  if (includesTest || includesCode) {
    workstreams.push({
      taskType: 'testing',
      role: 'tester',
      title: '执行测试与验证',
      skills: ['verification', 'qa'],
      acceptance: ['验证主要场景', '确认交付满足验收条件']
    })
  }

  workstreams.push({
    taskType: 'coordination',
    role: 'coordinator',
    title: '汇总执行结果并形成最终交付',
    skills: ['orchestration'],
    acceptance: ['汇总各角色结果', '形成最终交付摘要']
  })

  return workstreams
}

export function buildPlan(input: GoalInput): Plan {
  const workstreams = inferWorkstreams(input.goal)
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
