import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { Plan, RunReport } from '../domain/types.js'
import { getQueuePath, type TaskStoreSnapshot, getTaskStorePath } from './task-store.js'

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

function atomicWriteJson(path: string, data: unknown): void {
  ensureDir(resolve(path, '..'))
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tempPath, JSON.stringify(data, null, 2))
  renameSync(tempPath, path)
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

export function getRunReportPath(runDirectory: string): string {
  return resolve(runDirectory, 'report.json')
}

export interface StateStoreResult {
  runDirectory: string
  planPath: string
  reportPath: string
  taskStorePath: string
  queuePath: string
}

export interface LatestRunPointer {
  runDirectory: string
  reportPath: string
  taskStorePath: string
  queuePath: string
}

function buildTaskStoreSnapshot(report: RunReport): TaskStoreSnapshot {
  return {
    goal: report.goal,
    plan: report.plan,
    assignments: report.assignments,
    taskStates: report.runtime.taskStates,
    pendingTaskIds: report.runtime.pendingTaskIds,
    blockedTaskIds: report.runtime.blockedTaskIds,
    completedTaskIds: report.runtime.completedTaskIds,
    results: report.results,
    artifactsByTaskId: report.artifactsByTaskId
  }
}

export function createRunDirectory(stateRoot: string, goal: string): string {
  const runDirectory = buildRunDir(stateRoot, goal)
  ensureDir(runDirectory)
  return runDirectory
}

export function persistPlan(stateRoot: string, plan: Plan): string {
  const planDir = resolve(stateRoot, 'plans')
  ensureDir(planDir)
  const planPath = resolve(planDir, 'latest-plan.json')
  atomicWriteJson(planPath, plan)
  return planPath
}

export function persistTaskStore(runDirectory: string, report: RunReport): string {
  const taskStorePath = getTaskStorePath(runDirectory)
  atomicWriteJson(taskStorePath, buildTaskStoreSnapshot(report))
  return taskStorePath
}

export function persistRunReport(stateRoot: string, report: RunReport, runDirectory?: string): StateStoreResult {
  const targetRunDirectory = runDirectory ?? createRunDirectory(stateRoot, report.goal)
  ensureDir(targetRunDirectory)

  const planPath = resolve(targetRunDirectory, 'plan.json')
  const reportPath = getRunReportPath(targetRunDirectory)
  const latestPath = resolve(stateRoot, 'latest-run.json')
  const queuePath = getQueuePath(targetRunDirectory)
  const taskStorePath = persistTaskStore(targetRunDirectory, report)

  atomicWriteJson(planPath, report.plan)
  atomicWriteJson(reportPath, report)
  atomicWriteJson(
    latestPath,
    {
      runDirectory: targetRunDirectory,
      reportPath,
      taskStorePath,
      queuePath
    } satisfies LatestRunPointer
  )

  return { runDirectory: targetRunDirectory, planPath, reportPath, taskStorePath, queuePath }
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
