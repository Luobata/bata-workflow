import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';

import { buildHarnessSnapshots, createGatewayServer } from './src/monitor/gateway';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const stateRoot = process.env.HARNESS_STATE_ROOT
  ? resolve(process.env.HARNESS_STATE_ROOT)
  : process.env.MONITOR_STATE_ROOT
    ? resolve(process.env.MONITOR_STATE_ROOT)
    : resolve(repoRoot, '.harness', 'state');
const gatewayPort = Number.parseInt(process.env.MONITOR_GATEWAY_PORT ?? '8787', 10);

const createHarnessGatewayPlugin = (): Plugin => ({
  name: 'monitor-board-harness-gateway',
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

    const syncSnapshots = async () => {
      if (disposed || syncing) {
        return;
      }

      syncing = true;

      try {
        gateway.replaceSnapshots(await buildHarnessSnapshots(stateRoot));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        server.config.logger.warn(`[monitor-board] failed to sync live harness snapshots: ${message}`);
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
