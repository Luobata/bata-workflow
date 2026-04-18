/**
 * Team phase controller - infers and manages team execution phases.
 * Extracted from OMC phase-controller.ts
 *
 * @module team/phase-controller
 */

import type { Task, TeamPhase } from './types.js';

/**
 * Infer current team phase from task status distribution.
 *
 * Rules (evaluated in order):
 * 1. Empty task list → 'initializing'
 * 2. Any in_progress → 'executing'
 * 3. All pending, no completed, no failed → 'planning'
 * 4. Mixed completed + pending (no in_progress) → 'executing'
 * 5. Any failed AND retries remaining → 'fixing'
 * 6. All tasks failed AND retries exhausted → 'failed'
 * 7. All completed → 'completed'
 * 8. Fallback → 'executing'
 */
export function inferPhase(tasks: Task[]): TeamPhase {
  if (tasks.length === 0) return 'initializing';

  // Categorize tasks
  const inProgress = tasks.filter(t => t.status === 'in_progress');
  const pending = tasks.filter(t => t.status === 'pending' || t.status === 'ready');
  const blocked = tasks.filter(t => t.status === 'blocked');

  // Permanently failed: completed but marked as failed in metadata
  const permanentlyFailed = tasks.filter(
    t => t.status === 'completed' && t.metadata?.permanentlyFailed === true
  );

  // Genuinely completed (not permanently failed)
  const genuinelyCompleted = tasks.filter(
    t => t.status === 'completed' && !t.metadata?.permanentlyFailed
  );

  // Explicitly failed
  const explicitlyFailed = tasks.filter(t => t.status === 'failed');
  const allFailed = [...permanentlyFailed, ...explicitlyFailed];

  // Rule 2: Any in_progress → executing
  if (inProgress.length > 0) return 'executing';

  // Rule 3: All pending, nothing else → planning
  if (
    pending.length === tasks.length &&
    genuinelyCompleted.length === 0 &&
    allFailed.length === 0
  ) {
    return 'planning';
  }

  // Rule 4: Mixed completed + pending → executing
  if (
    pending.length > 0 &&
    genuinelyCompleted.length > 0 &&
    inProgress.length === 0 &&
    allFailed.length === 0
  ) {
    return 'executing';
  }

  // Rules 5 & 6: Handle failures
  if (allFailed.length > 0) {
    // Check if any failed task has retries remaining
    // Note: permanentlyFailed tasks have already exhausted their retries
    const hasRetriesRemaining = allFailed.some(t => {
      // Permanently failed tasks have no retries remaining
      if (t.metadata?.permanentlyFailed === true) return false;
      const retryCount = t.retryCount ?? 0;
      const maxRetries = t.maxRetries ?? 3;
      return retryCount < maxRetries;
    });

    // Rule 6: All tasks are failed and no retries remain
    if (
      (allFailed.length === tasks.length && !hasRetriesRemaining) ||
      (pending.length === 0 && inProgress.length === 0 && genuinelyCompleted.length === 0 && !hasRetriesRemaining)
    ) {
      return 'failed';
    }

    // Rule 5: Some failed but retries available
    if (hasRetriesRemaining) return 'fixing';
  }

  // Rule 7: All genuinely completed, no failures
  if (
    genuinelyCompleted.length === tasks.length &&
    allFailed.length === 0
  ) {
    return 'completed';
  }

  // Rule 8: Fallback
  return 'executing';
}

/**
 * Get a human-readable log message for a phase transition.
 */
export function getPhaseTransitionLog(prev: TeamPhase, next: TeamPhase): string {
  if (prev === next) return `Phase unchanged: ${next}`;
  return `Phase transition: ${prev} → ${next}`;
}

/**
 * Check if a phase is terminal (no further transitions expected).
 */
export function isTerminalPhase(phase: TeamPhase): boolean {
  return phase === 'completed' || phase === 'failed';
}

/**
 * Get human-readable phase description
 */
export function getPhaseDescription(phase: TeamPhase): string {
  const descriptions: Record<TeamPhase, string> = {
    initializing: 'Setting up team and workers',
    planning: 'Planning and decomposing tasks',
    executing: 'Executing tasks in parallel',
    fixing: 'Fixing failed tasks with retries',
    completed: 'All tasks completed successfully',
    failed: 'All tasks failed irrecoverably',
  };
  return descriptions[phase];
}
