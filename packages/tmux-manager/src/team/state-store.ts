/**
 * State storage for team orchestration.
 *
 * @module team/state-store
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync, rmdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task, Worker, TeamConfig, TeamPhase, TeamState, StateStoreOptions } from './types.js';
import { TaskManager } from './task-manager.js';

/**
 * File-based state store for team orchestration.
 */
export class StateStore {
  private readonly stateRoot: string;
  private readonly teamName: string;
  private readonly teamDir: string;
  readonly tasks: TaskManager;

  constructor(options: StateStoreOptions) {
    this.stateRoot = options.stateRoot;
    this.teamName = options.teamName;
    this.teamDir = join(options.stateRoot, 'teams', options.teamName);
    this.tasks = new TaskManager(options.stateRoot, options.teamName);
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!existsSync(this.teamDir)) {
      mkdirSync(this.teamDir, { recursive: true });
    }
  }

  // ── Config ──────────────────────────────────────────────────────────────────

  private configPath(): string {
    return join(this.teamDir, 'config.json');
  }

  async saveConfig(config: TeamConfig): Promise<void> {
    await writeFile(this.configPath(), JSON.stringify(config, null, 2), 'utf-8');
  }

  async loadConfig(): Promise<TeamConfig | null> {
    try {
      const content = await readFile(this.configPath(), 'utf-8');
      return JSON.parse(content) as TeamConfig;
    } catch {
      return null;
    }
  }

  // ── Workers ─────────────────────────────────────────────────────────────────

  private workerDir(): string {
    return join(this.teamDir, 'workers');
  }

  private workerPath(name: string): string {
    return join(this.workerDir(), `${name}.json`);
  }

  async saveWorker(worker: Worker): Promise<void> {
    const dir = this.workerDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    await writeFile(this.workerPath(worker.name), JSON.stringify(worker, null, 2), 'utf-8');
  }

  async loadWorker(name: string): Promise<Worker | null> {
    try {
      const content = await readFile(this.workerPath(name), 'utf-8');
      return JSON.parse(content) as Worker;
    } catch {
      return null;
    }
  }

  async listWorkers(): Promise<Worker[]> {
    const dir = this.workerDir();
    if (!existsSync(dir)) return [];

    const files = readdirSync(dir).filter(f => f.endsWith('.json'));
    const workers = await Promise.all(
      files.map(f => this.loadWorker(f.slice(0, -5)))
    );
    return workers.filter((w): w is Worker => w !== null);
  }

  async updateWorkerStatus(name: string, status: Worker['status'], currentTaskId?: string): Promise<Worker | null> {
    const worker = await this.loadWorker(name);
    if (!worker) return null;

    const updated: Worker = {
      ...worker,
      status,
      currentTaskId,
      lastHeartbeat: new Date().toISOString(),
    };

    // Update task stats
    if (status === 'done') {
      updated.taskStats.completed += 1;
      updated.taskStats.inProgress = Math.max(0, updated.taskStats.inProgress - 1);
    } else if (status === 'failed') {
      updated.taskStats.failed += 1;
      updated.taskStats.inProgress = Math.max(0, updated.taskStats.inProgress - 1);
    } else if (status === 'working') {
      updated.taskStats.inProgress += 1;
    }

    await this.saveWorker(updated);
    return updated;
  }

  async deleteWorker(name: string): Promise<boolean> {
    try {
      unlinkSync(this.workerPath(name));
      return true;
    } catch {
      return false;
    }
  }

  // ── Phase ───────────────────────────────────────────────────────────────────

  private phasePath(): string {
    return join(this.teamDir, 'phase.json');
  }

  async savePhase(phase: TeamPhase): Promise<void> {
    await writeFile(this.phasePath(), JSON.stringify({ phase, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
  }

  async loadPhase(): Promise<TeamPhase> {
    try {
      const content = await readFile(this.phasePath(), 'utf-8');
      const data = JSON.parse(content);
      return data.phase as TeamPhase;
    } catch {
      return 'initializing';
    }
  }

  // ── Full State ──────────────────────────────────────────────────────────────

  async loadState(): Promise<TeamState | null> {
    const [config, tasks, workers, phase] = await Promise.all([
      this.loadConfig(),
      this.tasks.list(),
      this.listWorkers(),
      this.loadPhase(),
    ]);

    if (!config) return null;

    return {
      config,
      tasks,
      workers,
      phase,
      updatedAt: new Date().toISOString(),
    };
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────────

  async cleanup(): Promise<void> {
    // Delete all task files
    const taskIds = await this.tasks.listIds();
    for (const id of taskIds) {
      await this.tasks.delete(id);
    }

    // Delete worker files
    const workers = await this.listWorkers();
    for (const w of workers) {
      await this.deleteWorker(w.name);
    }

    // Delete team directory
    try {
      rmdirSync(this.teamDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }

  // ── Heartbeat ───────────────────────────────────────────────────────────────

  private heartbeatPath(name: string): string {
    return join(this.workerDir(), `${name}.heartbeat.json`);
  }

  async saveHeartbeat(name: string, data: { status: string; currentTaskId?: string }): Promise<void> {
    const dir = this.workerDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    await writeFile(
      this.heartbeatPath(name),
      JSON.stringify({ ...data, timestamp: new Date().toISOString() }, null, 2),
      'utf-8'
    );
  }

  async loadHeartbeat(name: string): Promise<{ status: string; currentTaskId?: string; timestamp: string } | null> {
    try {
      const content = await readFile(this.heartbeatPath(name), 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  isWorkerAlive(name: string, maxAgeMs: number = 30000): boolean {
    try {
      const content = require('fs').readFileSync(this.heartbeatPath(name), 'utf-8');
      const data = JSON.parse(content);
      const timestamp = new Date(data.timestamp).getTime();
      return Date.now() - timestamp < maxAgeMs;
    } catch {
      return false;
    }
  }
}
