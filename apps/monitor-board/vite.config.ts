import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';

import { buildBataWorkflowSnapshots, createGatewayServer } from './src/monitor/gateway';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const stateRoot = process.env.BATA_WORKFLOW_STATE_ROOT
  ? resolve(process.env.BATA_WORKFLOW_STATE_ROOT)
  : process.env.MONITOR_STATE_ROOT
    ? resolve(process.env.MONITOR_STATE_ROOT)
    : resolve(repoRoot, '.bata-workflow', 'state');
const gatewayPort = Number.parseInt(process.env.MONITOR_GATEWAY_PORT ?? '8787', 10);
const monitorBoardRuntimeStatePath = resolve(stateRoot, 'monitor-board', 'runtime.json');
const monitorBoardLogFilePath = resolve(stateRoot, 'monitor-logs', 'monitor-board.log');
const monitorSyncTimeoutMs = Number.parseInt(process.env.MONITOR_SYNC_TIMEOUT_MS ?? '5000', 10);
const monitorIdleExitGraceMs = Number.parseInt(process.env.MONITOR_IDLE_EXIT_GRACE_MS ?? '1500', 10);

const readTrackedSessionCount = async (): Promise<number | null> => {
  try {
    const runtimeState = JSON.parse(await readFile(monitorBoardRuntimeStatePath, 'utf8')) as {
      activeRootSessionIds?: unknown;
    };

    if (!Array.isArray(runtimeState.activeRootSessionIds)) {
      return 0;
    }

    return [...new Set(runtimeState.activeRootSessionIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))].length;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return 0;
    }

    if (error instanceof SyntaxError) {
      return null;
    }

    return null;
  }
};

const withSyncTimeout = async <T>(promise: Promise<T>): Promise<T> => {
  if (!Number.isInteger(monitorSyncTimeoutMs) || monitorSyncTimeoutMs <= 0) {
    return await promise;
  }

  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      globalThis.setTimeout(() => {
        reject(new Error(`live snapshot sync timed out after ${monitorSyncTimeoutMs}ms`));
      }, monitorSyncTimeoutMs);
    }),
  ]);
};

const writeMonitorBoardLifecycleLog = async (event: string, data: Record<string, unknown> = {}): Promise<void> => {
  const payload = {
    ts: new Date().toISOString(),
    pid: process.pid,
    source: 'monitor-board.vite',
    event,
    data,
  };

  try {
    await mkdir(resolve(monitorBoardLogFilePath, '..'), { recursive: true });
    await appendFile(monitorBoardLogFilePath, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch {
    // Keep logging best-effort.
  }
};

const createHarnessGatewayPlugin = (): Plugin => ({
  name: 'monitor-board-bata-workflow-gateway',
  configureServer(server: ViteDevServer) {
    server.middlewares.use('/__monitor_board_identity', (_request, response) => {
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.end(
        JSON.stringify({
          app: 'monitor-board',
          repoRoot,
          stateRoot,
          gatewayPort,
          pid: process.pid,
        }),
      );
    });

    const gateway = createGatewayServer(Number.isInteger(gatewayPort) && gatewayPort > 0 ? gatewayPort : 8787);
    let disposed = false;
    let syncing = false;
    let shuttingDown = false;
    let hasSeenTrackedSessions = false;
    let latestActiveTrackedSessionAt = Date.now();

    const shutdownIfNoTrackedSession = () => {
      if (disposed || shuttingDown) {
        return;
      }

      shuttingDown = true;
      server.config.logger.info('[monitor-board] no tracked monitor sessions remain; shutting down board process');
      void writeMonitorBoardLifecycleLog('board.shutdown_no_tracked_sessions', {
        latestActiveTrackedSessionAt,
      });
      dispose();
      // Use process.exitCode instead of process.exit(0) to allow the Vite dev
      // server's own shutdown handlers to run, including WebSocket close
      // handshakes and temp file cleanup from atomic writes.
      process.exitCode = 0;
      server.httpServer?.close();
    };

    const syncSnapshots = async () => {
      if (disposed || syncing || shuttingDown) {
        return;
      }

      syncing = true;

      try {
        const snapshots = await withSyncTimeout(buildBataWorkflowSnapshots(stateRoot));
        gateway.replaceSnapshots(snapshots);

        const trackedSessionCount = await readTrackedSessionCount();
        if (trackedSessionCount !== null && trackedSessionCount > 0) {
          hasSeenTrackedSessions = true;
          latestActiveTrackedSessionAt = Date.now();
        }

        if (
          hasSeenTrackedSessions
          && trackedSessionCount === 0
          && Date.now() - latestActiveTrackedSessionAt >= Math.max(0, monitorIdleExitGraceMs)
        ) {
          shutdownIfNoTrackedSession();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        server.config.logger.warn(`[monitor-board] failed to sync live bata-workflow snapshots: ${message}`);
        void writeMonitorBoardLifecycleLog('snapshot.sync_failed', {
          message,
        });
      } finally {
        syncing = false;
      }
    };

    const timer = setInterval(() => {
      void syncSnapshots();
    }, 500);

    void syncSnapshots();

    const dispose = () => {
      if (disposed) {
        return;
      }

      disposed = true;
      clearInterval(timer);
      gateway.server.close(() => undefined);
    };

    server.httpServer?.once('close', dispose);
  },
});

export default defineConfig({
  plugins: [createHarnessGatewayPlugin()],
  resolve: {
    alias: {
      '@monitor/protocol': fileURLToPath(new URL('./src/monitor/protocol/index.ts', import.meta.url)),
      '@monitor/runtime-store': fileURLToPath(new URL('./src/monitor/runtime-store/index.ts', import.meta.url)),
      '@monitor/monitor-gateway': fileURLToPath(new URL('./src/monitor/gateway/index.ts', import.meta.url)),
      '@monitor/monitor-skill': fileURLToPath(new URL('./src/monitor/skill/index.ts', import.meta.url)),
      '@monitor/host-coco-hook': fileURLToPath(new URL('./src/monitor/host-coco/index.ts', import.meta.url)),
      '@monitor/host-claude-code-hook': fileURLToPath(new URL('./src/monitor/host-claude/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 4173,
  },
  test: {
    environment: 'jsdom',
  },
});
