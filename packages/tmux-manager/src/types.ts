/**
 * Core types for tmux-manager
 */

/**
 * Pane configuration for creating a new pane
 */
export interface PaneConfig {
  /** Unique identifier for the pane (used in pane naming) */
  name: string;
  /** Working directory for the pane */
  cwd: string;
  /** Environment variables to set in the pane */
  env?: Record<string, string>;
  /** Command to execute when pane starts (optional) */
  command?: string;
  /** Arguments for the command */
  args?: string[];
}

/**
 * Layout type for split panes
 */
export type SplitLayoutType = 'horizontal' | 'vertical' | 'grid';

/**
 * Layout configuration for creating split panes
 */
export interface SplitLayout {
  /** Type of layout */
  type: SplitLayoutType;
  /** Pane configurations in order (first pane is the leader/root) */
  panes: PaneConfig[];
}

/**
 * Options for creating a split layout
 */
export interface CreateLayoutOptions {
  /** Create in a new tmux window instead of splitting current pane */
  newWindow?: boolean;
  /** Custom session name (auto-generated if not provided) */
  sessionName?: string;
  /** Window name when creating in new window */
  windowName?: string;
  /** Timeout for tmux commands in milliseconds */
  timeout?: number;
}

/**
 * Options for creating a detached session
 */
export interface CreateSessionOptions {
  /** Session name */
  name: string;
  /** Working directory */
  cwd: string;
  /** Initial command to run */
  command?: string;
  /** Terminal width */
  width?: number;
  /** Terminal height */
  height?: number;
  /** Timeout for tmux commands in milliseconds */
  timeout?: number;
}

/**
 * Result of creating a split layout
 */
export interface SplitLayoutResult {
  /** Session name (format: "session:window" for split-pane, "session" for detached) */
  sessionName: string;
  /** Leader pane ID (format: "%N") */
  leaderPaneId: string;
  /** Worker pane IDs */
  workerPaneIds: string[];
  /** Session mode that was used */
  mode: SessionMode;
}

/**
 * Session mode determines how panes are created
 */
export type SessionMode = 'split-pane' | 'dedicated-window' | 'detached-session';

/**
 * Result of creating a detached session
 */
export interface SessionResult {
  /** Session name */
  name: string;
  /** Initial pane ID */
  paneId: string;
}

/**
 * Options for sending input to a pane
 */
export interface SendInputOptions {
  /** Use literal mode (don't interpret key names) */
  literal?: boolean;
  /** Add Enter key after the input */
  enter?: boolean;
  /** Timeout for tmux commands in milliseconds */
  timeout?: number;
}

/**
 * Options for capturing pane content
 */
export interface CapturePaneOptions {
  /** Number of lines to capture from history (negative for all) */
  scrollback?: number;
  /** Include escape sequences */
  escape?: boolean;
  /** Timeout for tmux commands in milliseconds */
  timeout?: number;
}

/**
 * Pane information from tmux list-panes
 */
export interface PaneInfo {
  /** Pane ID (format: "%N") */
  paneId: string;
  /** Pane index in the window */
  paneIndex: number;
  /** Pane width in columns */
  width: number;
  /** Pane height in rows */
  height: number;
  /** Pane current working directory */
  cwd: string;
  /** Pane title (if set) */
  title?: string;
  /** Whether the pane is in copy mode */
  inCopyMode?: boolean;
  /** Whether the pane is dead (process exited) */
  dead?: boolean;
}

/**
 * Session information from tmux list-sessions
 */
export interface SessionInfo {
  /** Session name */
  name: string;
  /** Number of windows */
  windows: number;
  /** Whether the session is attached */
  attached: boolean;
  /** Creation time (if available) */
  createdAt?: Date;
}

/**
 * Multiplexer context detection
 */
export type MultiplexerContext = 'tmux' | 'cmux' | 'none';

/**
 * Health check result
 */
export interface TmuxHealthCheck {
  /** Whether tmux is available */
  available: boolean;
  /** Tmux version string */
  version?: string;
  /** Whether currently inside a tmux session */
  inTmux: boolean;
  /** Current session name (if in tmux) */
  currentSession?: string;
  /** Current window name (if in tmux) */
  currentWindow?: string;
  /** Current pane ID (if in tmux) */
  currentPaneId?: string;
}
