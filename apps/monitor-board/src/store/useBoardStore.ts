import { create } from 'zustand';

export type BoardMode = 'metadata' | 'summary';
export type BoardPanelTab = 'timeline' | 'runTree' | 'progress';

interface BoardUiState {
  mode: BoardMode;
  activePanelTab: BoardPanelTab;
  selectedActorId: string | null;
  setMode: (mode: BoardMode) => void;
  setActivePanelTab: (tab: BoardPanelTab) => void;
  setSelectedActorId: (actorId: string | null) => void;
}

export const useBoardStore = create<BoardUiState>((set) => ({
  mode: 'summary',
  activePanelTab: 'timeline',
  selectedActorId: null,
  setMode: (mode) => set({ mode }),
  setActivePanelTab: (activePanelTab) => set({ activePanelTab }),
  setSelectedActorId: (selectedActorId) => set({ selectedActorId }),
}));
