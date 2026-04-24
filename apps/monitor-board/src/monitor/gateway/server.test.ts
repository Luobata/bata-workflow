import { describe, expect, it } from 'vitest';
import type { RawData } from 'ws';
import type { BoardEvent } from '@monitor/protocol';
import WebSocket from 'ws';
import { SessionRegistry } from './session-registry';
import { createGatewayServer } from './server';

const waitForOpen = (client: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve());
    client.once('error', (error: Error) => reject(error));
  });

const waitForMessage = (client: WebSocket) =>
  new Promise<string>((resolve, reject) => {
    client.once('message', (data: RawData) => resolve(data.toString()));
    client.once('error', (error: Error) => reject(error));
  });

const closeGatewayServer = (gateway: ReturnType<typeof createGatewayServer>) =>
  new Promise<void>((resolve, reject) => {
    gateway.server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

const createEvent = (monitorSessionId: string): BoardEvent => ({
  id: 'session.started:lead-1:1',
  eventType: 'session.started',
  sessionId: 'session-1',
  rootSessionId: 'session-1',
  monitorSessionId,
  actorId: 'lead-1',
  parentActorId: null,
  actorType: 'lead',
  action: 'bootstrap',
  status: 'active',
  timestamp: '2026-04-18T10:00:00.000Z',
  sequence: 1,
  model: 'gpt-5.4',
  toolName: null,
  tokenIn: 5,
  tokenOut: 8,
  elapsedMs: 12,
  costEstimate: 0.01,
  summary: 'session started',
  metadata: {},
  tags: ['monitor'],
  severity: 'info',
  monitorEnabled: true,
  monitorInherited: false,
  monitorOwnerActorId: 'lead-1',
});

describe('SessionRegistry', () => {
  it('reuses the same monitor session for the same root session', () => {
    const registry = new SessionRegistry();

    expect(registry.ensureMonitorSession('session-1')).toBe('monitor:session-1');
    expect(registry.ensureMonitorSession('session-1')).toBe('monitor:session-1');
  });

  it('appends an event and returns the derived board snapshot', () => {
    const registry = new SessionRegistry();
    const monitorSessionId = registry.ensureMonitorSession('session-1');

    const snapshot = registry.append(createEvent(monitorSessionId));

    expect(snapshot.monitorSessionId).toBe('monitor:session-1');
    expect(snapshot.actorCount).toBe(1);
    expect(snapshot.timelineCount).toBe(1);
    expect(snapshot.stats.actorCount).toBe(1);
    expect(Array.isArray(snapshot.state.actors)).toBe(true);
    expect(snapshot.state.actors).toHaveLength(1);
    expect(snapshot.state.actors[0]).toMatchObject({
      id: 'lead-1',
      actorType: 'lead',
      status: 'active',
    });
    expect(snapshot.state.timeline).toHaveLength(1);
  });
});

describe('createGatewayServer', () => {
  it('publishes a serializable snapshot with actor data to connected websocket clients', async () => {
    const gateway = createGatewayServer(0);
    const address = gateway.server.address();

    if (!address || typeof address === 'string') {
      throw new Error('expected websocket server to expose an ephemeral port');
    }

    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);

    await waitForOpen(client);

    const payloadPromise = waitForMessage(client);

    const monitorSessionId = gateway.registry.ensureMonitorSession('session-1');
    const snapshot = gateway.publish(createEvent(monitorSessionId));
    const payload = JSON.parse(await payloadPromise) as {
      monitorSessionId: string;
      timelineCount: number;
      state: {
        actors: Array<{ id: string; actorType: string; status: string }>;
      };
    };

    expect(payload.monitorSessionId).toBe(snapshot.monitorSessionId);
    expect(payload.timelineCount).toBe(1);
    expect(payload.state.actors).toEqual([
      expect.objectContaining({
        id: 'lead-1',
        actorType: 'lead',
        status: 'active',
      }),
    ]);

    client.close();
    await closeGatewayServer(gateway);
  });

  it('bootstraps a new websocket client with existing snapshots on connect', async () => {
    const gateway = createGatewayServer(0);
    const monitorSessionId = gateway.registry.ensureMonitorSession('session-1');
    const existingSnapshot = gateway.publish(createEvent(monitorSessionId));
    const address = gateway.server.address();

    if (!address || typeof address === 'string') {
      throw new Error('expected websocket server to expose an ephemeral port');
    }

    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const payloadPromise = waitForMessage(client);

    await waitForOpen(client);

    const payload = JSON.parse(await payloadPromise) as {
      monitorSessionId: string;
      actorCount: number;
      timelineCount: number;
      state: {
        actors: Array<{ id: string }>;
      };
    };

    expect(payload.monitorSessionId).toBe(existingSnapshot.monitorSessionId);
    expect(payload.actorCount).toBe(1);
    expect(payload.timelineCount).toBe(1);
    expect(payload.state.actors).toEqual([expect.objectContaining({ id: 'lead-1' })]);

    client.close();
    await closeGatewayServer(gateway);
  });

  it('bootstraps websocket clients with snapshots injected from harness state polling', async () => {
    const gateway = createGatewayServer(0);
    const address = gateway.server.address();

    if (!address || typeof address === 'string') {
      throw new Error('expected websocket server to expose an ephemeral port');
    }

    gateway.replaceSnapshots([
      {
        monitorSessionId: 'monitor:workspace-1',
        stats: {
          actorCount: 2,
          activeCount: 1,
          blockedCount: 0,
          totalTokens: 0,
          elapsedMs: 4200,
        },
        actorCount: 2,
        timelineCount: 1,
        state: {
          actors: [
            {
              id: 'lead:workspace-1',
              parentActorId: null,
              actorType: 'lead',
              status: 'active',
              summary: 'goal',
              model: null,
              toolName: null,
              totalTokens: 0,
              elapsedMs: 4200,
              children: ['T1'],
              lastEventAt: '2026-04-18T10:00:00.000Z',
              lastEventSequence: 1,
            },
            {
              id: 'T1',
              parentActorId: 'lead:workspace-1',
              actorType: 'subagent',
              status: 'active',
              summary: 'Implement live bridge',
              model: 'gpt-5.4',
              toolName: null,
              totalTokens: 0,
              elapsedMs: 2100,
              children: [],
              lastEventAt: '2026-04-18T10:00:00.000Z',
              lastEventSequence: 1,
            },
          ],
          timeline: [createEvent('monitor:workspace-1')],
        },
      },
    ]);

    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const payloadPromise = waitForMessage(client);

    await waitForOpen(client);

    const payload = JSON.parse(await payloadPromise) as {
      monitorSessionId: string;
      actorCount: number;
      state: {
        actors: Array<{ id: string }>;
      };
    };

    expect(payload.monitorSessionId).toBe('monitor:workspace-1');
    expect(payload.actorCount).toBe(2);
    expect(payload.state.actors).toEqual([
      expect.objectContaining({ id: 'lead:workspace-1' }),
      expect.objectContaining({ id: 'T1' }),
    ]);

    client.close();
    await closeGatewayServer(gateway);
  });
});
