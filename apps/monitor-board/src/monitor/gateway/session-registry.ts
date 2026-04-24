import type { BoardEvent } from '../protocol';
import {
  createInitialBoardState,
  reduceBoardEvent,
  selectTopBarStats,
  type ActorNode,
  type BoardState,
} from '../runtime-store';

export interface SessionSnapshotState {
  actors: ActorNode[];
  timeline: BoardEvent[];
}

export interface SessionSnapshot {
  monitorSessionId: string;
  stats: ReturnType<typeof selectTopBarStats>;
  actorCount: number;
  timelineCount: number;
  state: SessionSnapshotState;
}

const serializeBoardState = (state: BoardState): SessionSnapshotState => ({
  actors: [...state.actors.values()].map((actor) => ({
    ...actor,
    children: [...actor.children],
  })),
  timeline: [...state.timeline],
});

export class SessionRegistry {
  private readonly monitorByRoot = new Map<string, string>();
  private readonly stateByMonitor = new Map<string, BoardState>();

  private toSnapshot(monitorSessionId: string, state: BoardState): SessionSnapshot {
    return {
      monitorSessionId,
      stats: selectTopBarStats(state),
      actorCount: state.actors.size,
      timelineCount: state.timeline.length,
      state: serializeBoardState(state),
    };
  }

  ensureMonitorSession(rootSessionId: string) {
    const current = this.monitorByRoot.get(rootSessionId);

    if (current) {
      return current;
    }

    const monitorSessionId = `monitor:${rootSessionId}`;
    this.monitorByRoot.set(rootSessionId, monitorSessionId);
    this.stateByMonitor.set(monitorSessionId, createInitialBoardState());
    return monitorSessionId;
  }

  append(event: BoardEvent): SessionSnapshot {
    const currentState = this.stateByMonitor.get(event.monitorSessionId) ?? createInitialBoardState();
    const nextState = reduceBoardEvent(currentState, event);

    this.stateByMonitor.set(event.monitorSessionId, nextState);

    return this.toSnapshot(event.monitorSessionId, nextState);
  }

  getSnapshot(monitorSessionId: string): SessionSnapshot | undefined {
    const state = this.stateByMonitor.get(monitorSessionId);

    if (!state) {
      return undefined;
    }

    return this.toSnapshot(monitorSessionId, state);
  }

  listSnapshots(): SessionSnapshot[] {
    return [...this.stateByMonitor.entries()].map(([monitorSessionId, state]) => this.toSnapshot(monitorSessionId, state));
  }
}
