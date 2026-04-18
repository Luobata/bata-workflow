/**
 * High-level tmux session and pane management.
 * Provides APIs for creating split layouts, managing sessions, and controlling panes.
 *
 * @module tmux-session
 */

import { existsSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import {
  tmuxExecAsync,
  tmuxShellAsync,
  isInTmux,
  detectMultiplexerContext,
  sessionExists,
  killPane,
} from './tmux-utils.js';
import type {
  PaneConfig,
  SplitLayout,
  CreateLayoutOptions,
  CreateSessionOptions,
  SplitLayoutResult,
  SessionMode,
  SessionResult,
  SendInputOptions,
  CapturePaneOptions,
  PaneInfo,
  MultiplexerContext,
} from './types.js';

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 30000;
const SESSION_PREFIX = 'tmux-manager';

// ── Utilities ─────────────────────────────────────────────────────────────────

/**
 * Sanitize a name to prevent tmux command injection
 */
export function sanitizeName(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9-_]/g, '-');
  if (sanitized.length === 0 || /^-+$/.test(sanitized)) {
    throw new Error(`Invalid name: "${name}" contains no valid characters`);
  }
  return sanitized.slice(0, 50);
}

/**
 * Validate tmux is available
 */
export async function validateTmux(): Promise<void> {
  const inTmux = isInTmux();
  if (inTmux) return;

  try {
    await tmuxExecAsync(['-V'], { timeout: 5000 });
  } catch {
    throw new Error(
      'tmux is not available. Install it:\n' +
      '  macOS: brew install tmux\n' +
      '  Ubuntu/Debian: sudo apt-get install tmux\n' +
      '  Fedora: sudo dnf install tmux\n' +
      '  Arch: sudo pacman -S tmux'
    );
  }
}

// ── Session Management ───────────────────────────────────────────────────────

/**
 * Create a detached tmux session
 */
export async function createSession(options: CreateSessionOptions): Promise<SessionResult> {
  await validateTmux();

  const name = sanitizeName(options.name);
  const width = options.width ?? 200;
  const height = options.height ?? 50;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  // Kill existing session if present
  try {
    await tmuxExecAsync(['kill-session', '-t', name], { timeout: 5000 });
  } catch {
    // Session may not exist
  }

  // Create new detached session
  const args = [
    'new-session', '-d',
    '-s', name,
    '-x', String(width),
    '-y', String(height),
    '-P', '-F', '#{pane_id}',
  ];

  if (options.cwd) {
    args.push('-c', options.cwd);
  }

  const result = await tmuxExecAsync(args, { timeout, stripTmux: true });
  const paneId = result.stdout.trim();

  // Run initial command if provided
  if (options.command) {
    await sendToPane(paneId, options.command, { enter: true, timeout });
  }

  return { name, paneId };
}

/**
 * Create a new window in an existing session
 */
export async function createWindow(
  sessionName: string,
  windowName?: string,
  cwd?: string
): Promise<{ windowId: string; paneId: string }> {
  const args = [
    'new-window', '-d',
    '-P', '-F', '#S:#I #{pane_id}',
    '-t', sessionName,
  ];

  if (windowName) {
    args.push('-n', sanitizeName(windowName));
  }

  if (cwd) {
    args.push('-c', cwd);
  }

  const result = await tmuxExecAsync(args, { timeout: DEFAULT_TIMEOUT });
  const parts = result.stdout.trim().split(/\s+/);
  const windowId = parts[0] ?? '';
  const paneId = parts[1] ?? '';

  return { windowId, paneId };
}

// ── Split Layout ──────────────────────────────────────────────────────────────

/**
 * Create a split layout with multiple panes
 */
export async function createSplitLayout(
  layout: SplitLayout,
  options: CreateLayoutOptions = {}
): Promise<SplitLayoutResult> {
  await validateTmux();

  const context = detectMultiplexerContext();
  const inTmux = context === 'tmux';
  const useNewWindow = Boolean(options.newWindow && inTmux);

  let sessionName: string;
  let leaderPaneId: string;
  let mode: SessionMode;

  if (!inTmux) {
    // Create detached session
    const sessionName_ = options.sessionName ?? `${SESSION_PREFIX}-${Date.now().toString(36)}`;
    const session = await createSession({
      name: sessionName_,
      cwd: layout.panes[0]?.cwd ?? process.cwd(),
    });
    sessionName = session.name;
    leaderPaneId = session.paneId;
    mode = 'detached-session';
  } else if (useNewWindow) {
    // Create new window in current session
    const { windowId, paneId } = await createWindow(
      process.env.TMUX ? await getCurrentSessionName() : '',
      options.windowName,
      layout.panes[0]?.cwd
    );
    sessionName = windowId;
    leaderPaneId = paneId;
    mode = 'dedicated-window';
  } else {
    // Split current pane
    const currentPane = await getCurrentPaneId();
    sessionName = await getCurrentSessionWindow();
    leaderPaneId = currentPane;
    mode = 'split-pane';
  }

  // Create worker panes
  const workerPaneIds: string[] = [];
  const workerConfigs = layout.panes.slice(1);

  for (let i = 0; i < workerConfigs.length; i++) {
    const config = workerConfigs[i]!;
    const splitTarget = i === 0 ? leaderPaneId : workerPaneIds[i - 1]!;
    const splitType = layout.type === 'horizontal' ? '-h' : '-v';

    const args = [
      'split-window', splitType,
      '-t', splitTarget,
      '-d', '-P', '-F', '#{pane_id}',
      '-c', config.cwd ?? process.cwd(),
    ];

    const result = await tmuxExecAsync(args, { timeout: options.timeout ?? DEFAULT_TIMEOUT });
    const paneId = result.stdout.trim();
    workerPaneIds.push(paneId);

    // Send initial command if provided
    if (config.command) {
      await sendToPane(paneId, config.command, {
        enter: true,
        env: config.env,
        args: config.args,
        timeout: options.timeout,
      });
    }
  }

  // Apply layout optimization
  await applyLayout(sessionName, layout.type);

  // Enable mouse mode
  try {
    await tmuxExecAsync(['set-option', '-t', sessionName.split(':')[0]!, 'mouse', 'on']);
  } catch {
    // Ignore
  }

  // Focus leader pane in split-pane mode
  if (mode === 'split-pane') {
    try {
      await tmuxExecAsync(['select-pane', '-t', leaderPaneId]);
    } catch {
      // Ignore
    }
  }

  return {
    sessionName,
    leaderPaneId,
    workerPaneIds,
    mode,
  };
}

/**
 * Apply a layout to a window
 */
export async function applyLayout(target: string, type: 'horizontal' | 'vertical' | 'grid'): Promise<void> {
  try {
    if (type === 'horizontal') {
      await tmuxExecAsync(['select-layout', '-t', target, 'main-vertical']);
    } else if (type === 'vertical') {
      await tmuxExecAsync(['select-layout', '-t', target, 'main-horizontal']);
    } else {
      await tmuxExecAsync(['select-layout', '-t', target, 'tiled']);
    }
  } catch {
    // Layout may not apply with single pane
  }
}

// ── Pane Control ──────────────────────────────────────────────────────────────

/**
 * Send input to a pane
 */
export async function sendToPane(
  paneId: string,
  input: string,
  options: SendInputOptions & { env?: Record<string, string>; args?: string[] } = {}
): Promise<void> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;

  // Build command with environment variables
  let command = input;
  if (options.env && Object.keys(options.env).length > 0) {
    const envPrefix = Object.entries(options.env)
      .map(([k, v]) => `${k}=${shellEscape(v)}`)
      .join(' ');
    command = `env ${envPrefix} ${command}`;
  }

  if (options.args && options.args.length > 0) {
    command = `${command} ${options.args.map(shellEscape).join(' ')}`;
  }

  // Send command in literal mode
  await tmuxExecAsync(
    ['send-keys', '-t', paneId, '-l', '--', command],
    { timeout }
  );

  if (options.enter !== false) {
    // Small delay before Enter
    await new Promise(r => setTimeout(r, 50));
    await tmuxExecAsync(['send-keys', '-t', paneId, 'Enter'], { timeout });
  }
}

/**
 * Capture pane content
 */
export async function capturePane(
  paneId: string,
  options: CapturePaneOptions = {}
): Promise<string> {
  const args = ['capture-pane', '-t', paneId, '-p'];

  if (options.scrollback !== undefined) {
    args.push('-S', String(options.scrollback));
  }

  if (options.escape) {
    args.push('-e');
  }

  const result = await tmuxExecAsync(args, { timeout: options.timeout ?? DEFAULT_TIMEOUT });
  return result.stdout;
}

/**
 * Select (focus) a pane
 */
export async function selectPane(paneId: string): Promise<void> {
  await tmuxExecAsync(['select-pane', '-t', paneId]);
}

/**
 * Resize a pane
 */
export async function resizePane(
  paneId: string,
  direction: 'up' | 'down' | 'left' | 'right',
  amount: number = 5
): Promise<void> {
  await tmuxExecAsync(['resize-pane', '-t', paneId, `-${direction[0]}`, String(amount)]);
}

/**
 * Check if a pane is alive
 */
export async function isPaneAlive(paneId: string): Promise<boolean> {
  try {
    const result = await tmuxExecAsync(
      ['display-message', '-t', paneId, '-p', '#{pane_dead}'],
      { timeout: 5000 }
    );
    return result.stdout.trim() === '0';
  } catch {
    return false;
  }
}

/**
 * Check if a pane is in copy mode
 */
export async function isPaneInCopyMode(paneId: string): Promise<boolean> {
  try {
    const result = await tmuxExecAsync(
      ['display-message', '-t', paneId, '-p', '#{pane_in_mode}'],
      { timeout: 5000 }
    );
    return result.stdout.trim() === '1';
  } catch {
    return false;
  }
}

/**
 * Get pane information
 */
export async function getPaneInfo(paneId: string): Promise<PaneInfo | null> {
  try {
    const format = '#{pane_id}|#{pane_index}|#{pane_width}|#{pane_height}|#{pane_current_path}|#{pane_title}|#{pane_in_mode}|#{pane_dead}';
    const result = await tmuxExecAsync(
      ['display-message', '-t', paneId, '-p', format],
      { timeout: 5000 }
    );

    const parts = result.stdout.trim().split('|');
    return {
      paneId: parts[0] ?? '',
      paneIndex: parseInt(parts[1] ?? '0', 10),
      width: parseInt(parts[2] ?? '0', 10),
      height: parseInt(parts[3] ?? '0', 10),
      cwd: parts[4] ?? '',
      title: parts[5] || undefined,
      inCopyMode: parts[6] === '1',
      dead: parts[7] === '1',
    };
  } catch {
    return null;
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

/**
 * Kill panes by IDs
 */
export async function killPanes(paneIds: string[]): Promise<void> {
  for (const paneId of paneIds) {
    await killPane(paneId);
  }
}

/**
 * Kill a split layout
 */
export async function killSplitLayout(result: SplitLayoutResult): Promise<void> {
  const { sessionName, leaderPaneId, workerPaneIds, mode } = result;

  if (mode === 'split-pane') {
    // Only kill worker panes, preserve leader
    await killPanes(workerPaneIds);
  } else if (mode === 'dedicated-window') {
    // Kill the entire window
    try {
      await tmuxExecAsync(['kill-window', '-t', sessionName], { timeout: 5000 });
    } catch {
      // Window may not exist
    }
  } else {
    // Kill the entire session
    const session = sessionName.split(':')[0] ?? sessionName;
    try {
      await tmuxExecAsync(['kill-session', '-t', session], { timeout: 5000 });
    } catch {
      // Session may not exist
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getCurrentSessionName(): Promise<string> {
  const result = await tmuxExecAsync(['display-message', '-p', '#S']);
  return result.stdout.trim();
}

async function getCurrentSessionWindow(): Promise<string> {
  const result = await tmuxExecAsync(['display-message', '-p', '#S:#I']);
  return result.stdout.trim();
}

async function getCurrentPaneId(): Promise<string> {
  const result = await tmuxExecAsync(['display-message', '-p', '#{pane_id}']);
  return result.stdout.trim();
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}
