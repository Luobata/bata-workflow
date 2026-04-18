/**
 * Tests for team orchestration module.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskManager } from '../task-manager.js';
import { StateStore } from '../state-store.js';
import { TeamMonitor } from '../monitor.js';
import { inferPhase, isTerminalPhase, getPhaseDescription } from '../phase-controller.js';
import { deriveLeaderGuidance, generateRecommendations, needsIntervention } from '../leader-guidance.js';
import type { Task, Worker, TeamConfig, TeamSnapshot } from '../types.js';

describe('Phase Controller', () => {
  it('should return initializing for empty tasks', () => {
    expect(inferPhase([])).toBe('initializing');
  });

  it('should return planning for all pending tasks', () => {
    const tasks: Task[] = [
      createMockTask({ status: 'pending' }),
      createMockTask({ status: 'pending' }),
    ];
    expect(inferPhase(tasks)).toBe('planning');
  });

  it('should return executing for in_progress tasks', () => {
    const tasks: Task[] = [
      createMockTask({ status: 'in_progress' }),
      createMockTask({ status: 'pending' }),
    ];
    expect(inferPhase(tasks)).toBe('executing');
  });

  it('should return fixing for failed tasks with retries remaining', () => {
    const tasks: Task[] = [
      createMockTask({ status: 'failed', retryCount: 0, maxRetries: 3 }),
    ];
    expect(inferPhase(tasks)).toBe('fixing');
  });

  it('should return failed when all tasks failed and no retries remaining', () => {
    const tasks: Task[] = [
      createMockTask({ status: 'failed', retryCount: 3, maxRetries: 3 }),
      createMockTask({ status: 'completed', metadata: { permanentlyFailed: true } }),
    ];
    expect(inferPhase(tasks)).toBe('failed');
  });

  it('should return completed when all tasks completed successfully', () => {
    const tasks: Task[] = [
      createMockTask({ status: 'completed' }),
      createMockTask({ status: 'completed' }),
    ];
    expect(inferPhase(tasks)).toBe('completed');
  });

  it('should identify terminal phases correctly', () => {
    expect(isTerminalPhase('completed')).toBe(true);
    expect(isTerminalPhase('failed')).toBe(true);
    expect(isTerminalPhase('executing')).toBe(false);
    expect(isTerminalPhase('planning')).toBe(false);
  });

  it('should return phase descriptions', () => {
    expect(getPhaseDescription('executing')).toBe('Executing tasks in parallel');
    expect(getPhaseDescription('completed')).toBe('All tasks completed successfully');
  });
});

describe('Leader Guidance', () => {
  it('should recommend shutdown when all tasks are terminal', () => {
    const snapshot = createMockSnapshot({
      tasks: { total: 2, pending: 0, ready: 0, inProgress: 0, completed: 2, failed: 0, blocked: 0 },
    });
    const guidance = deriveLeaderGuidance(snapshot);
    expect(guidance.nextAction).toBe('shutdown');
  });

  it('should recommend launch-new-team when no alive workers', () => {
    const snapshot = createMockSnapshot({
      workers: [createMockWorker({ status: 'shutdown' })],
      tasks: { total: 1, pending: 1, ready: 0, inProgress: 0, completed: 0, failed: 0, blocked: 0 },
    });
    const guidance = deriveLeaderGuidance(snapshot);
    expect(guidance.nextAction).toBe('launch-new-team');
  });

  it('should recommend reuse-team when all workers are idle with pending tasks', () => {
    const snapshot = createMockSnapshot({
      workers: [createMockWorker({ status: 'idle' })],
      tasks: { total: 1, pending: 1, ready: 0, inProgress: 0, completed: 0, failed: 0, blocked: 0 },
    });
    const guidance = deriveLeaderGuidance(snapshot);
    expect(guidance.nextAction).toBe('reuse-team');
  });

  it('should recommend keep-monitoring during normal operation', () => {
    const snapshot = createMockSnapshot({
      workers: [createMockWorker({ status: 'working', currentTaskId: 'task-1' })],
      tasks: { total: 1, pending: 0, ready: 0, inProgress: 1, completed: 0, failed: 0, blocked: 0 },
    });
    const guidance = deriveLeaderGuidance(snapshot);
    expect(guidance.nextAction).toBe('keep-monitoring');
  });

  it('should detect intervention needed for dead workers with active tasks', () => {
    const snapshot = createMockSnapshot({
      deadWorkers: ['worker-1'],
      tasks: { total: 1, pending: 0, ready: 0, inProgress: 1, completed: 0, failed: 0, blocked: 0 },
    });
    expect(needsIntervention(snapshot)).toBe(true);
  });

  it('should detect intervention needed for high failure rate', () => {
    const snapshot = createMockSnapshot({
      tasks: { total: 10, pending: 0, ready: 0, inProgress: 0, completed: 4, failed: 6, blocked: 0 },
    });
    expect(needsIntervention(snapshot)).toBe(true);
  });

  it('should generate recommendations for blocked tasks', () => {
    const recommendations = generateRecommendations({
      teamName: 'test-team',
      phase: 'executing',
      workers: [],
      tasks: { total: 2, pending: 0, ready: 0, inProgress: 0, completed: 0, failed: 0, blocked: 2 },
      allTasksTerminal: false,
      deadWorkers: [],
      timestamp: new Date().toISOString(),
    });
    expect(recommendations.some(r => r.includes('blocked'))).toBe(true);
  });

  it('should generate recommendations for dead workers', () => {
    const recommendations = generateRecommendations({
      teamName: 'test-team',
      phase: 'executing',
      workers: [],
      tasks: { total: 1, pending: 1, ready: 0, inProgress: 0, completed: 0, failed: 0, blocked: 0 },
      allTasksTerminal: false,
      deadWorkers: ['worker-1'],
      timestamp: new Date().toISOString(),
    });
    expect(recommendations.some(r => r.includes('dead'))).toBe(true);
  });
});

describe('Task Manager', () => {
  let tempDir: string;
  let taskManager: TaskManager;

  beforeEach(() => {
    tempDir = join(tmpdir(), `tmux-manager-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    taskManager = new TaskManager(tempDir, 'test-team');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should create a task', async () => {
    const task = await taskManager.create({
      subject: 'Test Task',
      description: 'A test task',
    });

    expect(task.id).toBeDefined();
    expect(task.subject).toBe('Test Task');
    expect(task.status).toBe('pending');
    expect(task.createdAt).toBeDefined();
  });

  it('should read a task by ID', async () => {
    const created = await taskManager.create({
      subject: 'Test Task',
      description: 'A test task',
    });

    const task = await taskManager.read(created.id);
    expect(task).not.toBeNull();
    expect(task?.subject).toBe('Test Task');
  });

  it('should update a task', async () => {
    const created = await taskManager.create({
      subject: 'Test Task',
      description: 'A test task',
    });

    const updated = await taskManager.update(created.id, {
      status: 'in_progress',
      owner: 'worker-1',
    });

    expect(updated?.status).toBe('in_progress');
    expect(updated?.owner).toBe('worker-1');
    expect(updated?.startedAt).toBeDefined();
  });

  it('should complete a task', async () => {
    const created = await taskManager.create({
      subject: 'Test Task',
      description: 'A test task',
    });

    const completed = await taskManager.complete(created.id, 'Task finished');
    expect(completed?.status).toBe('completed');
    expect(completed?.summary).toBe('Task finished');
    expect(completed?.completedAt).toBeDefined();
  });

  it('should handle task failure with retry', async () => {
    const created = await taskManager.create({
      subject: 'Test Task',
      description: 'A test task',
      maxRetries: 3,
    });

    // First failure
    const failed1 = await taskManager.fail(created.id, 'Error 1');
    expect(failed1?.status).toBe('ready'); // Retry available
    expect(failed1?.retryCount).toBe(1);

    // Second failure
    const failed2 = await taskManager.fail(created.id, 'Error 2');
    expect(failed2?.status).toBe('ready');
    expect(failed2?.retryCount).toBe(2);
  });

  it('should mark task as permanently failed after max retries', async () => {
    const created = await taskManager.create({
      subject: 'Test Task',
      description: 'A test task',
      maxRetries: 2,
    });

    // Exhaust retries
    await taskManager.fail(created.id, 'Error 1');
    await taskManager.fail(created.id, 'Error 2');
    const failed = await taskManager.fail(created.id, 'Error 3');

    expect(failed?.status).toBe('completed');
    expect(failed?.metadata?.permanentlyFailed).toBe(true);
  });

  it('should get task statistics', async () => {
    await taskManager.create({ subject: 'Task 1', description: '' });
    await taskManager.create({ subject: 'Task 2', description: '' });
    const task3 = await taskManager.create({ subject: 'Task 3', description: '' });
    await taskManager.complete(task3.id);

    const stats = await taskManager.getStats();
    expect(stats.total).toBe(3);
    expect(stats.pending).toBe(2);
    expect(stats.completed).toBe(1);
  });

  it('should claim a task', async () => {
    const created = await taskManager.create({
      subject: 'Test Task',
      description: 'A test task',
    });

    const claimed = await taskManager.claim(created.id, 'worker-1');
    expect(claimed?.status).toBe('in_progress');
    expect(claimed?.owner).toBe('worker-1');
  });

  it('should delete a task', async () => {
    const created = await taskManager.create({
      subject: 'Test Task',
      description: 'A test task',
    });

    const deleted = await taskManager.delete(created.id);
    expect(deleted).toBe(true);

    const task = await taskManager.read(created.id);
    expect(task).toBeNull();
  });
});

describe('State Store', () => {
  let tempDir: string;
  let store: StateStore;

  beforeEach(() => {
    tempDir = join(tmpdir(), `tmux-manager-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    store = new StateStore({ stateRoot: tempDir, teamName: 'test-team' });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should save and load config', async () => {
    const config: TeamConfig = {
      name: 'test-team',
      goal: 'Test goal',
      cwd: '/workspace',
      sessionName: 'test-session',
      leaderPaneId: '%0',
      workerPaneIds: ['%1'],
      maxWorkers: 2,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
    };

    await store.saveConfig(config);
    const loaded = await store.loadConfig();

    expect(loaded).toEqual(config);
  });

  it('should save and load worker', async () => {
    const worker: Worker = {
      name: 'worker-1',
      type: 'claude',
      paneId: '%1',
      status: 'idle',
      taskStats: { completed: 0, failed: 0, inProgress: 0 },
      createdAt: new Date().toISOString(),
    };

    await store.saveWorker(worker);
    const loaded = await store.loadWorker('worker-1');

    expect(loaded).toEqual(worker);
  });

  it('should list workers', async () => {
    await store.saveWorker({
      name: 'worker-1',
      type: 'claude',
      paneId: '%1',
      status: 'idle',
      taskStats: { completed: 0, failed: 0, inProgress: 0 },
      createdAt: new Date().toISOString(),
    });
    await store.saveWorker({
      name: 'worker-2',
      type: 'claude',
      paneId: '%2',
      status: 'working',
      taskStats: { completed: 0, failed: 0, inProgress: 1 },
      createdAt: new Date().toISOString(),
    });

    const workers = await store.listWorkers();
    expect(workers.length).toBe(2);
  });

  it('should update worker status', async () => {
    await store.saveWorker({
      name: 'worker-1',
      type: 'claude',
      paneId: '%1',
      status: 'idle',
      taskStats: { completed: 0, failed: 0, inProgress: 0 },
      createdAt: new Date().toISOString(),
    });

    const updated = await store.updateWorkerStatus('worker-1', 'working', 'task-1');
    expect(updated?.status).toBe('working');
    expect(updated?.currentTaskId).toBe('task-1');
    expect(updated?.taskStats.inProgress).toBe(1);
  });

  it('should save and load phase', async () => {
    await store.savePhase('executing');
    const phase = await store.loadPhase();
    expect(phase).toBe('executing');
  });

  it('should save and load heartbeat', async () => {
    await store.saveHeartbeat('worker-1', { status: 'working', currentTaskId: 'task-1' });
    const heartbeat = await store.loadHeartbeat('worker-1');

    expect(heartbeat?.status).toBe('working');
    expect(heartbeat?.currentTaskId).toBe('task-1');
    expect(heartbeat?.timestamp).toBeDefined();
  });

  it('should check worker aliveness', async () => {
    await store.saveHeartbeat('worker-1', { status: 'working' });

    expect(store.isWorkerAlive('worker-1', 30000)).toBe(true);
    expect(store.isWorkerAlive('nonexistent', 30000)).toBe(false);
  });

  it('should load full state', async () => {
    await store.saveConfig({
      name: 'test-team',
      goal: 'Test goal',
      cwd: '/workspace',
      sessionName: 'test-session',
      leaderPaneId: '%0',
      workerPaneIds: [],
      maxWorkers: 2,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
    });

    await store.tasks.create({ subject: 'Task 1', description: '' });
    await store.savePhase('planning');

    const state = await store.loadState();
    expect(state?.config.name).toBe('test-team');
    expect(state?.tasks.length).toBe(1);
    expect(state?.phase).toBe('planning');
  });
});

describe('Team Monitor', () => {
  let tempDir: string;
  let store: StateStore;
  let monitor: TeamMonitor;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `tmux-manager-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
    store = new StateStore({ stateRoot: tempDir, teamName: 'test-team' });
    monitor = new TeamMonitor(store);

    // Setup initial state
    await store.saveConfig({
      name: 'test-team',
      goal: 'Test goal',
      cwd: '/workspace',
      sessionName: 'test-session',
      leaderPaneId: '%0',
      workerPaneIds: [],
      maxWorkers: 2,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should get team snapshot', async () => {
    await store.tasks.create({ subject: 'Task 1', description: '' });
    await store.tasks.create({ subject: 'Task 2', description: '' });

    const snapshot = await monitor.getSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.teamName).toBe('test-team');
    expect(snapshot?.tasks.total).toBe(2);
    expect(snapshot?.tasks.pending).toBe(2);
    expect(snapshot?.phase).toBe('planning');
  });

  it('should get leader guidance', async () => {
    await store.tasks.create({ subject: 'Task 1', description: '' });

    const guidance = await monitor.getGuidance();
    expect(guidance).not.toBeNull();
    expect(guidance?.nextAction).toBeDefined();
    expect(guidance?.message).toBeDefined();
  });

  it('should format snapshot for display', async () => {
    await store.tasks.create({ subject: 'Task 1', description: '' });

    const snapshot = await monitor.getSnapshot();
    const formatted = monitor.formatSnapshot(snapshot!);

    expect(formatted).toContain('Team: test-team');
    expect(formatted).toContain('Phase: planning');
    expect(formatted).toContain('Tasks:');
  });

  it('should get task progress', async () => {
    const task1 = await store.tasks.create({ subject: 'Task 1', description: '' });
    const task2 = await store.tasks.create({ subject: 'Task 2', description: '' });
    await store.tasks.complete(task1.id);

    const progress = await monitor.getTaskProgress();
    expect(progress.percentage).toBe(50);
    expect(progress.phase).toBe('executing');
  });
});

// ── Test Helpers ───────────────────────────────────────────────────────────────

function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    subject: 'Mock Task',
    description: 'A mock task for testing',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockWorker(overrides: Partial<Worker> = {}): Worker {
  return {
    name: 'worker-1',
    type: 'claude',
    paneId: '%1',
    status: 'idle',
    taskStats: { completed: 0, failed: 0, inProgress: 0 },
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockSnapshot(overrides: Partial<TeamSnapshot> = {}): TeamSnapshot {
  return {
    teamName: 'test-team',
    phase: 'executing',
    workers: [createMockWorker()],
    tasks: { total: 0, pending: 0, ready: 0, inProgress: 0, completed: 0, failed: 0, blocked: 0 },
    allTasksTerminal: true,
    deadWorkers: [],
    recommendations: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}
