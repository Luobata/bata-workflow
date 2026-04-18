/**
 * Team monitor for state aggregation and progress tracking.
 *
 * @module team/monitor
 */

import type { Task, Worker, TeamConfig, TeamPhase, TeamSnapshot, WorkerType } from './types.js';
import { StateStore } from './state-store.js';
import { inferPhase } from './phase-controller.js';
import { deriveLeaderGuidance, generateRecommendations } from './leader-guidance.js';
import { isPaneAlive } from '../tmux-session.js';

/**
 * Team monitor for aggregating state and progress.
 */
export class TeamMonitor {
  private readonly store: StateStore;

  constructor(store: StateStore) {
    this.store = store;
  }

  /**
   * Get a full team snapshot
   */
  async getSnapshot(): Promise<TeamSnapshot | null> {
    const state = await this.store.loadState();
    if (!state) return null;

    const { config, tasks, workers } = state;

    // Check worker aliveness
    const deadWorkers: string[] = [];
    for (const worker of workers) {
      const alive = await this.checkWorkerAlive(worker);
      if (!alive) {
        deadWorkers.push(worker.name);
      }
    }

    // Calculate task stats
    const taskStats = {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending').length,
      ready: tasks.filter(t => t.status === 'ready').length,
      inProgress: tasks.filter(t => t.status === 'in_progress').length,
      completed: tasks.filter(t => t.status === 'completed' && !t.metadata?.permanentlyFailed).length,
      failed: tasks.filter(t => t.status === 'failed' || (t.status === 'completed' && t.metadata?.permanentlyFailed)).length,
      blocked: tasks.filter(t => t.status === 'blocked').length,
    };

    // Infer phase from tasks
    const phase = inferPhase(tasks);

    // Check if all tasks are terminal
    const allTasksTerminal = taskStats.pending + taskStats.ready + taskStats.inProgress + taskStats.blocked === 0;

    // Generate recommendations
    const recommendations = generateRecommendations({
      teamName: config.name,
      phase,
      workers,
      tasks: taskStats,
      allTasksTerminal,
      deadWorkers,
      timestamp: new Date().toISOString(),
    });

    return {
      teamName: config.name,
      phase,
      workers,
      tasks: taskStats,
      allTasksTerminal,
      deadWorkers,
      recommendations,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Check if a worker is alive
   */
  private async checkWorkerAlive(worker: Worker): Promise<boolean> {
    // Check heartbeat freshness
    const heartbeatAlive = this.store.isWorkerAlive(worker.name, 30000);
    if (heartbeatAlive) return true;

    // Check tmux pane status
    if (worker.paneId) {
      try {
        return await isPaneAlive(worker.paneId);
      } catch {
        return false;
      }
    }

    return false;
  }

  /**
   * Get leader guidance based on current state
   */
  async getGuidance(): Promise<ReturnType<typeof deriveLeaderGuidance> | null> {
    const snapshot = await this.getSnapshot();
    if (!snapshot) return null;

    return deriveLeaderGuidance(snapshot);
  }

  /**
   * Get worker status summary
   */
  async getWorkerSummary(): Promise<{
    total: number;
    alive: number;
    idle: number;
    working: number;
    dead: number;
  }> {
    const workers = await this.store.listWorkers();
    const deadWorkers: string[] = [];

    for (const worker of workers) {
      const alive = await this.checkWorkerAlive(worker);
      if (!alive) {
        deadWorkers.push(worker.name);
      }
    }

    return {
      total: workers.length,
      alive: workers.length - deadWorkers.length,
      idle: workers.filter(w => w.status === 'idle' && !deadWorkers.includes(w.name)).length,
      working: workers.filter(w => w.status === 'working' && !deadWorkers.includes(w.name)).length,
      dead: deadWorkers.length,
    };
  }

  /**
   * Get task progress summary
   */
  async getTaskProgress(): Promise<{
    percentage: number;
    phase: TeamPhase;
    eta: string | null;
  }> {
    const stats = await this.store.tasks.getStats();
    const tasks = await this.store.tasks.list();
    const phase = inferPhase(tasks);

    const total = stats.total || 1;
    const done = stats.completed + stats.failed;
    const percentage = Math.round((done / total) * 100);

    // Estimate ETA based on completion rate
    let eta: string | null = null;
    if (stats.inProgress > 0 && done > 0) {
      // Very rough estimate
      const remaining = stats.pending + stats.ready + stats.inProgress + stats.blocked;
      const avgTimePerTask = 5; // minutes (placeholder)
      const estimatedMinutes = remaining * avgTimePerTask / Math.max(1, stats.inProgress);
      eta = `~${Math.round(estimatedMinutes)} minutes`;
    }

    return { percentage, phase, eta };
  }

  /**
   * Format snapshot for display
   */
  formatSnapshot(snapshot: TeamSnapshot): string {
    const lines: string[] = [
      `Team: ${snapshot.teamName}`,
      `Phase: ${snapshot.phase}`,
      '',
      'Workers:',
    ];

    for (const worker of snapshot.workers) {
      const status = snapshot.deadWorkers.includes(worker.name) ? 'DEAD' : worker.status;
      const task = worker.currentTaskId ? ` [${worker.currentTaskId}]` : '';
      lines.push(`  ${worker.name}: ${status}${task}`);
    }

    lines.push('', 'Tasks:');
    lines.push(`  Total:     ${snapshot.tasks.total}`);
    lines.push(`  Completed: ${snapshot.tasks.completed}`);
    lines.push(`  In Progress: ${snapshot.tasks.inProgress}`);
    lines.push(`  Pending:   ${snapshot.tasks.pending}`);
    lines.push(`  Failed:    ${snapshot.tasks.failed}`);
    lines.push(`  Blocked:   ${snapshot.tasks.blocked}`);

    if (snapshot.recommendations.length > 0) {
      lines.push('', 'Recommendations:');
      for (const rec of snapshot.recommendations) {
        lines.push(`  • ${rec}`);
      }
    }

    return lines.join('\n');
  }
}
