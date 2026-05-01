import type { TaskStatus } from '../schemas/task-contract.js'
import type { AgentStatus } from '../schemas/agent-output.js'

/**
 * Task Context - 任务状态转换上下文
 */
export interface TaskContext {
  agentStatus?: AgentStatus
  reviewPassed: boolean
  maxRoundsReached: boolean
  hasError: boolean
  isResuming: boolean
}

/**
 * Task Transition - 任务状态转换规则
 */
export interface TaskTransition {
  from: TaskStatus | '*'
  to: TaskStatus
  condition: (context: TaskContext) => boolean
  description: string
}

/**
 * Task State Transitions - 任务状态转换规则表
 */
export const TASK_TRANSITIONS: TaskTransition[] = [
  {
    from: 'pending',
    to: 'in_progress',
    condition: () => true,
    description: 'start task execution',
  },
  {
    from: 'in_progress',
    to: 'done',
    condition: (ctx) => ctx.reviewPassed === true,
    description: 'review passed, task completed',
  },
  {
    from: 'in_progress',
    to: 'blocked',
    condition: (ctx) => ctx.maxRoundsReached || ctx.hasError,
    description: 'max review rounds reached or error occurred',
  },
  {
    from: 'blocked',
    to: 'pending',
    condition: (ctx) => ctx.isResuming,
    description: 'resume from blocked state',
  },
]

/**
 * Transition Task - 执行任务状态转换
 */
export function transitionTask(
  currentStatus: TaskStatus,
  context: TaskContext
): TaskStatus {
  for (const transition of TASK_TRANSITIONS) {
    if (transition.from === '*' || transition.from === currentStatus) {
      if (transition.condition(context)) {
        return transition.to
      }
    }
  }
  return currentStatus
}

/**
 * Get Task Transition Description - 获取状态转换描述
 */
export function getTaskTransitionDescription(
  from: TaskStatus,
  to: TaskStatus
): string | undefined {
  return TASK_TRANSITIONS.find(
    (t) => (t.from === '*' || t.from === from) && t.to === to
  )?.description
}

/**
 * Validate Task Transition - 验证状态转换是否合法
 */
export function validateTaskTransition(
  from: TaskStatus,
  to: TaskStatus,
  context: TaskContext
): boolean {
  const result = transitionTask(from, context)
  return result === to
}

/**
 * Should Continue Review Loop - 判断是否应该继续Review循环
 */
export function shouldContinueReviewLoop(
  currentRound: number,
  maxRounds: number,
  reviewPassed: boolean
): boolean {
  return currentRound < maxRounds && !reviewPassed
}
