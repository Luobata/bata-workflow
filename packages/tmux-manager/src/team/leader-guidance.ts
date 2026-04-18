/**
 * Leader guidance for team orchestration decisions.
 * Extracted from OMC leader-nudge-guidance.ts
 *
 * @module team/leader-guidance
 */

import type { TeamSnapshot, LeaderNextAction, LeaderGuidance, TeamPhase, Worker } from './types.js';

/**
 * Derive the next action the team leader should take based on current state.
 */
export function deriveLeaderGuidance(snapshot: TeamSnapshot): LeaderGuidance {
  const { tasks, workers } = snapshot;
  const activeTasks = tasks.pending + tasks.ready + tasks.inProgress + tasks.blocked;
  const totalWorkers = workers.length;
  const aliveWorkers = workers.filter(w => w.status !== 'shutdown').length;
  const idleWorkers = workers.filter(w => w.status === 'idle').length;
  const deadWorkers = snapshot.deadWorkers.length;

  // No active tasks → can shutdown
  if (activeTasks === 0) {
    return {
      nextAction: 'shutdown',
      reason: `all_tasks_terminal:completed=${tasks.completed},failed=${tasks.failed},workers=${totalWorkers}`,
      message: 'All tasks are in a terminal state. Review any failures, then shut down or clean up the team.',
    };
  }

  // No alive workers → need new team
  if (aliveWorkers === 0) {
    return {
      nextAction: 'launch-new-team',
      reason: `no_alive_workers:active=${activeTasks},total_workers=${totalWorkers}`,
      message: 'Active tasks remain, but no workers appear alive. Launch a new team or replace the dead workers.',
    };
  }

  // All alive workers are idle → can reuse
  if (idleWorkers >= aliveWorkers) {
    return {
      nextAction: 'reuse-team',
      reason: `all_alive_workers_idle:active=${activeTasks},alive=${aliveWorkers},idle=${idleWorkers}`,
      message: 'Workers are idle while active tasks remain. Reuse the current team and reassign or unblock pending work.',
    };
  }

  // Normal operation
  return {
    nextAction: 'keep-monitoring',
    reason: `workers_still_active:active=${activeTasks},alive=${aliveWorkers},idle=${idleWorkers}`,
    message: 'Workers still appear active. Keep monitoring team status.',
  };
}

/**
 * Check if intervention is needed based on worker states
 */
export function needsIntervention(snapshot: TeamSnapshot): boolean {
  const { workers, tasks, deadWorkers } = snapshot;

  // Dead workers with active tasks
  if (deadWorkers.length > 0 && tasks.inProgress > 0) {
    return true;
  }

  // All workers idle but tasks pending
  const idleWorkers = workers.filter(w => w.status === 'idle').length;
  const aliveWorkers = workers.filter(w => w.status !== 'shutdown').length;
  if (idleWorkers === aliveWorkers && (tasks.pending > 0 || tasks.blocked > 0)) {
    return true;
  }

  // Too many failed tasks
  const failureRate = tasks.total > 0 ? tasks.failed / tasks.total : 0;
  if (failureRate > 0.5) {
    return true;
  }

  return false;
}

/**
 * Input for generating recommendations
 */
export interface RecommendationsInput {
  teamName: string;
  phase: TeamPhase;
  workers: Worker[];
  tasks: {
    total: number;
    pending: number;
    ready: number;
    inProgress: number;
    completed: number;
    failed: number;
    blocked: number;
  };
  allTasksTerminal: boolean;
  deadWorkers: string[];
  timestamp: string;
}

/**
 * Generate intervention recommendations
 */
export function generateRecommendations(input: RecommendationsInput): string[] {
  const recommendations: string[] = [];
  const { workers, tasks, phase, deadWorkers } = input;

  // Blocked tasks
  if (tasks.blocked > 0) {
    recommendations.push(`${tasks.blocked} tasks are blocked by dependencies. Review dependency chain.`);
  }

  // Failed tasks with retries
  if (tasks.failed > 0) {
    const failedWithRetries = tasks.failed;
    if (failedWithRetries > 0) {
      recommendations.push(`${failedWithRetries} tasks failed. Check error logs and consider retry or reroute.`);
    }
  }

  // Idle workers with pending tasks
  const idleWorkers = workers.filter(w => w.status === 'idle').length;
  if (idleWorkers > 0 && tasks.pending > 0) {
    recommendations.push(`${idleWorkers} workers idle with ${tasks.pending} pending tasks. Assign tasks to idle workers.`);
  }

  // Dead workers
  if (deadWorkers.length > 0) {
    recommendations.push(`${deadWorkers.length} workers are dead. Consider launching replacement workers.`);
  }

  // Phase-specific recommendations
  if (phase === 'fixing') {
    recommendations.push('Team is in fixing phase. Monitor retry progress closely.');
  }

  return recommendations;
}
