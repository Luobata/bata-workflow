import { describe, expect, it } from 'vitest'

import type { CocoAdapter } from '../src/runtime/coco-adapter.js'
import { resumeRun } from '../src/runtime/recovery.js'
import type { RunReport } from '../src/domain/types.js'

describe('recovery', () => {
  it('从上次运行中恢复未完成任务', async () => {
    const previousReport: RunReport = {
      goal: 'resume goal',
      plan: {
        goal: 'resume goal',
        summary: 'summary',
        tasks: [
          {
            id: 'T1',
            title: 'plan',
            description: 'plan',
            role: 'planner',
            taskType: 'planning',
            dependsOn: [],
            acceptanceCriteria: ['a'],
            skills: ['analysis'],
            status: 'ready',
            maxAttempts: 1
          },
          {
            id: 'T2',
            title: 'code',
            description: 'code',
            role: 'coder',
            taskType: 'coding',
            dependsOn: ['T1'],
            acceptanceCriteria: ['b'],
            skills: ['implementation'],
            status: 'pending',
            maxAttempts: 2
          },
          {
            id: 'T3',
            title: 'review',
            description: 'review',
            role: 'reviewer',
            taskType: 'code-review',
            dependsOn: ['T2'],
            acceptanceCriteria: ['c'],
            skills: ['review'],
            status: 'pending',
            maxAttempts: 2
          }
        ]
      },
      assignments: [
        {
          task: {
            id: 'T1',
            title: 'plan',
            description: 'plan',
            role: 'planner',
            taskType: 'planning',
            dependsOn: [],
            acceptanceCriteria: ['a'],
            skills: ['analysis'],
            status: 'ready',
            maxAttempts: 1
          },
          roleDefinition: {
            name: 'planner',
            description: 'planner',
            defaultTaskTypes: ['planning'],
            defaultSkills: ['analysis']
          },
          modelResolution: { model: 'gpt5.4', source: 'global', reason: 'default' }
        },
        {
          task: {
            id: 'T2',
            title: 'code',
            description: 'code',
            role: 'coder',
            taskType: 'coding',
            dependsOn: ['T1'],
            acceptanceCriteria: ['b'],
            skills: ['implementation'],
            status: 'pending',
            maxAttempts: 2
          },
          roleDefinition: {
            name: 'coder',
            description: 'coder',
            defaultTaskTypes: ['coding'],
            defaultSkills: ['implementation']
          },
          modelResolution: { model: 'gpt5.3-codex', source: 'taskType', reason: 'coding' }
        },
        {
          task: {
            id: 'T3',
            title: 'review',
            description: 'review',
            role: 'reviewer',
            taskType: 'code-review',
            dependsOn: ['T2'],
            acceptanceCriteria: ['c'],
            skills: ['review'],
            status: 'pending',
            maxAttempts: 2
          },
          roleDefinition: {
            name: 'reviewer',
            description: 'reviewer',
            defaultTaskTypes: ['code-review'],
            defaultSkills: ['review']
          },
          modelResolution: { model: 'gpt5.3-codex', source: 'taskType', reason: 'review' }
        }
      ],
      batches: [{ batchId: 'B1', taskIds: ['T1', 'T2', 'T3'] }],
      runtime: {
        workers: [],
        batches: [{ batchId: 'B1', taskIds: ['T1', 'T2', 'T3'] }],
        completedTaskIds: ['T1'],
        pendingTaskIds: ['T2', 'T3'],
        events: [],
        mailbox: [],
        taskStates: [
          { taskId: 'T1', status: 'completed', claimedBy: null, attempts: 1, maxAttempts: 1, lastError: null },
          { taskId: 'T2', status: 'failed', claimedBy: null, attempts: 2, maxAttempts: 2, lastError: 'boom' },
          { taskId: 'T3', status: 'pending', claimedBy: null, attempts: 0, maxAttempts: 2, lastError: null }
        ]
      },
      results: [{ taskId: 'T1', role: 'planner', model: 'gpt5.4', summary: 'done', status: 'completed', attempt: 1 }]
    }

    class ResumeAdapter implements CocoAdapter {
      async execute({ assignment }) {
        return {
          taskId: assignment.task.id,
          role: assignment.roleDefinition.name,
          model: assignment.modelResolution.model,
          summary: `resumed ${assignment.task.id}`,
          status: 'completed' as const,
          attempt: 1
        }
      }
    }

    const resumed = await resumeRun({ previousReport, adapter: new ResumeAdapter() })
    expect(resumed.results.map((result) => result.taskId)).toEqual(['T1', 'T2', 'T3'])
    expect(resumed.runtime.completedTaskIds).toEqual(['T1', 'T2', 'T3'])
    expect(resumed.runtime.pendingTaskIds).toEqual([])
    expect(resumed.batches.some((batch) => batch.batchId.startsWith('R'))).toBe(true)
  })
})
