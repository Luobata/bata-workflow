import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Plan, RunReport } from '../domain/types.js'

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

function slugifyGoal(goal: string): string {
  const normalized = goal
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return normalized || 'goal'
}

function buildRunDir(stateRoot: string, goal: string): string {
  const runId = `${Date.now()}-${slugifyGoal(goal).slice(0, 48)}`
  return resolve(stateRoot, 'runs', runId)
}

export interface StateStoreResult {
  runDirectory: string
  planPath: string
  reportPath: string
  taskStorePath: string
}

export interface LatestRunPointer {
  runDirectory: string
  reportPath: string
}

export interface TaskStoreSnapshot {
  goal: string
  assignments: RunReport['assignments']
  taskStates: RunReport['runtime']['taskStates']
  pendingTaskIds: string[]
  completedTaskIds: string[]
}

export function persistPlan(stateRoot: string, plan: Plan): string {
  const planDir = resolve(stateRoot, 'plans')
  ensureDir(planDir)
  const planPath = resolve(planDir, 'latest-plan.json')
  writeFileSync(planPath, JSON.stringify(plan, null, 2))
  return planPath
}

export function persistTaskStore(runDirectory: string, report: RunReport): string {
  const taskStorePath = resolve(runDirectory, 'task-store.json')
  const snapshot: TaskStoreSnapshot = {
    goal: report.goal,
    assignments: report.assignments,
    taskStates: report.runtime.taskStates,
    pendingTaskIds: report.runtime.pendingTaskIds,
    completedTaskIds: report.runtime.completedTaskIds
  }
  writeFileSync(taskStorePath, JSON.stringify(snapshot, null, 2))
  return taskStorePath
}

export function persistRunReport(stateRoot: string, report: RunReport, runDirectory?: string): StateStoreResult {
  const targetRunDirectory = runDirectory ?? buildRunDir(stateRoot, report.goal)
  ensureDir(targetRunDirectory)

  const planPath = resolve(targetRunDirectory, 'plan.json')
  const reportPath = resolve(targetRunDirectory, 'report.json')
  const latestPath = resolve(stateRoot, 'latest-run.json')

  writeFileSync(planPath, JSON.stringify(report.plan, null, 2))
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  const taskStorePath = persistTaskStore(targetRunDirectory, report)
  writeFileSync(latestPath, JSON.stringify({ runDirectory: targetRunDirectory, reportPath }, null, 2))

  return { runDirectory: targetRunDirectory, planPath, reportPath, taskStorePath }
}

export function loadLatestRunPointer(stateRoot: string): LatestRunPointer | null {
  const latestPath = resolve(stateRoot, 'latest-run.json')
  if (!existsSync(latestPath)) {
    return null
  }
  return JSON.parse(readFileSync(latestPath, 'utf8')) as LatestRunPointer
}

export function loadRunReport(reportPath: string): RunReport {
  return JSON.parse(readFileSync(reportPath, 'utf8')) as RunReport
}

export function loadTaskStore(taskStorePath: string): TaskStoreSnapshot {
  return JSON.parse(readFileSync(taskStorePath, 'utf8')) as TaskStoreSnapshot
}
