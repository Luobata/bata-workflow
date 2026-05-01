#!/usr/bin/env node

/**
 * Task State Machine - Task状态机
 */

/**
 * Task State Transitions - 任务状态转换规则表
 */
export const TASK_TRANSITIONS = [
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
export function transitionTask(currentStatus, context) {
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
 * Should Continue Review Loop - 判断是否应该继续Review循环
 */
export function shouldContinueReviewLoop(currentRound, maxRounds, reviewPassed) {
  return currentRound < maxRounds && !reviewPassed
}
