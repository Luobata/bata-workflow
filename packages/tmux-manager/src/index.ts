/**
 * @luobata/tmux-manager
 *
 * A standalone tmux pane management library for creating split layouts
 * and managing terminal sessions programmatically.
 *
 * @example
 * ```typescript
 * import { createSplitLayout, sendToPane, capturePane, killSplitLayout } from '@luobata/tmux-manager';
 *
 * // Create a split layout with 3 panes
 * const result = await createSplitLayout({
 *   type: 'horizontal',
 *   panes: [
 *     { name: 'leader', cwd: '/workspace' },
 *     { name: 'worker1', cwd: '/workspace', command: 'npm run dev' },
 *     { name: 'worker2', cwd: '/workspace', command: 'npm test' },
 *   ],
 * }, { newWindow: true });
 *
 * // Send command to a worker pane
 * await sendToPane(result.workerPaneIds[0]!, 'echo "Hello"');
 *
 * // Capture output
 * const output = await capturePane(result.workerPaneIds[0]!);
 *
 * // Cleanup
 * await killSplitLayout(result);
 * ```
 */

// Low-level utilities
export {
  detectMultiplexerContext,
  isInTmux,
  getCleanTmuxEnv,
  checkTmuxHealth,
  tmuxExec,
  tmuxShell,
  tmuxExecAsync,
  tmuxShellAsync,
  sessionExists,
  paneExists,
  listSessions,
  listPanes,
  killSession,
  killPane,
} from './tmux-utils.js';

// High-level session management
export {
  sanitizeName,
  validateTmux,
  createSession,
  createWindow,
  createSplitLayout,
  applyLayout,
  sendToPane,
  capturePane,
  selectPane,
  resizePane,
  isPaneAlive,
  isPaneInCopyMode,
  getPaneInfo,
  killPanes,
  killSplitLayout,
} from './tmux-session.js';

// Types
export type {
  PaneConfig,
  SplitLayoutType,
  SplitLayout,
  CreateLayoutOptions,
  CreateSessionOptions,
  SplitLayoutResult,
  SessionMode,
  SessionResult,
  SendInputOptions,
  CapturePaneOptions,
  PaneInfo,
  SessionInfo,
  MultiplexerContext,
  TmuxHealthCheck,
} from './types.js';

// Team Orchestration Module
export * from './team/index.js';
