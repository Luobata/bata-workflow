/**
 * Low-level tmux command execution utilities.
 * Provides a clean API for executing tmux commands without any business logic.
 *
 * @module tmux-utils
 */

import { exec, execFile, execFileSync, execSync, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { promisify } from 'node:util';
import type { MultiplexerContext, TmuxHealthCheck } from './types.js';

const execAsync = promisify(exec);

// ── Environment & Detection ──────────────────────────────────────────────────

/**
 * Detect the current multiplexer context
 */
export function detectMultiplexerContext(env: NodeJS.ProcessEnv = process.env): MultiplexerContext {
  if (env.TMUX) return 'tmux';
  if (env.CMUX_SURFACE_ID) return 'cmux';
  return 'none';
}

/**
 * Check if currently inside a tmux session
 */
export function isInTmux(env: NodeJS.ProcessEnv = process.env): boolean {
  return detectMultiplexerContext(env) === 'tmux';
}

/**
 * Get tmux environment without TMUX variable (for cross-session operations)
 */
export function getCleanTmuxEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { TMUX: _, ...cleanEnv } = env;
  return cleanEnv;
}

/**
 * Perform a health check on tmux availability
 */
export async function checkTmuxHealth(): Promise<TmuxHealthCheck> {
  const result: TmuxHealthCheck = {
    available: false,
    inTmux: isInTmux(),
  };

  try {
    const { stdout } = await execAsync('tmux -V', { timeout: 5000 });
    result.available = true;
    result.version = stdout.trim();
  } catch {
    // tmux not available
  }

  if (result.inTmux && process.env.TMUX) {
    try {
      const { stdout: sessionOut } = await execAsync('tmux display-message -p "#S"', { timeout: 5000 });
      const { stdout: windowOut } = await execAsync('tmux display-message -p "#I"', { timeout: 5000 });
      const { stdout: paneOut } = await execAsync('tmux display-message -p "#{pane_id}"', { timeout: 5000 });
      result.currentSession = sessionOut.trim();
      result.currentWindow = windowOut.trim();
      result.currentPaneId = paneOut.trim();
    } catch {
      // Ignore errors
    }
  }

  return result;
}

// ── Execution Options ─────────────────────────────────────────────────────────

export interface TmuxExecOptions {
  /** Strip TMUX env var so the command targets the default tmux server */
  stripTmux?: boolean;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Current working directory */
  cwd?: string;
}

interface TmuxInvocation {
  command: string;
  args: string[];
}

function resolveTmuxBinary(): string {
  // On Windows with MSYS2/Git Bash, tmux might be a .cmd or .bat file
  if (process.platform === 'win32') {
    const comspec = process.env.COMSPEC || 'cmd.exe';
    // Try to find tmux.cmd or tmux.bat
    return 'tmux';
  }
  return 'tmux';
}

function quoteForCmd(arg: string): string {
  if (arg.length === 0) return '""';
  if (!/[\s"%^&|<>()]/.test(arg)) return arg;
  return `"${arg.replace(/(["%])/g, '$1$1')}"`;
}

function resolveInvocation(args: string[], options?: TmuxExecOptions): TmuxInvocation {
  const binary = resolveTmuxBinary();
  const env = options?.stripTmux ? getCleanTmuxEnv() : process.env;

  // Check if we need to use cmd.exe wrapper (Windows)
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary)) {
    const comspec = process.env.COMSPEC || 'cmd.exe';
    const commandLine = [quoteForCmd(binary), ...args.map(quoteForCmd)].join(' ');
    return {
      command: comspec,
      args: ['/d', '/s', '/c', commandLine],
    };
  }

  return {
    command: binary,
    args,
  };
}

function getExecEnv(options?: TmuxExecOptions): NodeJS.ProcessEnv | undefined {
  if (options?.stripTmux) {
    return getCleanTmuxEnv();
  }
  return process.env;
}

// ── Sync API ──────────────────────────────────────────────────────────────────

/**
 * Execute a tmux command synchronously and return stdout
 */
export function tmuxExec(
  args: string[],
  options?: TmuxExecOptions
): string {
  const invocation = resolveInvocation(args, options);
  const execOptions = {
    encoding: 'utf-8' as const,
    timeout: options?.timeout ?? 30000,
    env: getExecEnv(options),
    cwd: options?.cwd,
  };

  return execFileSync(invocation.command, invocation.args, execOptions);
}

/**
 * Execute a tmux command via shell (useful for commands with #{} format strings)
 */
export function tmuxShell(
  command: string,
  options?: TmuxExecOptions
): string {
  const env = getExecEnv(options);
  return execSync(`tmux ${command}`, {
    encoding: 'utf-8',
    timeout: options?.timeout ?? 30000,
    env,
    cwd: options?.cwd,
  }) as string;
}

// ── Async API ─────────────────────────────────────────────────────────────────

/**
 * Execute a tmux command asynchronously
 */
export async function tmuxExecAsync(
  args: string[],
  options?: TmuxExecOptions
): Promise<{ stdout: string; stderr: string }> {
  const invocation = resolveInvocation(args, options);
  const execOptions: ExecFileOptionsWithStringEncoding = {
    encoding: 'utf-8',
    timeout: options?.timeout ?? 30000,
    env: getExecEnv(options),
    cwd: options?.cwd,
  };

  return promisify(execFile)(invocation.command, invocation.args, execOptions);
}

/**
 * Execute a tmux command via shell asynchronously
 */
export async function tmuxShellAsync(
  command: string,
  options?: TmuxExecOptions
): Promise<{ stdout: string; stderr: string }> {
  const env = getExecEnv(options);
  return execAsync(`tmux ${command}`, {
    encoding: 'utf-8',
    timeout: options?.timeout ?? 30000,
    env,
    cwd: options?.cwd,
  });
}

// ── Convenience Functions ─────────────────────────────────────────────────────

/**
 * Check if a tmux session exists
 */
export async function sessionExists(sessionName: string): Promise<boolean> {
  try {
    await tmuxExecAsync(['has-session', '-t', sessionName], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a pane exists
 */
export async function paneExists(paneId: string): Promise<boolean> {
  try {
    const { stdout } = await tmuxExecAsync(
      ['display-message', '-t', paneId, '-p', '#{pane_id}'],
      { timeout: 5000 }
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * List all sessions
 */
export async function listSessions(): Promise<string[]> {
  try {
    const { stdout } = await tmuxExecAsync(['list-sessions', '-F', '#{session_name}']);
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * List panes in a session or window
 */
export async function listPanes(target?: string): Promise<string[]> {
  try {
    const args = target
      ? ['list-panes', '-t', target, '-F', '#{pane_id}']
      : ['list-panes', '-F', '#{pane_id}'];
    const { stdout } = await tmuxExecAsync(args);
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Kill a session
 */
export async function killSession(sessionName: string): Promise<void> {
  try {
    await tmuxExecAsync(['kill-session', '-t', sessionName], { timeout: 5000 });
  } catch {
    // Session may not exist
  }
}

/**
 * Kill a pane
 */
export async function killPane(paneId: string): Promise<void> {
  try {
    await tmuxExecAsync(['kill-pane', '-t', paneId], { timeout: 5000 });
  } catch {
    // Pane may not exist
  }
}
