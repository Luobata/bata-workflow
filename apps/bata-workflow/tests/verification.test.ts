import { describe, expect, it } from 'vitest'

import type { RunReport } from '../src/domain/types.js'
import { verifyRun } from '../src/verification/index.js'

function createReport(summary: string): RunReport {
  return {
    goal: 'verify goal',
    plan: {
      goal: 'verify goal',
      summary: 'summary',
      tasks: [
        {
          id: 'T1',
          title: '任务一',
          description: 'desc',
          role: 'planner',
          taskType: 'planning',
          dependsOn: [],
          acceptanceCriteria: ['done'],
          skills: ['analysis'],
          status: 'ready',
          maxAttempts: 1
        }
      ]
    },
    assignments: [],
    batches: [{ batchId: 'B1', taskIds: ['T1'] }],
    runtime: {
      maxConcurrency: 1,
      workers: [],
      batches: [{ batchId: 'B1', taskIds: ['T1'] }],
      completedTaskIds: ['T1'],
      pendingTaskIds: [],
      blockedTaskIds: [],
      readyTaskIds: [],
      inProgressTaskIds: [],
      failedTaskIds: [],
      dynamicTaskStats: {
        generatedTaskCount: 0,
        generatedTaskIds: [],
        generatedTaskCountBySourceTaskId: {}
      },
      loopSummaries: [],
      events: [],
      mailbox: [],
      taskStates: [
        {
          taskId: 'T1',
          status: 'completed',
          phase: 'completed',
          phaseDetail: null,
          claimedBy: null,
          attempts: 1,
          maxAttempts: 1,
          lastError: null,
          attemptHistory: [],
          workerHistory: [],
          failureTimestamps: [],
          lastClaimedAt: null,
          releasedAt: null,
          nextAttemptAt: null,
          lastUpdatedAt: null
        }
      ]
    },
    results: [
      {
        taskId: 'T1',
        role: 'planner',
        model: 'gpt5.4',
        status: 'completed',
        summary,
        attempt: 1
      }
    ],
    summary: {
      generatedTaskCount: 0,
      loopCount: 0,
      loopedSourceTaskIds: [],
      failedTaskCount: 0,
      blockedTaskCount: 0,
      completedTaskCount: 1,
      retryTaskCount: 0
    }
  }
}

describe('verification', () => {
  it('在 completed 摘要疑似截断时判定 run 不通过', () => {
    const result = verifyRun(createReport('Explore('))

    expect(result.ok).toBe(false)
    expect(result.checks).toContain('存在疑似截断或无效的 completed 摘要')
  })

  it('在 completed 摘要正常时保持 run 通过', () => {
    const result = verifyRun(createReport('已完成项目理解并整理校验方法'))

    expect(result.ok).toBe(true)
    expect(result.checks).toContain('completed 摘要有效')
  })
})
