/**
 * Team orchestration module for multi-agent coordination.
 *
 * @module team
 *
 * @example
 * ```typescript
 * import {
 *   TaskManager,
 *   StateStore,
 *   TeamMonitor,
 *   inferPhase,
 *   deriveLeaderGuidance,
 * } from '@luobata/tmux-manager/team';
 *
 * // Initialize state storage
 * const store = new StateStore({
 *   stateRoot: '/tmp/team-state',
 *   teamName: 'my-team',
 * });
 *
 * // Create tasks
 * const task = await store.tasks.create({
 *   subject: 'Implement feature',
 *   description: 'Add new feature to the codebase',
 * });
 *
 * // Get team snapshot
 * const monitor = new TeamMonitor(store);
 * const snapshot = await monitor.getSnapshot();
 *
 * // Get guidance for next action
 * const guidance = await monitor.getGuidance();
 * console.log(guidance?.message);
 * ```
 */

// Types
export type {
  Task,
  TaskStatus,
  TaskPriority,
  CreateTaskInput,
  UpdateTaskInput,
  Worker,
  WorkerStatus,
  WorkerType,
  CreateWorkerInput,
  TeamConfig,
  TeamPhase,
  TeamState,
  TeamSnapshot,
  LeaderNextAction,
  LeaderGuidance,
  CreateTeamOptions,
  StateStoreOptions,
} from './types.js';

// Phase Controller
export {
  inferPhase,
  getPhaseTransitionLog,
  isTerminalPhase,
  getPhaseDescription,
} from './phase-controller.js';

// Leader Guidance
export {
  deriveLeaderGuidance,
  needsIntervention,
  generateRecommendations,
} from './leader-guidance.js';

export type { RecommendationsInput } from './leader-guidance.js';

// Task Manager
export { TaskManager } from './task-manager.js';

// State Store
export { StateStore } from './state-store.js';

// Team Monitor
export { TeamMonitor } from './monitor.js';
