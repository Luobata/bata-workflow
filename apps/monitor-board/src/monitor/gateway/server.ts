import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import type { BoardEvent } from '../protocol';
import { SessionRegistry, type SessionSnapshot } from './session-registry';

interface GatewayClient {
  readyState: number;
  send(payload: string): void;
}

interface GatewayWebSocketServer {
  clients: Set<GatewayClient>;
  address(): AddressInfo | string | null;
  close(callback: (error?: Error) => void): void;
  on(event: 'connection', listener: (client: GatewayClient) => void): void;
}

type WebSocketServerConstructor = new (options: { port: number }) => GatewayWebSocketServer;

const require = createRequire(import.meta.url);
const wsModule = require('ws') as {
  WebSocket: { OPEN: number };
  WebSocketServer: WebSocketServerConstructor;
};

export const createGatewayServer = (port = 8787) => {
  const registry = new SessionRegistry();
  const server = new wsModule.WebSocketServer({ port });
  const snapshots = new Map<string, SessionSnapshot>();
  const payloadByMonitorSessionId = new Map<string, string>();

  const sendSnapshot = (client: GatewayClient, payload: string) => {
    if (client.readyState === wsModule.WebSocket.OPEN) {
      client.send(payload);
    }
  };

  const broadcastPayload = (payload: string) => {
    server.clients.forEach((client) => {
      sendSnapshot(client, payload);
    });
  };

  const publishSnapshot = (snapshot: SessionSnapshot) => {
    const payload = JSON.stringify(snapshot);
    const previousPayload = payloadByMonitorSessionId.get(snapshot.monitorSessionId);

    snapshots.set(snapshot.monitorSessionId, snapshot);
    payloadByMonitorSessionId.set(snapshot.monitorSessionId, payload);

    if (previousPayload !== payload) {
      broadcastPayload(payload);
    }

    return snapshot;
  };

  server.on('connection', (client) => {
    snapshots.forEach((snapshot) => {
      sendSnapshot(client, JSON.stringify(snapshot));
    });
  });

  const publish = (event: BoardEvent) => {
    return publishSnapshot(registry.append(event));
  };

  const replaceSnapshots = (nextSnapshots: SessionSnapshot[]) => {
    const nextMonitorSessionIds = new Set(nextSnapshots.map((snapshot) => snapshot.monitorSessionId));

    [...snapshots.keys()].forEach((monitorSessionId) => {
      if (!nextMonitorSessionIds.has(monitorSessionId)) {
        snapshots.delete(monitorSessionId);
        payloadByMonitorSessionId.delete(monitorSessionId);
      }
    });

    nextSnapshots.forEach((snapshot) => {
      publishSnapshot(snapshot);
    });

    return [...snapshots.values()];
  };

  return {
    server,
    registry,
    publish,
    publishSnapshot,
    replaceSnapshots,
    listSnapshots: () => [...snapshots.values()],
  };
};
