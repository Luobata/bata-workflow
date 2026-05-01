# @luobata/tmux-manager

A standalone tmux pane management library for creating split layouts and managing terminal sessions programmatically.

## Features

- 🎯 **Zero Dependencies** - Only uses Node.js built-in modules
- 🔀 **Split Layouts** - Create horizontal, vertical, or grid layouts
- 📡 **Session Management** - Create, list, and kill tmux sessions
- 🖥️ **Pane Control** - Send commands, capture output, resize panes
- 🔄 **Cross-Platform** - Works on macOS, Linux, and Windows (with MSYS2)
- 📦 **TypeScript First** - Full type definitions included

## Installation

```bash
npm install @luobata/tmux-manager
# or
pnpm add @luobata/tmux-manager
```

## Prerequisites

- [tmux](https://github.com/tmux/tmux) installed on your system
- Node.js 18+

### Installing tmux

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt-get install tmux

# Fedora
sudo dnf install tmux

# Arch
sudo pacman -S tmux
```

## Quick Start

### Create a Split Layout

```typescript
import { createSplitLayout, killSplitLayout } from '@luobata/tmux-manager';

// Create 3 panes: leader on left, workers stacked on right
const result = await createSplitLayout({
  type: 'horizontal',
  panes: [
    { name: 'leader', cwd: '/workspace' },
    { name: 'worker1', cwd: '/workspace', command: 'npm run dev' },
    { name: 'worker2', cwd: '/workspace', command: 'npm test' },
  ],
}, { newWindow: true });

console.log(result);
// {
//   sessionName: 'my-session:1',
//   leaderPaneId: '%0',
//   workerPaneIds: ['%1', '%2'],
//   mode: 'dedicated-window'
// }

// Cleanup when done
await killSplitLayout(result);
```

### Create a Detached Session

```typescript
import { createSession, sendToPane, killSession } from '@luobata/tmux-manager';

const session = await createSession({
  name: 'my-session',
  cwd: '/workspace',
  command: 'htop',
});

console.log(session.paneId); // '%0'

// Send more commands
await sendToPane(session.paneId, 'echo "Hello from tmux-manager"');

// Cleanup
await killSession(session.name);
```

### Send Commands to Panes

```typescript
import { sendToPane, capturePane } from '@luobata/tmux-manager';

// Send a command with Enter
await sendToPane('%1', 'npm test', { enter: true });

// Send with environment variables
await sendToPane('%1', 'node server.js', {
  env: { NODE_ENV: 'production', PORT: '3000' },
  enter: true,
});

// Capture output
const output = await capturePane('%1');
console.log(output);
```

### Check Current Environment

```typescript
import { checkTmuxHealth, isInTmux } from '@luobata/tmux-manager';

// Check if running inside tmux
if (isInTmux()) {
  console.log('Already in tmux, will split current pane');
}

// Full health check
const health = await checkTmuxHealth();
console.log(health);
// {
//   available: true,
//   version: 'tmux 3.4',
//   inTmux: true,
//   currentSession: 'main',
//   currentWindow: '0',
//   currentPaneId: '%12'
// }
```

## API Reference

### Layout Creation

#### `createSplitLayout(layout, options?)`

Create a split layout with multiple panes.

```typescript
const result = await createSplitLayout({
  type: 'horizontal',  // 'horizontal' | 'vertical' | 'grid'
  panes: [
    { name: 'leader', cwd: '/workspace' },
    { name: 'worker1', cwd: '/workspace', command: 'npm run dev' },
  ],
}, {
  newWindow: true,      // Create in new window
  sessionName: 'dev',   // Custom session name
  windowName: 'my-app', // Custom window name
});
```

#### `createSession(options)`

Create a detached tmux session.

```typescript
const session = await createSession({
  name: 'my-session',
  cwd: '/workspace',
  command: 'bash',      // Optional initial command
  width: 200,           // Terminal width
  height: 50,           // Terminal height
});
```

### Pane Control

#### `sendToPane(paneId, input, options?)`

Send input to a pane.

```typescript
await sendToPane('%1', 'echo "Hello"', {
  literal: true,   // Use literal mode
  enter: true,     // Press Enter after
  env: { FOO: 'bar' },  // Environment variables
});
```

#### `capturePane(paneId, options?)`

Capture pane content.

```typescript
const output = await capturePane('%1', {
  scrollback: -100,  // Last 100 lines from history
  escape: false,     // Include escape sequences
});
```

#### `selectPane(paneId)`, `resizePane(paneId, direction, amount?)`

Focus or resize a pane.

```typescript
await selectPane('%1');
await resizePane('%1', 'right', 10);
```

### Session Management

#### `listSessions()`, `listPanes(target?)`

List available sessions and panes.

```typescript
const sessions = await listSessions();  // ['main', 'dev']
const panes = await listPanes('main');  // ['%0', '%1', '%2']
```

#### `killSession(name)`, `killPane(paneId)`, `killPanes(paneIds[])`

Clean up sessions and panes.

```typescript
await killSession('my-session');
await killPane('%1');
await killPanes(['%1', '%2', '%3']);
```

### Health Check

#### `checkTmuxHealth()`

Check tmux availability and current context.

```typescript
const health = await checkTmuxHealth();
if (!health.available) {
  console.error('tmux is not installed');
}
```

## Session Modes

The library automatically selects the appropriate mode based on context:

| Mode | When | Behavior |
|------|------|----------|
| `split-pane` | Inside tmux, no `newWindow` | Split current pane |
| `dedicated-window` | Inside tmux, `newWindow: true` | Create new window |
| `detached-session` | Outside tmux | Create detached session |

## Layout Types

```
horizontal:
┌──────────┬──────────┐
│          │  pane 1  │
│  leader  ├──────────┤
│          │  pane 2  │
└──────────┴──────────┘

vertical:
┌──────────┬──────────┐
│          │          │
│  leader  │  pane 1  │
│          │          │
├──────────┼──────────┤
│  pane 2  │  pane 3  │
└──────────┴──────────┘

grid:
┌──────────┬──────────┐
│  pane 0  │  pane 1  │
├──────────┼──────────┤
│  pane 2  │  pane 3  │
└──────────┴──────────┘
```

## Error Handling

All functions throw descriptive errors on failure:

```typescript
import { validateTmux } from '@luobata/tmux-manager';

try {
  await validateTmux();
} catch (error) {
  console.error(error.message);
  // "tmux is not available. Install it:
  //   macOS: brew install tmux
  //   ..."
}
```

## Integration Examples

### With Node.js Scripts

```typescript
// script.mjs
import { createSplitLayout, sendToPane, capturePane, killSplitLayout } from '@luobata/tmux-manager';

const layout = await createSplitLayout({
  type: 'horizontal',
  panes: [
    { name: 'server', cwd: process.cwd(), command: 'npm start' },
    { name: 'tests', cwd: process.cwd(), command: 'npm test -- --watch' },
  ],
});

// Wait for output
await new Promise(r => setTimeout(r, 5000));
const output = await capturePane(layout.workerPaneIds[0]!);
console.log('Test output:', output);

// Cleanup on exit
process.on('SIGINT', () => killSplitLayout(layout));
```

### With Bata-Workflow

```typescript
// In your bata-workflow project
import { createSplitLayout, type SplitLayoutResult } from '@luobata/tmux-manager';

async function runWithWatchers(tasks: Task[]) {
  const panes = tasks.map(t => ({
    name: t.id,
    cwd: t.cwd,
    command: `claude --task "${t.prompt}"`,
  }));

  return createSplitLayout({
    type: 'vertical',
    panes: [{ name: 'main', cwd: process.cwd() }, ...panes],
  }, { newWindow: true });
}
```

## License

MIT
