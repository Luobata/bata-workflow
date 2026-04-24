import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '@monitor/monitor-gateway';
import { App, resolveAppBootstrapFromLocation } from '../App';
import { useBoardStore } from '../store/useBoardStore';

const createSessionSnapshot = (monitorSessionId = 'monitor:gateway-demo'): SessionSnapshot => ({
  monitorSessionId,
  stats: {
    actorCount: 3,
    activeCount: 2,
    blockedCount: 1,
    totalTokens: 1280,
    elapsedMs: 734000,
  },
  actorCount: 3,
  timelineCount: 4,
  state: {
    actors: [
      {
        id: 'lead-1',
        parentActorId: null,
        actorType: 'lead',
        status: 'active',
        summary: 'Lead synced gateway contract',
        model: 'gpt-5.4',
        toolName: 'planning',
        totalTokens: 640,
        elapsedMs: 734000,
        children: ['subagent-1'],
        lastEventAt: '2026-04-18T12:05:00.000Z',
        lastEventSequence: 4,
      },
      {
        id: 'subagent-1',
        parentActorId: 'lead-1',
        actorType: 'subagent',
        status: 'blocked',
        summary: 'UI adapted to gateway snapshot',
        model: 'gpt-5.4-mini',
        toolName: 'apply_patch',
        totalTokens: 420,
        elapsedMs: 511000,
        children: ['worker-1'],
        lastEventAt: '2026-04-18T12:03:00.000Z',
        lastEventSequence: 3,
      },
      {
        id: 'worker-1',
        parentActorId: 'subagent-1',
        actorType: 'worker',
        status: 'idle',
        summary: 'Timeline waiting for focused actor filter',
        model: 'gpt-5.4-nano',
        toolName: 'vitest',
        totalTokens: 220,
        elapsedMs: 260000,
        children: [],
        lastEventAt: '2026-04-18T12:08:00.000Z',
        lastEventSequence: 5,
      },
    ],
    timeline: [
      {
        id: 'evt-1',
        sessionId: 'session-1',
        rootSessionId: 'session-1',
        monitorSessionId,
        actorId: 'lead-1',
        parentActorId: null,
        actorType: 'lead',
        eventType: 'session.started',
        action: 'opened Task 8 board shell',
        status: 'active',
        timestamp: '2026-04-18T12:01:00.000Z',
        sequence: 1,
        model: 'gpt-5.4',
        toolName: null,
        tokenIn: 0,
        tokenOut: 0,
        elapsedMs: 1000,
        costEstimate: 0,
        summary: 'Lead opened Task 8 board shell',
        metadata: {
          displayName: 'Lead Agent',
          currentAction: 'Aligning the board view-model pipeline',
          timelineLabel: 'opened Task 8 board shell',
        },
        tags: [],
        severity: 'info',
        monitorEnabled: true,
        monitorInherited: false,
        monitorOwnerActorId: 'lead-1',
      },
      {
        id: 'evt-2',
        sessionId: 'session-1',
        rootSessionId: 'session-1',
        monitorSessionId,
        actorId: 'subagent-1',
        parentActorId: 'lead-1',
        actorType: 'subagent',
        eventType: 'action.summary',
        action: 'Wiring summary and metadata variants',
        status: 'blocked',
        timestamp: '2026-04-18T12:03:00.000Z',
        sequence: 2,
        model: 'gpt-5.4-mini',
        toolName: 'apply_patch',
        tokenIn: 0,
        tokenOut: 0,
        elapsedMs: 3000,
        costEstimate: 0,
        summary: 'UI worker wired summary and metadata panels',
        metadata: {
          displayName: 'UI Worker',
          currentAction: 'Wiring summary and metadata variants',
          timelineLabel: 'wired summary and metadata panels',
        },
        tags: [],
        severity: 'info',
        monitorEnabled: true,
        monitorInherited: true,
        monitorOwnerActorId: 'lead-1',
      },
      {
        id: 'evt-3',
        sessionId: 'session-1',
        rootSessionId: 'session-1',
        monitorSessionId,
        actorId: 'lead-1',
        parentActorId: null,
        actorType: 'lead',
        eventType: 'action.summary',
        action: 'Synced focus hand-off',
        status: 'active',
        timestamp: '2026-04-18T12:05:00.000Z',
        sequence: 3,
        model: 'gpt-5.4',
        toolName: 'planning',
        tokenIn: 0,
        tokenOut: 0,
        elapsedMs: 5000,
        costEstimate: 0,
        summary: 'Lead synced focus hand-off',
        metadata: {
          displayName: 'Lead Agent',
          currentAction: 'Aligning the board view-model pipeline',
          timelineLabel: 'synced focus hand-off',
        },
        tags: [],
        severity: 'info',
        monitorEnabled: true,
        monitorInherited: false,
        monitorOwnerActorId: 'lead-1',
      },
      {
        id: 'evt-4',
        sessionId: 'session-1',
        rootSessionId: 'session-1',
        monitorSessionId,
        actorId: 'worker-1',
        parentActorId: 'subagent-1',
        actorType: 'worker',
        eventType: 'action.summary',
        action: 'Waiting for next actor filter update',
        status: 'idle',
        timestamp: '2026-04-18T12:08:00.000Z',
        sequence: 4,
        model: 'gpt-5.4-nano',
        toolName: 'vitest',
        tokenIn: 0,
        tokenOut: 0,
        elapsedMs: 8000,
        costEstimate: 0,
        summary: 'Timeline worker mounted virtual rows',
        metadata: {
          displayName: 'Timeline Worker',
          currentAction: 'Waiting for next actor filter update',
          timelineLabel: 'mounted virtual rows',
        },
        tags: [],
        severity: 'info',
        monitorEnabled: true,
        monitorInherited: true,
        monitorOwnerActorId: 'lead-1',
      },
    ],
  },
});

const createShellSnapshot = (monitorSessionId = 'monitor:shell-live'): SessionSnapshot => ({
  monitorSessionId,
  stats: {
    actorCount: 1,
    activeCount: 1,
    blockedCount: 0,
    totalTokens: 0,
    elapsedMs: 0,
  },
  actorCount: 1,
  timelineCount: 1,
  state: {
    actors: [
      {
        id: 'lead:shell-live',
        parentActorId: null,
        actorType: 'lead',
        status: 'active',
        summary: 'live shell awaiting runtime data',
        model: null,
        toolName: null,
        totalTokens: 0,
        elapsedMs: 0,
        children: [],
        lastEventAt: '2026-04-22T13:02:07.283Z',
        lastEventSequence: 1,
      },
    ],
    timeline: [
      {
        id: 'runtime:shell:workspace-shell-live',
        sessionId: 'workspace-shell-live',
        rootSessionId: 'workspace-shell-live',
        monitorSessionId,
        actorId: 'lead:shell-live',
        parentActorId: null,
        actorType: 'lead',
        eventType: 'session.started',
        action: 'awaiting runtime data',
        status: 'active',
        timestamp: '2026-04-22T13:02:07.283Z',
        sequence: 1,
        model: null,
        toolName: null,
        tokenIn: 0,
        tokenOut: 0,
        elapsedMs: 0,
        costEstimate: 0,
        summary: 'awaiting runtime data',
        metadata: {
          displayName: 'Lead Agent',
          currentAction: 'awaiting runtime data',
          timelineLabel: 'awaiting runtime data',
        },
        tags: ['harness-runtime', 'session-shell'],
        severity: 'info',
        monitorEnabled: true,
        monitorInherited: false,
        monitorOwnerActorId: 'lead:shell-live',
      },
    ],
  },
});

const createDisconnectedShellSnapshot = (monitorSessionId = 'monitor:shell-live'): SessionSnapshot => {
  const shellSnapshot = createShellSnapshot(monitorSessionId);

  return {
    ...shellSnapshot,
    stats: {
      ...shellSnapshot.stats,
      activeCount: 0,
    },
    state: {
      ...shellSnapshot.state,
      actors: shellSnapshot.state.actors.map((actor) => ({
        ...actor,
        status: 'disconnected',
        summary: 'live session disconnected',
      })),
      timeline: shellSnapshot.state.timeline.map((event) => ({
        ...event,
        eventType: 'session.updated',
        status: 'disconnected',
        action: 'live session disconnected',
        summary: 'live session disconnected',
        tags: [...event.tags, 'session-disconnected'],
        metadata: {
          ...event.metadata,
          currentAction: 'live session disconnected',
          timelineLabel: 'live session disconnected',
        },
      })),
    },
  };
};

const createModelResponseSnapshot = (monitorSessionId = 'monitor:model-response'): SessionSnapshot => ({
  monitorSessionId,
  stats: {
    actorCount: 1,
    activeCount: 1,
    blockedCount: 0,
    totalTokens: 366,
    elapsedMs: 4200,
  },
  actorCount: 1,
  timelineCount: 1,
  state: {
    actors: [
      {
        id: 'lead:model-response',
        parentActorId: null,
        actorType: 'lead',
        status: 'active',
        summary: 'Completed response · 321 in · 45 out',
        model: 'gpt-5.4',
        toolName: null,
        totalTokens: 366,
        elapsedMs: 4200,
        children: [],
        lastEventAt: '2026-04-23T10:00:04.200Z',
        lastEventSequence: 1,
      },
    ],
    timeline: [
      {
        id: 'evt-model-1',
        sessionId: 'coco-live-model',
        rootSessionId: 'coco-live-model',
        monitorSessionId,
        actorId: 'lead:model-response',
        parentActorId: null,
        actorType: 'lead',
        eventType: 'action.summary',
        action: 'responding with gpt-5.4',
        status: 'active',
        timestamp: '2026-04-23T10:00:04.200Z',
        sequence: 1,
        model: 'gpt-5.4',
        toolName: null,
        tokenIn: 321,
        tokenOut: 45,
        elapsedMs: 4200,
        costEstimate: 0,
        summary: 'TraeCli completed response · 321 in · 45 out',
        metadata: {
          displayName: 'TraeCli',
          currentAction: 'Completed response',
          timelineLabel: 'model gpt-5.4',
          timelineSummary: 'completed response · 321 in · 45 out',
        },
        tags: ['coco-live', 'model-call'],
        severity: 'info',
        monitorEnabled: true,
        monitorInherited: false,
        monitorOwnerActorId: 'lead:model-response',
      },
    ],
  },
});

describe('App', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    useBoardStore.setState({
      mode: 'summary',
      activePanelTab: 'timeline',
      selectedActorId: null,
    });
  });

  it('renders the board from a gateway SessionSnapshot source', () => {
    render(<App initialSnapshot={createSessionSnapshot()} connectSocket={() => { throw new Error('offline'); }} />);

    expect(screen.getByText('monitor:gateway-demo')).toBeInTheDocument();
    expect(screen.getAllByText('Lead synced gateway contract').length).toBeGreaterThan(0);
    expect(screen.getByText('TOKENS')).toBeInTheDocument();
    expect(screen.queryByText('Task 8 Board')).not.toBeInTheDocument();
  });

  it('switches to metadata mode using the adapted SessionSnapshot view-model', () => {
    render(<App initialSnapshot={createSessionSnapshot()} connectSocket={() => { throw new Error('offline'); }} />);

    expect(screen.getAllByText('Lead synced gateway contract').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Metadata' }));

    expect(screen.getByText('Mode: metadata')).toBeInTheDocument();
    expect(screen.getByText('Model gpt-5.4')).toBeInTheDocument();
    expect(screen.getByText('Status active · Tool planning')).toBeInTheDocument();
    expect(screen.queryByText('Lead synced gateway contract')).not.toBeInTheDocument();
  });

  it('keeps Lead Agent focused and links focus state across timeline and run tree', () => {
    render(<App initialSnapshot={createSessionSnapshot()} connectSocket={() => { throw new Error('offline'); }} />);

    const activeTarget = screen.getByRole('group', { name: 'Active quest target' });
    const timelineFocusLock = screen.getByRole('status', { name: 'Timeline focus lock' });

    expect(screen.getByText('Focus: Lead Agent')).toBeInTheDocument();
    expect(within(activeTarget).getByText('Lead Agent')).toBeInTheDocument();
    expect(within(timelineFocusLock).getByText('LOG LOCK · LEAD AGENT')).toBeInTheDocument();
    expect(screen.getByText('opened Task 8 board shell')).toBeInTheDocument();
    expect(screen.getByText('synced focus hand-off')).toBeInTheDocument();
    expect(screen.queryByText('wired summary and metadata panels')).not.toBeInTheDocument();
    expect(screen.queryByText('mounted virtual rows')).not.toBeInTheDocument();

    expect(screen.queryByRole('tree', { name: 'Run tree' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Run Tree' }));

    expect(screen.getByRole('treeitem', { name: /Lead Agent/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('updates the active quest target HUD and timeline lock when focus changes', () => {
    render(<App initialSnapshot={createSessionSnapshot()} connectSocket={() => { throw new Error('offline'); }} />);

    fireEvent.click(screen.getByRole('button', { name: 'UI Worker' }));

    const activeTarget = screen.getByRole('group', { name: 'Active quest target' });
    const timelineFocusLock = screen.getByRole('status', { name: 'Timeline focus lock' });

    expect(screen.getByText('Focus: UI Worker')).toBeInTheDocument();
    expect(within(activeTarget).getByText('UI Worker')).toBeInTheDocument();
    expect(within(activeTarget).getByText('Wiring summary and metadata variants')).toBeInTheDocument();
    expect(within(timelineFocusLock).getByText('LOG LOCK · UI WORKER')).toBeInTheDocument();
    expect(within(timelineFocusLock).getByText('Subagent · BLOCKED · WRAPPING · 78%')).toBeInTheDocument();
    expect(screen.getByText('wired summary and metadata panels')).toBeInTheDocument();
    expect(screen.queryByText('opened Task 8 board shell')).not.toBeInTheDocument();
  });

  it('switches the operations deck between timeline and run tree tabs', () => {
    render(<App initialSnapshot={createSessionSnapshot()} connectSocket={() => { throw new Error('offline'); }} />);

    expect(screen.getByRole('button', { name: 'Timeline' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run Tree' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'TIMELINE' })).toBeInTheDocument();
    expect(screen.queryByRole('tree', { name: 'Run tree' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Run Tree' }));

    expect(screen.getByRole('tree', { name: 'Run tree' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'TIMELINE' })).not.toBeInTheDocument();
  });

  it('shows estimated overall and per-agent progress across the board', () => {
    render(<App initialSnapshot={createSessionSnapshot()} connectSocket={() => { throw new Error('offline'); }} />);

    expect(screen.getByText('Quest 73%')).toBeInTheDocument();
    expect(screen.getByText('Progress 100%')).toBeInTheDocument();
    expect(screen.getByText('Progress 78%')).toBeInTheDocument();
    expect(screen.getByText('Progress 41%')).toBeInTheDocument();
  });

  it('switches to a progress board tab with quest stage and per-agent stages', () => {
    render(<App initialSnapshot={createSessionSnapshot()} connectSocket={() => { throw new Error('offline'); }} />);

    expect(screen.getByRole('button', { name: 'Progress Board' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Progress Board' }));

    expect(screen.getByRole('heading', { name: 'PROGRESS BOARD' })).toBeInTheDocument();
    expect(screen.getByText('Quest Stage')).toBeInTheDocument();
    expect(screen.getAllByText('Execution').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Completed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Wrapping').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Scouting').length).toBeGreaterThan(0);
  });

  it('shows a neutral waiting shell instead of demo data when no explicit seed or live target is available and the gateway socket cannot connect', () => {
    render(<App connectSocket={() => { throw new Error('offline'); }} />);

    expect(screen.getByText('monitor:pending')).toBeInTheDocument();
    expect(screen.getAllByText('awaiting runtime data').length).toBeGreaterThan(0);
    expect(screen.queryByText('Task 8 Board')).not.toBeInTheDocument();
    expect(screen.queryByText('Coordinating panel focus state')).not.toBeInTheDocument();
  });

  it('renders a live shell instead of mock data when the URL targets a monitor session and the socket is offline', () => {
    render(<App targetMonitorSessionId="monitor:url-live" connectSocket={() => { throw new Error('offline'); }} />);

    expect(screen.getByText('monitor:url-live')).toBeInTheDocument();
    expect(screen.getByText('Quest 0%')).toBeInTheDocument();
    expect(screen.queryByText('Task 8 Board')).not.toBeInTheDocument();
    expect(screen.queryByText('Coordinating panel focus state')).not.toBeInTheDocument();
  });

  it('ignores websocket snapshots for other monitor sessions when a live target is locked', async () => {
    render(
      <App
        targetMonitorSessionId="monitor:target-live"
        connectSocket={(_url, onMessage) => {
          onMessage(createSessionSnapshot('monitor:other-live'));
          return {
            close: () => undefined,
          } as WebSocket;
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('monitor:target-live')).toBeInTheDocument();
    });

    expect(screen.queryByText('monitor:other-live')).not.toBeInTheDocument();
    expect(screen.queryByText('Lead synced gateway contract')).not.toBeInTheDocument();
  });

  it('starts from a fresh shell when a live target is locked even if an initial snapshot belongs to another monitor session', async () => {
    render(
      <App
        initialSnapshot={createSessionSnapshot('monitor:other-live')}
        targetMonitorSessionId="monitor:target-live"
        connectSocket={() => {
          throw new Error('offline');
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('monitor:target-live')).toBeInTheDocument();
    });

    expect(screen.getByText('Quest 0%')).toBeInTheDocument();
    expect(screen.queryByText('monitor:other-live')).not.toBeInTheDocument();
    expect(screen.queryByText('Lead synced gateway contract')).not.toBeInTheDocument();
  });

  it('applies live SessionSnapshot updates received from the gateway socket', async () => {
    const liveSnapshot = createSessionSnapshot('monitor:gateway-live');

    render(
      <App
        targetMonitorSessionId="monitor:gateway-live"
        connectSocket={(_url, onMessage) => {
          onMessage(liveSnapshot);
          return {
            close: () => undefined,
          } as WebSocket;
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('monitor:gateway-live')).toBeInTheDocument();
    });
  });

  it('prefers useful timeline summaries over model-name labels for model response events', () => {
    render(<App initialSnapshot={createModelResponseSnapshot()} connectSocket={() => { throw new Error('offline'); }} />);

    expect(screen.getByText('completed response · 321 in · 45 out')).toBeInTheDocument();
    expect(screen.queryByText('model gpt-5.4')).not.toBeInTheDocument();
  });

  it('renders a shell live snapshot as waiting state instead of quest progress mock-like HUD', async () => {
    const shellSnapshot = createShellSnapshot('monitor:shell-live');

    render(
      <App
        targetMonitorSessionId="monitor:shell-live"
        connectSocket={(_url, onMessage) => {
          onMessage(shellSnapshot);
          return {
            close: () => undefined,
          } as WebSocket;
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('monitor:shell-live')).toBeInTheDocument();
    });

    expect(screen.getAllByText('Quest 0%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Syncing').length).toBeGreaterThan(0);
    expect(screen.getAllByText('awaiting runtime data').length).toBeGreaterThan(0);
    expect(screen.queryByText('Quest 64%')).not.toBeInTheDocument();
  });

  it('preserves the last live frame and marks the board disconnected when the current session disconnects', async () => {
    const liveSnapshot = createSessionSnapshot('monitor:gateway-live');
    const disconnectedSnapshot = createDisconnectedShellSnapshot('monitor:gateway-live');

    render(
      <App
        targetMonitorSessionId="monitor:gateway-live"
        connectSocket={(_url, onMessage) => {
          onMessage(liveSnapshot);
          onMessage(disconnectedSnapshot);
          return {
            close: () => undefined,
          } as WebSocket;
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByText('Lead synced gateway contract').length).toBeGreaterThan(0);
    });

    expect(screen.getAllByText('Lead synced gateway contract').length).toBeGreaterThan(0);
    expect(screen.getAllByText('disconnected').length).toBeGreaterThan(0);
    expect(screen.queryByText('Syncing')).not.toBeInTheDocument();
    expect(screen.queryByText('awaiting runtime data')).not.toBeInTheDocument();
  });

  it('keeps the preserved disconnected live frame when repeated disconnected shell updates arrive', async () => {
    const liveSnapshot = createSessionSnapshot('monitor:gateway-live');
    const disconnectedSnapshot = createDisconnectedShellSnapshot('monitor:gateway-live');

    render(
      <App
        targetMonitorSessionId="monitor:gateway-live"
        connectSocket={(_url, onMessage) => {
          onMessage(liveSnapshot);
          onMessage(disconnectedSnapshot);
          onMessage(disconnectedSnapshot);
          return {
            close: () => undefined,
          } as WebSocket;
        }}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByText('Lead synced gateway contract').length).toBeGreaterThan(0);
    });

    expect(screen.getAllByText('Lead synced gateway contract').length).toBeGreaterThan(0);
    expect(screen.getAllByText('disconnected').length).toBeGreaterThan(0);
    expect(screen.queryByText('awaiting runtime data')).not.toBeInTheDocument();
  });

  it('avoids duplicate websocket probes under React StrictMode in live mode', async () => {
    vi.useFakeTimers();

    const close = vi.fn();
    const connectSocket = vi.fn().mockReturnValue({ close } as unknown as WebSocket);

    const view = render(
      <React.StrictMode>
        <App targetMonitorSessionId="monitor:strict-live" connectSocket={connectSocket} />
      </React.StrictMode>,
    );

    expect(connectSocket).toHaveBeenCalledTimes(0);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(connectSocket).toHaveBeenCalledTimes(1);

    view.unmount();

    expect(close).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('separates live monitor bootstrap URLs from explicit demo seed URLs', () => {
    expect(resolveAppBootstrapFromLocation('?monitorSessionId=monitor%3Alive-root&socketUrl=ws%3A%2F%2F127.0.0.1%3A8791')).toEqual({
      targetMonitorSessionId: 'monitor:live-root',
      socketUrl: 'ws://127.0.0.1:8791',
    });

    const demoBootstrap = resolveAppBootstrapFromLocation('?seed=pixel-demo');
    expect(demoBootstrap.targetMonitorSessionId).toBeUndefined();
    expect(demoBootstrap.initialSnapshot?.monitorSessionId).toBe('pixel-demo');
  });

  it('loads dedicated pixel fonts in index.html for the board shell', () => {
    const html = readFileSync(resolve(import.meta.dirname, '../../index.html'), 'utf8');

    expect(html).toContain('fonts.googleapis.com');
    expect(html).toContain('Press+Start+2P');
    expect(html).toContain('Tiny5');
  });
});
