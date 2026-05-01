import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildBataWorkflowSnapshots } from './bata-workflow-live';

const tempRoots: string[] = [];

const createTempStateRoot = () => {
  const root = mkdtempSync(resolve(tmpdir(), 'monitor-bata-workflow-live-'));
  tempRoots.push(root);
  return root;
};

const writeJson = (filePath: string, value: unknown) => {
  mkdirSync(resolve(filePath, '..'), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

const writeJsonLines = (filePath: string, values: unknown[]) => {
  mkdirSync(resolve(filePath, '..'), { recursive: true });
  writeFileSync(
    filePath,
    values.map((value) => JSON.stringify(value)).join('\n').concat(values.length > 0 ? '\n' : ''),
    'utf8',
  );
};

afterEach(() => {
  vi.useRealTimers();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('buildBataWorkflowSnapshots', () => {
  it('falls back to a lead-only shell snapshot when monitor session exists but no run has started yet', async () => {
    const stateRoot = createTempStateRoot();

    writeJson(resolve(stateRoot, 'monitor-board', 'runtime.json'), {
      activeRootSessionIds: ['workspace-shell'],
    });
    writeJson(resolve(stateRoot, 'monitor-sessions', 'workspace-shell.json'), {
      rootSessionId: 'workspace-shell',
      monitorSessionId: 'monitor:workspace-shell',
      ownerActorId: 'lead',
      status: 'active',
      createdAt: '2026-04-22T04:00:00.000Z',
      updatedAt: '2026-04-22T04:00:00.000Z',
    });

    const snapshots = await buildBataWorkflowSnapshots(stateRoot);

    expect(snapshots).toEqual([
      expect.objectContaining({
        monitorSessionId: 'monitor:workspace-shell',
        actorCount: 1,
        timelineCount: 1,
        stats: expect.objectContaining({
          actorCount: 1,
          activeCount: 1,
        }),
        state: expect.objectContaining({
          actors: [expect.objectContaining({ id: 'lead:workspace-shell', actorType: 'lead', status: 'active' })],
          timeline: [expect.objectContaining({ actorId: 'lead:workspace-shell', eventType: 'session.started' })],
        }),
      }),
    ]);
  });

  it('ignores stale historical runs created before the current monitor session attach time', async () => {
    const stateRoot = createTempStateRoot();
    const staleRunDirectory = resolve(stateRoot, 'runs', '1000-stale-run');

    writeJson(resolve(stateRoot, 'monitor-board', 'runtime.json'), {
      activeRootSessionIds: ['workspace-stale'],
    });
    writeJson(resolve(stateRoot, 'monitor-sessions', 'workspace-stale.json'), {
      rootSessionId: 'workspace-stale',
      monitorSessionId: 'monitor:workspace-stale',
      ownerActorId: 'lead',
      status: 'active',
      createdAt: '2026-04-22T04:00:00.000Z',
      updatedAt: '2026-04-22T08:00:00.000Z',
    });
    writeJson(resolve(staleRunDirectory, 'queue.json'), {
      goal: 'historical goal',
      createdAt: '2026-04-21T10:00:00.000Z',
      updatedAt: '2026-04-21T10:01:00.000Z',
      taskOrder: ['T1'],
      events: [
        {
          type: 'run-started',
          batchId: 'RUN',
          detail: 'historical run',
          createdAt: '2026-04-21T10:00:00.000Z',
        },
      ],
      monitor: {
        rootSessionId: 'workspace-stale',
        monitorSessionId: 'monitor:workspace-stale',
        workspaceRoot: '/tmp/workspace-stale',
      },
    });
    writeJson(resolve(staleRunDirectory, 'task-store.json'), {
      assignments: [
        {
          task: {
            id: 'T1',
            title: 'Historical task',
            role: 'coder',
            taskType: 'coding',
            generatedFromTaskId: null,
          },
          executionTarget: {
            model: 'gpt-5.4',
          },
        },
      ],
      taskStates: [
        {
          taskId: 'T1',
          status: 'completed',
          phase: 'completed',
          phaseDetail: null,
          claimedBy: null,
          attempts: 1,
          lastError: null,
          lastClaimedAt: '2026-04-21T10:00:10.000Z',
          releasedAt: '2026-04-21T10:00:40.000Z',
          lastUpdatedAt: '2026-04-21T10:00:40.000Z',
          attemptHistory: [{ startedAt: '2026-04-21T10:00:10.000Z', finishedAt: '2026-04-21T10:00:40.000Z' }],
        },
      ],
      results: [{ taskId: 'T1', summary: 'historical result' }],
    });

    const snapshots = await buildBataWorkflowSnapshots(stateRoot);

    expect(snapshots).toEqual([
      expect.objectContaining({
        monitorSessionId: 'monitor:workspace-stale',
        actorCount: 1,
        timelineCount: 1,
        state: expect.objectContaining({
          actors: [expect.objectContaining({ id: 'lead:workspace-stale', actorType: 'lead' })],
        }),
      }),
    ]);
  });

  it('returns a shell snapshot for the current monitor session instead of inferring another workspace-matching Coco session', async () => {
    const stateRoot = createTempStateRoot();
    const cocoSessionsRoot = resolve(createTempStateRoot(), 'coco-sessions');
    const rootSessionId = 'coco-live-A';
    const otherCocoSessionId = 'coco-live-B';

    writeJson(resolve(stateRoot, 'monitor-board', 'runtime.json'), {
      activeRootSessionIds: [rootSessionId],
    });
    writeJson(resolve(stateRoot, 'monitor-sessions', `${encodeURIComponent(rootSessionId)}.json`), {
      rootSessionId,
      monitorSessionId: `monitor:${rootSessionId}`,
      ownerActorId: 'lead',
      status: 'active',
      workspaceRoot: '/tmp/workspace-shared',
      createdAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:00.000Z',
    });

    writeJson(resolve(cocoSessionsRoot, otherCocoSessionId, 'session.json'), {
      id: otherCocoSessionId,
      created_at: '2026-04-23T10:00:05.000Z',
      updated_at: '2026-04-23T10:00:10.000Z',
      metadata: {
        cwd: '/tmp/workspace-shared',
        model_name: 'gpt-5.4',
        title: 'session B should stay isolated',
      },
    });
    writeJsonLines(resolve(cocoSessionsRoot, otherCocoSessionId, 'events.jsonl'), [
      {
        id: 'event-tool-call',
        session_id: otherCocoSessionId,
        agent_id: 'agent-lead',
        agent_name: 'TraeCli',
        parent_tool_call_id: '',
        created_at: '2026-04-23T10:00:20.000Z',
        tool_call: {
          tool_call_id: 'tool-call-1',
          tool_info: {
            name: 'Skill',
          },
        },
      },
    ]);

    const snapshots = await buildBataWorkflowSnapshots(stateRoot, { cocoSessionsRoot });
    const repeatedSnapshots = await buildBataWorkflowSnapshots(stateRoot, { cocoSessionsRoot });

    expect(snapshots).toEqual([
      expect.objectContaining({
        monitorSessionId: `monitor:${rootSessionId}`,
        actorCount: 1,
        timelineCount: 1,
        state: expect.objectContaining({
          timeline: [
            expect.objectContaining({
              sessionId: rootSessionId,
              summary: 'awaiting runtime data',
            }),
          ],
        }),
      }),
    ]);
    expect(snapshots[0]?.state.timeline.some((event) => event.sessionId === otherCocoSessionId)).toBe(false);
  });

  it('prefers Coco live session data over bata-workflow run data when the monitor session is attached to an active Coco session', async () => {
    const stateRoot = createTempStateRoot();
    const cocoSessionsRoot = resolve(createTempStateRoot(), 'coco-sessions');
    const runDirectory = resolve(stateRoot, 'runs', '1001-latest-run');
    const cocoSessionId = 'coco-session-live';
    const now = Date.now();
    const monitorCreatedAt = new Date(now - 8_000).toISOString();
    const monitorUpdatedAt = new Date(now - 7_000).toISOString();
    const runCreatedAt = new Date(now - 6_500).toISOString();
    const runUpdatedAt = new Date(now - 5_000).toISOString();
    const runEventAt = new Date(now - 6_000).toISOString();
    const taskClaimedAt = new Date(now - 5_800).toISOString();
    const taskUpdatedAt = new Date(now - 5_200).toISOString();
    const cocoCreatedAt = new Date(now - 4_000).toISOString();
    const cocoUpdatedAt = new Date(now - 1_000).toISOString();
    const cocoToolCallAt = new Date(now - 900).toISOString();
    const cocoToolResultAt = new Date(now - 600).toISOString();
    const cocoTraceStartTime = (now - 800) * 1000;

    writeJson(resolve(stateRoot, 'monitor-board', 'runtime.json'), {
      activeRootSessionIds: ['workspace-coco'],
    });
    writeJson(resolve(stateRoot, 'monitor-sessions', 'workspace-coco.json'), {
      rootSessionId: 'workspace-coco',
      monitorSessionId: 'monitor:workspace-coco',
      ownerActorId: 'lead',
      status: 'active',
      cocoSessionId,
      workspaceRoot: '/tmp/workspace-coco',
      createdAt: monitorCreatedAt,
      updatedAt: monitorUpdatedAt,
    });

    writeJson(resolve(runDirectory, 'queue.json'), {
      goal: 'older bata-workflow monitor view',
      createdAt: runCreatedAt,
      updatedAt: runUpdatedAt,
      taskOrder: ['T1'],
      events: [
        {
          type: 'run-started',
          batchId: 'RUN',
          detail: 'run snapshot should not win over Coco',
          createdAt: runEventAt,
        },
      ],
      monitor: {
        rootSessionId: 'workspace-coco',
        monitorSessionId: 'monitor:workspace-coco',
        workspaceRoot: '/tmp/workspace-coco',
      },
    });
    writeJson(resolve(runDirectory, 'task-store.json'), {
      assignments: [
        {
          task: {
            id: 'T1',
            title: 'Bata-workflow task fallback',
            role: 'coder',
            taskType: 'coding',
            generatedFromTaskId: null,
          },
          executionTarget: {
            model: 'gpt-5.4-mini',
          },
        },
      ],
      taskStates: [
        {
          taskId: 'T1',
          status: 'active',
          phase: 'executing',
          phaseDetail: null,
          claimedBy: 'coder-1',
          attempts: 1,
          lastError: null,
          lastClaimedAt: taskClaimedAt,
          releasedAt: null,
          lastUpdatedAt: taskUpdatedAt,
          attemptHistory: [{ startedAt: taskClaimedAt, finishedAt: null }],
        },
      ],
      results: [],
    });

    writeJson(resolve(cocoSessionsRoot, cocoSessionId, 'session.json'), {
      id: cocoSessionId,
      created_at: cocoCreatedAt,
      updated_at: cocoUpdatedAt,
      metadata: {
        cwd: '/tmp/workspace-coco',
        model_name: 'gpt-5.4',
        title: 'Investigate live bridge',
      },
    });
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'events.jsonl'), [
      {
        id: 'event-tool-call',
        session_id: cocoSessionId,
        agent_id: 'agent-lead',
        agent_name: 'TraeCli',
        parent_tool_call_id: '',
        created_at: cocoToolCallAt,
        tool_call: {
          tool_call_id: 'tool-call-1',
          tool_info: {
            name: 'Skill',
          },
        },
      },
      {
        id: 'event-tool-result',
        session_id: cocoSessionId,
        agent_id: 'agent-lead',
        agent_name: 'TraeCli',
        parent_tool_call_id: '',
        created_at: cocoToolResultAt,
        tool_call_output: {
          tool_call_id: 'tool-call-1',
        },
      },
    ]);
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'traces.jsonl'), [
      {
        startTime: cocoTraceStartTime,
        duration: 1_800_000,
        tags: [
          { key: 'span.category', value: 'model.call' },
          { key: 'agent.id', value: 'agent-lead' },
          { key: 'agent.name', value: 'TraeCli' },
          { key: 'model.name', value: 'gpt-5.4' },
          { key: 'usage.input_tokens', value: 321 },
          { key: 'usage.output_tokens', value: 45 },
        ],
      },
    ]);

    const snapshots = await buildBataWorkflowSnapshots(stateRoot, { cocoSessionsRoot });

    expect(snapshots).toEqual([
      expect.objectContaining({
        monitorSessionId: 'monitor:workspace-coco',
        actorCount: 1,
        timelineCount: 5,
        stats: expect.objectContaining({
          totalTokens: 366,
        }),
        state: expect.objectContaining({
          timeline: expect.arrayContaining([
            expect.objectContaining({
              eventType: 'session.started',
              metadata: expect.objectContaining({
                source: 'coco',
                displayName: 'TraeCli',
              }),
            }),
            expect.objectContaining({
              eventType: 'tool.called',
              toolName: 'Skill',
            }),
            expect.objectContaining({
              eventType: 'tool.finished',
              toolName: 'Skill',
            }),
            expect.objectContaining({
              eventType: 'action.summary',
              tokenIn: 321,
              tokenOut: 45,
            }),
            expect.objectContaining({
              eventType: 'session.updated',
              status: 'idle',
              summary: 'waiting for user input',
            }),
          ]),
        }),
      }),
    ]);
    const repeatedSnapshots = await buildBataWorkflowSnapshots(stateRoot, { cocoSessionsRoot });
    expect(repeatedSnapshots).toEqual(snapshots);
  });

  it('keeps a bound Coco session in waiting-shell mode when the session exists but has not emitted live data yet', async () => {
    const stateRoot = createTempStateRoot();
    const cocoSessionsRoot = resolve(createTempStateRoot(), 'coco-sessions');
    const rootSessionId = 'workspace-coco-empty';
    const cocoSessionId = 'coco-session-empty';
    const now = Date.now();
    const createdAt = new Date(now - 5_000).toISOString();
    const updatedAt = new Date(now - 1_000).toISOString();

    writeJson(resolve(stateRoot, 'monitor-board', 'runtime.json'), {
      activeRootSessionIds: [rootSessionId],
    });
    writeJson(resolve(stateRoot, 'monitor-sessions', `${encodeURIComponent(rootSessionId)}.json`), {
      rootSessionId,
      monitorSessionId: `monitor:${rootSessionId}`,
      ownerActorId: 'lead',
      status: 'active',
      cocoSessionId,
      workspaceRoot: '/tmp/workspace-coco-empty',
      createdAt,
      updatedAt: createdAt,
    });

    writeJson(resolve(cocoSessionsRoot, cocoSessionId, 'session.json'), {
      id: cocoSessionId,
      created_at: createdAt,
      updated_at: updatedAt,
      metadata: {
        cwd: '/tmp/workspace-coco-empty',
        model_name: 'gpt-5.4',
        title: 'Waiting for first live event',
      },
    });
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'events.jsonl'), []);
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'traces.jsonl'), []);

    const snapshots = await buildBataWorkflowSnapshots(stateRoot, { cocoSessionsRoot });

    expect(snapshots).toEqual([
      expect.objectContaining({
        monitorSessionId: `monitor:${rootSessionId}`,
        actorCount: 1,
        timelineCount: 1,
        state: expect.objectContaining({
          actors: [expect.objectContaining({ status: 'active' })],
          timeline: [expect.objectContaining({ status: 'active', summary: 'awaiting runtime data' })],
        }),
      }),
    ]);
  });

  it('keeps a bound Coco session isolated across waiting, live, and disconnected transitions while a sibling session stays active', async () => {
    const stateRoot = createTempStateRoot();
    const cocoSessionsRoot = resolve(createTempStateRoot(), 'coco-sessions');
    const rootSessionId = 'coco-live-A';
    const cocoSessionId = 'coco-live-A';
    const siblingCocoSessionId = 'coco-live-B';
    const workspaceRoot = '/tmp/workspace-shared';
    const now = Date.now();

    writeJson(resolve(stateRoot, 'monitor-board', 'runtime.json'), {
      activeRootSessionIds: [rootSessionId],
    });
    writeJson(resolve(stateRoot, 'monitor-sessions', `${encodeURIComponent(rootSessionId)}.json`), {
      rootSessionId,
      monitorSessionId: `monitor:${rootSessionId}`,
      ownerActorId: 'lead',
      status: 'active',
      cocoSessionId,
      workspaceRoot,
      createdAt: new Date(now - 8_000).toISOString(),
      updatedAt: new Date(now - 7_000).toISOString(),
    });

    writeJson(resolve(cocoSessionsRoot, siblingCocoSessionId, 'session.json'), {
      id: siblingCocoSessionId,
      created_at: new Date(now - 4_000).toISOString(),
      updated_at: new Date(now - 500).toISOString(),
      metadata: {
        cwd: workspaceRoot,
        model_name: 'gpt-5.4',
        title: 'Sibling session should stay isolated',
      },
    });
    writeJsonLines(resolve(cocoSessionsRoot, siblingCocoSessionId, 'events.jsonl'), [
      {
        id: 'event-tool-call-b',
        session_id: siblingCocoSessionId,
        agent_id: 'agent-sibling',
        agent_name: 'TraeCli',
        parent_tool_call_id: '',
        created_at: new Date(now - 400).toISOString(),
        tool_call: {
          tool_call_id: 'tool-call-b',
          tool_info: {
            name: 'Skill',
          },
        },
      },
    ]);
    writeJsonLines(resolve(cocoSessionsRoot, siblingCocoSessionId, 'traces.jsonl'), [
      {
        startTime: (now - 300) * 1000,
        duration: 500_000,
        tags: [
          { key: 'span.category', value: 'model.call' },
          { key: 'agent.id', value: 'agent-sibling' },
          { key: 'agent.name', value: 'TraeCli' },
          { key: 'model.name', value: 'gpt-5.4' },
          { key: 'usage.input_tokens', value: 50 },
          { key: 'usage.output_tokens', value: 10 },
        ],
      },
    ]);

    writeJson(resolve(cocoSessionsRoot, cocoSessionId, 'session.json'), {
      id: cocoSessionId,
      created_at: new Date(now - 5_000).toISOString(),
      updated_at: new Date(now - 1_000).toISOString(),
      metadata: {
        cwd: workspaceRoot,
        model_name: 'gpt-5.4',
        title: 'Bound session A',
      },
    });
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'events.jsonl'), []);
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'traces.jsonl'), []);

    const initialSnapshots = await buildBataWorkflowSnapshots(stateRoot, { cocoSessionsRoot });

    expect(initialSnapshots).toEqual([
      expect.objectContaining({
        monitorSessionId: `monitor:${rootSessionId}`,
        actorCount: 1,
        timelineCount: 1,
        state: expect.objectContaining({
          timeline: [expect.objectContaining({ sessionId: rootSessionId, summary: 'awaiting runtime data' })],
        }),
      }),
    ]);
    expect(initialSnapshots[0]?.state.timeline.some((event) => event.sessionId === siblingCocoSessionId)).toBe(false);

    writeJson(resolve(cocoSessionsRoot, siblingCocoSessionId, 'session.json'), {
      id: siblingCocoSessionId,
      created_at: new Date(now - 4_000).toISOString(),
      updated_at: new Date(now - 100).toISOString(),
      metadata: {
        cwd: workspaceRoot,
        model_name: 'gpt-5.4',
        title: 'Sibling session kept advancing',
      },
    });
    writeJsonLines(resolve(cocoSessionsRoot, siblingCocoSessionId, 'events.jsonl'), [
      {
        id: 'event-tool-call-b-2',
        session_id: siblingCocoSessionId,
        agent_id: 'agent-sibling',
        agent_name: 'TraeCli',
        parent_tool_call_id: '',
        created_at: new Date(now - 90).toISOString(),
        tool_call: {
          tool_call_id: 'tool-call-b-2',
          tool_info: {
            name: 'Skill',
          },
        },
      },
    ]);

    const siblingOnlySnapshots = await buildBataWorkflowSnapshots(stateRoot, { cocoSessionsRoot });

    expect(siblingOnlySnapshots).toEqual(initialSnapshots);

    const liveToolCallAt = new Date(now - 80).toISOString();
    const liveToolResultAt = new Date(now - 50).toISOString();
    writeJson(resolve(cocoSessionsRoot, cocoSessionId, 'session.json'), {
      id: cocoSessionId,
      created_at: new Date(now - 5_000).toISOString(),
      updated_at: new Date(now - 40).toISOString(),
      metadata: {
        cwd: workspaceRoot,
        model_name: 'gpt-5.4',
        title: 'Bound session A',
      },
    });
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'events.jsonl'), [
      {
        id: 'event-tool-call-a',
        session_id: cocoSessionId,
        agent_id: 'agent-lead',
        agent_name: 'TraeCli',
        parent_tool_call_id: '',
        created_at: liveToolCallAt,
        tool_call: {
          tool_call_id: 'tool-call-a',
          tool_info: {
            name: 'Skill',
          },
        },
      },
      {
        id: 'event-tool-result-a',
        session_id: cocoSessionId,
        agent_id: 'agent-lead',
        agent_name: 'TraeCli',
        parent_tool_call_id: '',
        created_at: liveToolResultAt,
        tool_call_output: {
          tool_call_id: 'tool-call-a',
        },
      },
    ]);
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'traces.jsonl'), [
      {
        startTime: (now - 70) * 1000,
        duration: 900_000,
        tags: [
          { key: 'span.category', value: 'model.call' },
          { key: 'agent.id', value: 'agent-lead' },
          { key: 'agent.name', value: 'TraeCli' },
          { key: 'model.name', value: 'gpt-5.4' },
          { key: 'usage.input_tokens', value: 321 },
          { key: 'usage.output_tokens', value: 45 },
        ],
      },
    ]);

    const liveSnapshots = await buildBataWorkflowSnapshots(stateRoot, { cocoSessionsRoot });

    expect(liveSnapshots).toEqual([
      expect.objectContaining({
        monitorSessionId: `monitor:${rootSessionId}`,
        timelineCount: 5,
        state: expect.objectContaining({
          timeline: expect.arrayContaining([
            expect.objectContaining({ eventType: 'tool.called', toolName: 'Skill', sessionId: cocoSessionId }),
            expect.objectContaining({ eventType: 'tool.finished', toolName: 'Skill', sessionId: cocoSessionId }),
            expect.objectContaining({ eventType: 'action.summary', tokenIn: 321, tokenOut: 45, sessionId: cocoSessionId }),
            expect.objectContaining({ eventType: 'session.updated', status: 'idle', summary: 'waiting for user input' }),
          ]),
        }),
      }),
    ]);
    expect(liveSnapshots[0]?.state.timeline.some((event) => event.sessionId === siblingCocoSessionId)).toBe(false);

    const staleCreatedAt = new Date(now - 120_000).toISOString();
    const staleUpdatedAt = new Date(now - 90_000).toISOString();
    const staleToolCallAt = new Date(now - 85_000).toISOString();
    const staleToolResultAt = new Date(now - 80_000).toISOString();

    writeJson(resolve(cocoSessionsRoot, cocoSessionId, 'session.json'), {
      id: cocoSessionId,
      created_at: staleCreatedAt,
      updated_at: staleUpdatedAt,
      metadata: {
        cwd: workspaceRoot,
        model_name: 'gpt-5.4',
        title: 'Bound session A',
      },
    });
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'events.jsonl'), [
      {
        id: 'event-tool-call-a-stale',
        session_id: cocoSessionId,
        agent_id: 'agent-lead',
        agent_name: 'TraeCli',
        parent_tool_call_id: '',
        created_at: staleToolCallAt,
        tool_call: {
          tool_call_id: 'tool-call-a-stale',
          tool_info: {
            name: 'Skill',
          },
        },
      },
      {
        id: 'event-tool-result-a-stale',
        session_id: cocoSessionId,
        agent_id: 'agent-lead',
        agent_name: 'TraeCli',
        parent_tool_call_id: '',
        created_at: staleToolResultAt,
        tool_call_output: {
          tool_call_id: 'tool-call-a-stale',
        },
      },
    ]);
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'traces.jsonl'), []);

    const disconnectedSnapshots = await buildBataWorkflowSnapshots(stateRoot, { cocoSessionsRoot });

    expect(disconnectedSnapshots).toEqual([
      expect.objectContaining({
        monitorSessionId: `monitor:${rootSessionId}`,
        state: expect.objectContaining({
          actors: [expect.objectContaining({ status: 'disconnected' })],
          timeline: expect.arrayContaining([
            expect.objectContaining({ eventType: 'tool.called', toolName: 'Skill', sessionId: cocoSessionId }),
            expect.objectContaining({ eventType: 'tool.finished', toolName: 'Skill', sessionId: cocoSessionId }),
            expect.objectContaining({ eventType: 'session.updated', status: 'disconnected', summary: 'live session disconnected' }),
          ]),
        }),
      }),
    ]);
    expect(disconnectedSnapshots[0]?.state.timeline.some((event) => event.sessionId === siblingCocoSessionId)).toBe(false);
  });

  it('marks the session disconnected when the bound Coco session stops updating but still has historical data', async () => {
    const stateRoot = createTempStateRoot();
    const cocoSessionsRoot = resolve(createTempStateRoot(), 'coco-sessions');
    const rootSessionId = 'workspace-coco-stale';
    const cocoSessionId = 'coco-session-stale';
    const now = Date.now();
    const staleCreatedAt = new Date(now - 120_000).toISOString();
    const staleUpdatedAt = new Date(now - 90_000).toISOString();
    const staleToolCallAt = new Date(now - 85_000).toISOString();
    const staleToolResultAt = new Date(now - 80_000).toISOString();

    writeJson(resolve(stateRoot, 'monitor-board', 'runtime.json'), {
      activeRootSessionIds: [rootSessionId],
    });
    writeJson(resolve(stateRoot, 'monitor-sessions', `${encodeURIComponent(rootSessionId)}.json`), {
      rootSessionId,
      monitorSessionId: `monitor:${rootSessionId}`,
      ownerActorId: 'lead',
      status: 'active',
      cocoSessionId,
      workspaceRoot: '/tmp/workspace-coco-stale',
      createdAt: staleCreatedAt,
      updatedAt: staleCreatedAt,
    });

    writeJson(resolve(cocoSessionsRoot, cocoSessionId, 'session.json'), {
      id: cocoSessionId,
      created_at: staleCreatedAt,
      updated_at: staleUpdatedAt,
      metadata: {
        cwd: '/tmp/workspace-coco-stale',
        model_name: 'gpt-5.4',
        title: 'Stale live bridge',
      },
    });
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'events.jsonl'), [
      {
        id: 'event-tool-call',
        session_id: cocoSessionId,
        agent_id: 'agent-lead',
        agent_name: 'TraeCli',
        parent_tool_call_id: '',
        created_at: staleToolCallAt,
        tool_call: {
          tool_call_id: 'tool-call-1',
          tool_info: {
            name: 'Skill',
          },
        },
      },
      {
        id: 'event-tool-result',
        session_id: cocoSessionId,
        agent_id: 'agent-lead',
        agent_name: 'TraeCli',
        parent_tool_call_id: '',
        created_at: staleToolResultAt,
        tool_call_output: {
          tool_call_id: 'tool-call-1',
        },
      },
    ]);

    const snapshots = await buildBataWorkflowSnapshots(stateRoot, { cocoSessionsRoot });

    expect(snapshots).toEqual([
      expect.objectContaining({
        monitorSessionId: `monitor:${rootSessionId}`,
        timelineCount: 4,
        state: expect.objectContaining({
          actors: [expect.objectContaining({ status: 'disconnected' })],
          timeline: expect.arrayContaining([
            expect.objectContaining({ eventType: 'tool.called', toolName: 'Skill' }),
            expect.objectContaining({ eventType: 'tool.finished', toolName: 'Skill' }),
            expect.objectContaining({ eventType: 'session.updated', status: 'disconnected', summary: 'live session disconnected' }),
          ]),
        }),
      }),
    ]);
  });

  it('keeps a recently quiet bound Coco session active before the stale cutoff elapses', async () => {
    const stateRoot = createTempStateRoot();
    const cocoSessionsRoot = resolve(createTempStateRoot(), 'coco-sessions');
    const rootSessionId = 'coco-live-recent';
    const cocoSessionId = 'coco-live-recent';
    const now = Date.now();
    const recentCreatedAt = new Date(now - 45_000).toISOString();
    const recentUpdatedAt = new Date(now - 20_000).toISOString();
    const recentToolCallAt = new Date(now - 18_000).toISOString();

    writeJson(resolve(stateRoot, 'monitor-board', 'runtime.json'), {
      activeRootSessionIds: [rootSessionId],
    });
    writeJson(resolve(stateRoot, 'monitor-sessions', `${encodeURIComponent(rootSessionId)}.json`), {
      rootSessionId,
      monitorSessionId: `monitor:${rootSessionId}`,
      ownerActorId: 'lead',
      status: 'active',
      cocoSessionId,
      workspaceRoot: '/tmp/workspace-coco-recent',
      createdAt: recentCreatedAt,
      updatedAt: recentCreatedAt,
    });

    writeJson(resolve(cocoSessionsRoot, cocoSessionId, 'session.json'), {
      id: cocoSessionId,
      created_at: recentCreatedAt,
      updated_at: recentUpdatedAt,
      metadata: {
        cwd: '/tmp/workspace-coco-recent',
        model_name: 'gpt-5.4',
        title: 'Quiet but still active',
      },
    });
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'events.jsonl'), [
      {
        id: 'event-tool-call-recent',
        session_id: cocoSessionId,
        agent_id: 'agent-lead',
        agent_name: 'TraeCli',
        parent_tool_call_id: '',
        created_at: recentToolCallAt,
        tool_call: {
          tool_call_id: 'tool-call-recent',
          tool_info: {
            name: 'Skill',
          },
        },
      },
    ]);
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'traces.jsonl'), []);

    const snapshots = await buildBataWorkflowSnapshots(stateRoot, { cocoSessionsRoot });

    expect(snapshots).toEqual([
      expect.objectContaining({
        monitorSessionId: `monitor:${rootSessionId}`,
        state: expect.objectContaining({
          actors: [expect.objectContaining({ status: 'active' })],
          timeline: expect.arrayContaining([
            expect.objectContaining({ eventType: 'tool.called', toolName: 'Skill', status: 'active' }),
          ]),
        }),
      }),
    ]);
    expect(snapshots[0]?.state.timeline.some((event) => event.summary === 'live session disconnected')).toBe(false);
  });

  it('marks a completed single-turn Coco session as waiting for user input before stale cutoff', async () => {
    const stateRoot = createTempStateRoot();
    const cocoSessionsRoot = resolve(createTempStateRoot(), 'coco-sessions');
    const rootSessionId = 'coco-live-waiting';
    const cocoSessionId = 'coco-live-waiting';
    const now = Date.now();
    const createdAt = new Date(now - 45_000).toISOString();
    const updatedAt = new Date(now - 8_000).toISOString();
    const agentStartAt = new Date(now - 20_000).toISOString();
    const agentEndAt = new Date(now - 9_000).toISOString();

    writeJson(resolve(stateRoot, 'monitor-board', 'runtime.json'), {
      activeRootSessionIds: [rootSessionId],
    });
    writeJson(resolve(stateRoot, 'monitor-sessions', `${encodeURIComponent(rootSessionId)}.json`), {
      rootSessionId,
      monitorSessionId: `monitor:${rootSessionId}`,
      ownerActorId: 'lead',
      status: 'active',
      cocoSessionId,
      workspaceRoot: '/tmp/workspace-coco-waiting',
      createdAt,
      updatedAt: createdAt,
    });

    writeJson(resolve(cocoSessionsRoot, cocoSessionId, 'session.json'), {
      id: cocoSessionId,
      created_at: createdAt,
      updated_at: updatedAt,
      metadata: {
        cwd: '/tmp/workspace-coco-waiting',
        model_name: 'gpt-5.4',
        title: 'Completed single-turn response',
      },
    });
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'events.jsonl'), [
      {
        id: 'event-agent-start-waiting',
        session_id: cocoSessionId,
        agent_id: 'agent-lead',
        agent_name: 'TraeCli',
        parent_tool_call_id: '',
        created_at: agentStartAt,
        agent_start: {
          input: [
            {
              role: 'user',
              content: 'Summarize this status.',
              extra: {
                is_original_user_input: true,
              },
            },
          ],
        },
      },
      {
        id: 'event-agent-end-waiting',
        session_id: cocoSessionId,
        agent_id: 'agent-lead',
        agent_name: 'TraeCli',
        parent_tool_call_id: '',
        created_at: agentEndAt,
        agent_end: {
          output: {
            role: 'assistant',
            content: 'Done. Waiting for your next instruction.',
          },
        },
      },
    ]);
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'traces.jsonl'), []);

    const snapshots = await buildBataWorkflowSnapshots(stateRoot, { cocoSessionsRoot });

    expect(snapshots).toEqual([
      expect.objectContaining({
        monitorSessionId: `monitor:${rootSessionId}`,
        state: expect.objectContaining({
          actors: [expect.objectContaining({ status: 'idle' })],
          timeline: expect.arrayContaining([
            expect.objectContaining({ eventType: 'actor.completed', status: 'done' }),
            expect.objectContaining({ eventType: 'session.updated', status: 'idle', summary: 'waiting for user input' }),
          ]),
        }),
      }),
    ]);
    expect(snapshots[0]?.state.timeline.some((event) => event.summary === 'live session disconnected')).toBe(false);
  });

  it('keeps the session active past stale cutoff when an agent is still running', async () => {
    const stateRoot = createTempStateRoot();
    const cocoSessionsRoot = resolve(createTempStateRoot(), 'coco-sessions');
    const rootSessionId = 'coco-live-agent-running';
    const cocoSessionId = 'coco-live-agent-running';
    const staleNow = Date.now() - 120_000;
    const staleCreatedAt = new Date(staleNow - 180_000).toISOString();
    const staleUpdatedAt = new Date(staleNow - 90_000).toISOString();
    const staleAgentStartAt = new Date(staleNow - 95_000).toISOString();

    writeJson(resolve(stateRoot, 'monitor-board', 'runtime.json'), {
      activeRootSessionIds: [rootSessionId],
    });
    writeJson(resolve(stateRoot, 'monitor-sessions', `${encodeURIComponent(rootSessionId)}.json`), {
      rootSessionId,
      monitorSessionId: `monitor:${rootSessionId}`,
      ownerActorId: 'lead',
      status: 'active',
      cocoSessionId,
      workspaceRoot: '/tmp/workspace-coco-agent-running',
      createdAt: staleCreatedAt,
      updatedAt: staleCreatedAt,
    });

    writeJson(resolve(cocoSessionsRoot, cocoSessionId, 'session.json'), {
      id: cocoSessionId,
      created_at: staleCreatedAt,
      updated_at: staleUpdatedAt,
      metadata: {
        cwd: '/tmp/workspace-coco-agent-running',
        model_name: 'gpt-5.4',
        title: 'Agent still running',
      },
    });
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'events.jsonl'), [
      {
        id: 'event-agent-start-running',
        session_id: cocoSessionId,
        agent_id: 'agent-lead',
        agent_name: 'TraeCli',
        parent_tool_call_id: '',
        created_at: staleAgentStartAt,
        agent_start: {
          input: [
            {
              type: 'text',
              text: 'Long-running execution still active',
            },
          ],
        },
      },
    ]);
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'traces.jsonl'), []);

    const snapshots = await buildBataWorkflowSnapshots(stateRoot, { cocoSessionsRoot });

    expect(snapshots).toEqual([
      expect.objectContaining({
        monitorSessionId: `monitor:${rootSessionId}`,
        state: expect.objectContaining({
          actors: [expect.objectContaining({ status: 'active' })],
          timeline: expect.arrayContaining([
            expect.objectContaining({ eventType: 'action.started', status: 'active' }),
          ]),
        }),
      }),
    ]);
    expect(snapshots[0]?.state.timeline.some((event) => event.summary === 'live session disconnected')).toBe(false);
  });

  it('marks the session disconnected when the bound Coco session data is no longer available', async () => {
    const stateRoot = createTempStateRoot();
    const cocoSessionsRoot = resolve(createTempStateRoot(), 'coco-sessions');
    const rootSessionId = 'coco-live-A';
    const cocoSessionId = 'coco-live-A';

    writeJson(resolve(stateRoot, 'monitor-board', 'runtime.json'), {
      activeRootSessionIds: [rootSessionId],
    });
    writeJson(resolve(stateRoot, 'monitor-sessions', `${encodeURIComponent(rootSessionId)}.json`), {
      rootSessionId,
      monitorSessionId: `monitor:${rootSessionId}`,
      ownerActorId: 'lead',
      status: 'active',
      cocoSessionId,
      workspaceRoot: '/tmp/workspace-shared',
      createdAt: '2026-04-23T10:00:00.000Z',
      updatedAt: '2026-04-23T10:00:10.000Z',
    });

    const snapshots = await buildBataWorkflowSnapshots(stateRoot, { cocoSessionsRoot });

    expect(snapshots).toEqual([
      expect.objectContaining({
        monitorSessionId: `monitor:${rootSessionId}`,
        state: expect.objectContaining({
          actors: [expect.objectContaining({ status: 'disconnected' })],
          timeline: [expect.objectContaining({ status: 'disconnected', summary: 'live session disconnected' })],
        }),
      }),
    ]);
  });

  it('keeps a disconnected session and lease until explicit session cleanup by default', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-04-23T10:00:00.000Z');
    vi.setSystemTime(now);

    const stateRoot = createTempStateRoot();
    const cocoSessionsRoot = resolve(createTempStateRoot(), 'coco-sessions');
    const rootSessionId = 'coco-live-A';
    const cocoSessionId = 'coco-live-A';
    const sessionStatePath = resolve(stateRoot, 'monitor-sessions', `${encodeURIComponent(rootSessionId)}.json`);
    const runtimeStatePath = resolve(stateRoot, 'monitor-board', 'runtime.json');

    writeJson(runtimeStatePath, {
      activeRootSessionIds: [rootSessionId],
    });
    writeJson(sessionStatePath, {
      rootSessionId,
      monitorSessionId: `monitor:${rootSessionId}`,
      ownerActorId: 'lead',
      status: 'active',
      cocoSessionId,
      workspaceRoot: '/tmp/workspace-shared',
      createdAt: '2026-04-23T09:58:00.000Z',
      updatedAt: '2026-04-23T09:58:30.000Z',
    });
    writeJson(resolve(cocoSessionsRoot, cocoSessionId, 'session.json'), {
      id: cocoSessionId,
      created_at: '2026-04-23T09:58:00.000Z',
      updated_at: '2026-04-23T09:58:20.000Z',
      metadata: {
        cwd: '/tmp/workspace-shared',
        model_name: 'gpt-5.4',
        title: 'Closed session',
      },
    });
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'events.jsonl'), [
      {
        id: 'event-tool-call',
        session_id: cocoSessionId,
        agent_id: 'agent-lead',
        agent_name: 'TraeCli',
        parent_tool_call_id: '',
        created_at: '2026-04-23T09:58:25.000Z',
        tool_call: {
          tool_call_id: 'tool-call-1',
          tool_info: {
            name: 'Skill',
          },
        },
      },
      {
        id: 'event-tool-result',
        session_id: cocoSessionId,
        agent_id: 'agent-lead',
        agent_name: 'TraeCli',
        parent_tool_call_id: '',
        created_at: '2026-04-23T09:58:26.000Z',
        tool_call_output: {
          tool_call_id: 'tool-call-1',
        },
      },
    ]);
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'traces.jsonl'), []);

    const disconnectedSnapshots = await buildBataWorkflowSnapshots(stateRoot, { cocoSessionsRoot });

    expect(disconnectedSnapshots).toEqual([
      expect.objectContaining({
        monitorSessionId: `monitor:${rootSessionId}`,
        state: expect.objectContaining({
          actors: [expect.objectContaining({ status: 'disconnected' })],
        }),
      }),
    ]);

    expect(JSON.parse(readFileSync(sessionStatePath, 'utf8'))).toMatchObject({
      status: 'disconnected',
    });
    expect(JSON.parse(readFileSync(runtimeStatePath, 'utf8'))).toMatchObject({
      activeRootSessionIds: [rootSessionId],
    });

    vi.setSystemTime(new Date(now.getTime() + 61_000));

    const delayedSnapshots = await buildBataWorkflowSnapshots(stateRoot, { cocoSessionsRoot });

    expect(delayedSnapshots).toEqual([
      expect.objectContaining({
        monitorSessionId: `monitor:${rootSessionId}`,
        state: expect.objectContaining({
          actors: [expect.objectContaining({ status: 'disconnected' })],
        }),
      }),
    ]);
    expect(existsSync(sessionStatePath)).toBe(true);
    expect(JSON.parse(readFileSync(runtimeStatePath, 'utf8'))).toMatchObject({
      activeRootSessionIds: [rootSessionId],
    });
  });

  it('does not release a disconnected session lease if fresh Coco activity resumes before cleanup runs', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-04-23T10:00:00.000Z');
    vi.setSystemTime(now);

    const stateRoot = createTempStateRoot();
    const cocoSessionsRoot = resolve(createTempStateRoot(), 'coco-sessions');
    const rootSessionId = 'coco-live-A';
    const cocoSessionId = 'coco-live-A';
    const sessionStatePath = resolve(stateRoot, 'monitor-sessions', `${encodeURIComponent(rootSessionId)}.json`);
    const runtimeStatePath = resolve(stateRoot, 'monitor-board', 'runtime.json');

    writeJson(runtimeStatePath, {
      activeRootSessionIds: [rootSessionId],
    });
    writeJson(sessionStatePath, {
      rootSessionId,
      monitorSessionId: `monitor:${rootSessionId}`,
      ownerActorId: 'lead',
      status: 'disconnected',
      cocoSessionId,
      workspaceRoot: '/tmp/workspace-shared',
      createdAt: '2026-04-23T09:50:00.000Z',
      updatedAt: '2026-04-23T09:51:00.000Z',
      disconnectedAt: '2026-04-23T09:51:00.000Z',
      cleanupAfter: '2026-04-23T09:52:00.000Z',
    });
    writeJson(resolve(cocoSessionsRoot, cocoSessionId, 'session.json'), {
      id: cocoSessionId,
      created_at: '2026-04-23T09:59:00.000Z',
      updated_at: '2026-04-23T09:59:55.000Z',
      metadata: {
        cwd: '/tmp/workspace-shared',
        model_name: 'gpt-5.4',
        title: 'Recovered session',
      },
    });
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'events.jsonl'), [
      {
        id: 'event-tool-call',
        session_id: cocoSessionId,
        agent_id: 'agent-lead',
        agent_name: 'TraeCli',
        parent_tool_call_id: '',
        created_at: '2026-04-23T09:59:56.000Z',
        tool_call: {
          tool_call_id: 'tool-call-1',
          tool_info: {
            name: 'Skill',
          },
        },
      },
    ]);
    writeJsonLines(resolve(cocoSessionsRoot, cocoSessionId, 'traces.jsonl'), []);

    const recoveredSnapshots = await buildBataWorkflowSnapshots(stateRoot, { cocoSessionsRoot });

    expect(recoveredSnapshots).toEqual([
      expect.objectContaining({
        monitorSessionId: `monitor:${rootSessionId}`,
        state: expect.objectContaining({
          timeline: expect.arrayContaining([
            expect.objectContaining({ eventType: 'tool.called', toolName: 'Skill', sessionId: cocoSessionId }),
          ]),
        }),
      }),
    ]);
    expect(existsSync(sessionStatePath)).toBe(true);
    expect(JSON.parse(readFileSync(sessionStatePath, 'utf8'))).toMatchObject({
      status: 'active',
    });
    expect(JSON.parse(readFileSync(runtimeStatePath, 'utf8'))).toMatchObject({
      activeRootSessionIds: [rootSessionId],
    });
  });

  it('builds a live monitor snapshot from the newest matching bata-workflow run', async () => {
    const stateRoot = createTempStateRoot();
    const olderRunDirectory = resolve(stateRoot, 'runs', '1000-older-run');
    const latestRunDirectory = resolve(stateRoot, 'runs', '1001-latest-run');

    writeJson(resolve(stateRoot, 'monitor-board', 'runtime.json'), {
      activeRootSessionIds: ['workspace-1'],
    });

    writeJson(resolve(olderRunDirectory, 'queue.json'), {
      goal: 'older goal',
      createdAt: '2026-04-18T09:59:00.000Z',
      updatedAt: '2026-04-18T10:00:00.000Z',
      taskOrder: ['T1'],
      events: [],
      monitor: {
        rootSessionId: 'workspace-1',
        monitorSessionId: 'monitor:workspace-1',
        workspaceRoot: '/tmp/workspace-1',
      },
    });
    writeJson(resolve(olderRunDirectory, 'task-store.json'), {
      assignments: [
        {
          task: {
            id: 'T1',
            title: 'Older task',
            role: 'coder',
            taskType: 'coding',
            generatedFromTaskId: null,
          },
          executionTarget: {
            model: 'gpt-5.4',
          },
        },
      ],
      taskStates: [
        {
          taskId: 'T1',
          status: 'completed',
          phase: 'completed',
          phaseDetail: null,
          claimedBy: null,
          attempts: 1,
          lastError: null,
          lastClaimedAt: '2026-04-18T09:59:10.000Z',
          releasedAt: '2026-04-18T09:59:40.000Z',
          lastUpdatedAt: '2026-04-18T09:59:40.000Z',
          attemptHistory: [
            {
              startedAt: '2026-04-18T09:59:10.000Z',
              finishedAt: '2026-04-18T09:59:40.000Z',
            },
          ],
        },
      ],
      results: [{ taskId: 'T1', summary: 'older result' }],
    });

    writeJson(resolve(latestRunDirectory, 'queue.json'), {
      goal: 'ship live monitor bridge',
      createdAt: '2026-04-18T10:00:00.000Z',
      updatedAt: '2026-04-18T10:02:00.000Z',
      taskOrder: ['T1', 'T2'],
      events: [
        {
          type: 'run-started',
          batchId: 'RUN',
          detail: 'started live bridge run',
          createdAt: '2026-04-18T10:00:00.000Z',
        },
        {
          type: 'task-start',
          batchId: 'B1',
          taskId: 'T1',
          detail: 'worker started T1',
          createdAt: '2026-04-18T10:00:10.000Z',
        },
        {
          type: 'task-complete',
          batchId: 'B1',
          taskId: 'T2',
          detail: 'worker completed T2',
          createdAt: '2026-04-18T10:01:15.000Z',
        },
      ],
      monitor: {
        rootSessionId: 'workspace-1',
        monitorSessionId: 'monitor:workspace-1',
        workspaceRoot: '/tmp/workspace-1',
      },
    });
    writeJson(resolve(latestRunDirectory, 'task-store.json'), {
      assignments: [
        {
          task: {
            id: 'T1',
            title: 'Implement websocket bridge',
            role: 'coder',
            taskType: 'coding',
            generatedFromTaskId: null,
          },
          executionTarget: {
            model: 'gpt-5.4',
          },
        },
        {
          task: {
            id: 'T2',
            title: 'Verify live snapshot wiring',
            role: 'tester',
            taskType: 'testing',
            generatedFromTaskId: 'T1',
          },
          executionTarget: {
            model: 'gpt-5.4-mini',
          },
        },
      ],
      taskStates: [
        {
          taskId: 'T1',
          status: 'in_progress',
          phase: 'running',
          phaseDetail: 'streaming live data to the board',
          claimedBy: 'W1',
          attempts: 1,
          lastError: null,
          lastClaimedAt: '2026-04-18T10:00:10.000Z',
          releasedAt: null,
          lastUpdatedAt: '2026-04-18T10:02:00.000Z',
          attemptHistory: [
            {
              startedAt: '2026-04-18T10:00:10.000Z',
              finishedAt: null,
            },
          ],
        },
        {
          taskId: 'T2',
          status: 'completed',
          phase: 'completed',
          phaseDetail: null,
          claimedBy: null,
          attempts: 1,
          lastError: null,
          lastClaimedAt: '2026-04-18T10:00:45.000Z',
          releasedAt: '2026-04-18T10:01:15.000Z',
          lastUpdatedAt: '2026-04-18T10:01:15.000Z',
          attemptHistory: [
            {
              startedAt: '2026-04-18T10:00:45.000Z',
              finishedAt: '2026-04-18T10:01:15.000Z',
            },
          ],
        },
      ],
      results: [{ taskId: 'T2', summary: 'live bridge verified' }],
    });

    const snapshots = await buildBataWorkflowSnapshots(stateRoot);

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      monitorSessionId: 'monitor:workspace-1',
      actorCount: 3,
      timelineCount: 3,
      stats: {
        actorCount: 3,
        activeCount: 2,
        blockedCount: 0,
        totalTokens: 0,
      },
    });
    expect(snapshots[0]?.state.actors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'lead:workspace-1', actorType: 'lead', status: 'active' }),
        expect.objectContaining({ id: 'T1', actorType: 'subagent', status: 'active' }),
        expect.objectContaining({ id: 'T2', actorType: 'worker', status: 'done', parentActorId: 'T1' }),
      ]),
    );
    expect(snapshots[0]?.state.timeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorId: 'lead:workspace-1', eventType: 'session.started' }),
        expect.objectContaining({ actorId: 'T1', eventType: 'action.started' }),
        expect.objectContaining({ actorId: 'T2', eventType: 'actor.completed' }),
      ]),
    );
  });
});
