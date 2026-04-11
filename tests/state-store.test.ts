import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadLatestRunPointer, loadRunReport, loadTaskStore, persistPlan, persistRunReport } from '../src/runtime/state-store.js'
import type { Plan, RunReport } from '../src/domain/types.js'

describe('state store', () => {
  it('落盘 plan 与 run report', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'harness-state-'))
    const plan: Plan = {
      goal: 'test goal',
      summary: 'summary',
      tasks: []
    }
    const planPath = persistPlan(root, plan)
    const storedPlan = JSON.parse(readFileSync(planPath, 'utf8')) as Plan
    expect(storedPlan.goal).toBe('test goal')

    const report: RunReport = {
      goal: 'test goal',
      plan,
      assignments: [],
      batches: [],
      runtime: {
        workers: [],
        batches: [],
        completedTaskIds: [],
        pendingTaskIds: [],
        events: [],
        mailbox: [],
        taskStates: []
      },
      results: []
    }
    const persisted = persistRunReport(root, report)
    const storedReport = JSON.parse(readFileSync(persisted.reportPath, 'utf8')) as RunReport
    expect(storedReport.goal).toBe('test goal')
    const latestPointer = loadLatestRunPointer(root)
    expect(latestPointer?.reportPath).toBe(persisted.reportPath)
    expect(loadRunReport(persisted.reportPath).goal).toBe('test goal')
    expect(loadTaskStore(persisted.taskStorePath).goal).toBe('test goal')
  })
})
