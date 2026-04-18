import type { RuntimeControlCommand } from '../runtime/control-channel.js'
import type { WatchPane } from './watch.js'

export type WatchCommandContext = {
  focusedPane: WatchPane
  runDirectory: string | null
  runStatus: 'RUNNING' | 'FAILED' | 'COMPLETED'
  selectedTask: {
    taskId: string
    status: 'pending' | 'ready' | 'in_progress' | 'completed' | 'failed' | 'blocked'
  } | null
}

export type WatchDispatchedCommand =
  | { kind: 'refresh' }
  | { kind: 'focus-pane'; pane: WatchPane }
  | { kind: 'runtime-control'; command: RuntimeControlCommand }

export type WatchCommandAction = {
  id: string
  label: string
  scope: 'global' | 'selected-task'
  enabled: boolean
  reason?: string
  dispatch: WatchDispatchedCommand | null
}

function buildFocusAction(targetPane: WatchPane): WatchCommandAction {
  return {
    id: `focus-${targetPane}`,
    label: `Focus ${targetPane[0]!.toUpperCase()}${targetPane.slice(1)}`,
    scope: 'global',
    enabled: true,
    dispatch: { kind: 'focus-pane', pane: targetPane }
  }
}

function buildTaskScopedControlAction(params: {
  id: string
  label: string
  context: WatchCommandContext
  commandFactory: (taskId: string) => RuntimeControlCommand
}): WatchCommandAction {
  if (!params.context.selectedTask) {
    return {
      id: params.id,
      label: params.label,
      scope: 'selected-task',
      enabled: false,
      reason: 'No selected task',
      dispatch: null
    }
  }

  if (!params.context.runDirectory || params.context.runStatus !== 'RUNNING') {
    return {
      id: params.id,
      label: params.label,
      scope: 'selected-task',
      enabled: false,
      reason: 'Run is not accepting control commands',
      dispatch: null
    }
  }

  if (params.context.selectedTask.status !== 'failed') {
    return {
      id: params.id,
      label: params.label,
      scope: 'selected-task',
      enabled: false,
      reason: 'Selected task is not failed',
      dispatch: null
    }
  }

  return {
    id: params.id,
    label: params.label,
    scope: 'selected-task',
    enabled: true,
    dispatch: {
      kind: 'runtime-control',
      command: params.commandFactory(params.context.selectedTask.taskId)
    }
  }
}

export function buildWatchCommands(context: WatchCommandContext): WatchCommandAction[] {
  const commands: WatchCommandAction[] = [
    {
      id: 'refresh-view',
      label: 'Refresh view',
      scope: 'global',
      enabled: true,
      dispatch: { kind: 'refresh' }
    },
    buildFocusAction('workers'),
    buildFocusAction('tasks'),
    buildFocusAction('details'),
    buildFocusAction('events'),
    {
      id: 'abort-run',
      label: 'Abort current run',
      scope: 'global',
      enabled: Boolean(context.runDirectory) && context.runStatus === 'RUNNING',
      reason:
        !context.runDirectory
          ? 'No run directory bound'
          : context.runStatus !== 'RUNNING'
            ? 'Run has already settled'
            : undefined,
      dispatch:
        context.runDirectory && context.runStatus === 'RUNNING'
          ? {
              kind: 'runtime-control',
              command: {
                id: 'palette-abort-run',
                type: 'abort-run',
                createdAt: new Date().toISOString()
              }
            }
          : null
    },
    buildTaskScopedControlAction({
      id: 'retry-selected-task',
      label: 'Retry selected task',
      context,
      commandFactory: (taskId) => ({
        id: 'palette-retry-selected-task',
        type: 'retry-task',
        taskId,
        createdAt: new Date().toISOString()
      })
    }),
    ...(['reviewer', 'planner', 'coder'] as const).map((targetRole) => {
      return buildTaskScopedControlAction({
        id: `reroute-selected-task-${targetRole}`,
        label: `Reroute selected task -> ${targetRole}`,
        context,
        commandFactory: (taskId) => ({
          id: `palette-reroute-selected-task-${targetRole}`,
          type: 'reroute-task',
          taskId,
          targetRole,
          createdAt: new Date().toISOString()
        })
      })
    })
  ]

  return commands
}

export function filterWatchCommands(commands: WatchCommandAction[], query: string): WatchCommandAction[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) {
    return commands
  }

  return commands.filter((command) => command.label.toLowerCase().includes(normalizedQuery))
}
