/**
 * Task management for team orchestration.
 *
 * @module team/task-manager
 */

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task, TaskStatus, CreateTaskInput, UpdateTaskInput } from './types.js';

/**
 * Task manager for CRUD operations on tasks.
 */
export class TaskManager {
  private readonly taskDir: string;

  constructor(stateRoot: string, teamName: string) {
    this.taskDir = join(stateRoot, 'teams', teamName, 'tasks');
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!existsSync(this.taskDir)) {
      mkdirSync(this.taskDir, { recursive: true });
    }
  }

  private taskPath(taskId: string): string {
    return join(this.taskDir, `${taskId}.json`);
  }

  /**
   * Generate a new task ID
   */
  generateId(): string {
    return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  /**
   * Create a new task
   */
  async create(input: CreateTaskInput): Promise<Task> {
    const id = input.id ?? this.generateId();
    const now = new Date().toISOString();

    const task: Task = {
      id,
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm,
      status: 'pending',
      priority: input.priority ?? 'normal',
      dependsOn: input.dependsOn ?? [],
      blockedBy: [],
      retryCount: 0,
      maxRetries: input.maxRetries ?? 3,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    };

    await writeFile(this.taskPath(id), JSON.stringify(task, null, 2), 'utf-8');
    return task;
  }

  /**
   * Read a task by ID
   */
  async read(taskId: string): Promise<Task | null> {
    try {
      const content = await readFile(this.taskPath(taskId), 'utf-8');
      return JSON.parse(content) as Task;
    } catch {
      return null;
    }
  }

  /**
   * Update a task
   */
  async update(taskId: string, input: UpdateTaskInput): Promise<Task | null> {
    const task = await this.read(taskId);
    if (!task) return null;

    const now = new Date().toISOString();
    const updated: Task = {
      ...task,
      ...input,
      updatedAt: now,
    };

    // Track timestamps
    if (input.status === 'in_progress' && !task.startedAt) {
      updated.startedAt = now;
    }
    if (input.status === 'completed' || input.status === 'failed') {
      updated.completedAt = now;
    }

    await writeFile(this.taskPath(taskId), JSON.stringify(updated, null, 2), 'utf-8');
    return updated;
  }

  /**
   * Delete a task
   */
  async delete(taskId: string): Promise<boolean> {
    try {
      await unlink(this.taskPath(taskId));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all task IDs
   */
  async listIds(): Promise<string[]> {
    try {
      const { readdir } = await import('node:fs/promises');
      const files = await readdir(this.taskDir);
      return files
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5));
    } catch {
      return [];
    }
  }

  /**
   * List all tasks
   */
  async list(): Promise<Task[]> {
    const ids = await this.listIds();
    const tasks = await Promise.all(ids.map(id => this.read(id)));
    return tasks.filter((t): t is Task => t !== null);
  }

  /**
   * Get tasks by status
   */
  async getByStatus(status: TaskStatus): Promise<Task[]> {
    const tasks = await this.list();
    return tasks.filter(t => t.status === status);
  }

  /**
   * Get tasks by owner
   */
  async getByOwner(owner: string): Promise<Task[]> {
    const tasks = await this.list();
    return tasks.filter(t => t.owner === owner);
  }

  /**
   * Claim a task for a worker
   */
  async claim(taskId: string, owner: string): Promise<Task | null> {
    return this.update(taskId, { status: 'in_progress', owner });
  }

  /**
   * Mark task as completed
   */
  async complete(taskId: string, summary?: string): Promise<Task | null> {
    return this.update(taskId, { status: 'completed', summary });
  }

  /**
   * Mark task as failed
   */
  async fail(taskId: string, error: string): Promise<Task | null> {
    const task = await this.read(taskId);
    if (!task) return null;

    const retryCount = (task.retryCount ?? 0) + 1;
    const maxRetries = task.maxRetries ?? 3;

    // If retries exhausted, mark as permanently failed
    if (retryCount >= maxRetries) {
      return this.update(taskId, {
        status: 'completed',
        error,
        retryCount,
        metadata: { ...task.metadata, permanentlyFailed: true },
      });
    }

    // Otherwise, mark for retry
    return this.update(taskId, {
      status: 'ready',
      error,
      retryCount,
    });
  }

  /**
   * Get task statistics
   */
  async getStats(): Promise<{
    total: number;
    pending: number;
    ready: number;
    inProgress: number;
    completed: number;
    failed: number;
    blocked: number;
  }> {
    const tasks = await this.list();
    return {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending').length,
      ready: tasks.filter(t => t.status === 'ready').length,
      inProgress: tasks.filter(t => t.status === 'in_progress').length,
      completed: tasks.filter(t => t.status === 'completed' && !t.metadata?.permanentlyFailed).length,
      failed: tasks.filter(t => t.status === 'failed' || (t.status === 'completed' && t.metadata?.permanentlyFailed)).length,
      blocked: tasks.filter(t => t.status === 'blocked').length,
    };
  }
}
