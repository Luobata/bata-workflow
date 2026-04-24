import React from 'react';
import type { BoardMode } from '../store/useBoardStore';

interface TopBarStats {
  mission: string;
  progress: string;
  tokens: string;
  elapsed: string;
  actors: string;
  health: string;
}

interface TopBarOverallProgress {
  label: string;
  detail: string;
  percent: number;
  stage: string;
}

interface TopBarFocusedActor {
  name: string;
  role: string;
  status: string;
  stage: string;
  progressPercent: number;
  currentAction: string;
}

interface TopBarProps {
  mode: BoardMode;
  onModeChange: (mode: BoardMode) => void;
  stats: TopBarStats;
  overallProgress: TopBarOverallProgress;
  focusedActor: TopBarFocusedActor | null;
}

const metricOrder: Array<keyof TopBarStats> = ['mission', 'progress', 'tokens', 'elapsed', 'actors', 'health'];

export const TopBar = ({ mode, onModeChange, stats, overallProgress, focusedActor }: TopBarProps) => {
  return (
    <header className="pixel-panel board-header top-bar">
      <div className="top-bar-head">
        <div className="top-bar-banner" aria-hidden="true">
          <div className="top-bar-banner-copy">
            <span className="top-bar-banner-tag">PIXEL HUD</span>
            <span className="top-bar-banner-title">COMMAND DECK ONLINE</span>
          </div>
          <div className="top-bar-banner-lights">
            <span className="top-bar-banner-light is-green" />
            <span className="top-bar-banner-light is-gold" />
            <span className="top-bar-banner-light is-red" />
          </div>
        </div>

        <div className="top-bar-controls">
          <div className="mode-switch" role="group" aria-label="Board mode switch">
            <button
              type="button"
              className={`mode-button${mode === 'summary' ? ' is-active' : ''}`}
              onClick={() => onModeChange('summary')}
            >
              Summary
            </button>
            <button
              type="button"
              className={`mode-button${mode === 'metadata' ? ' is-active' : ''}`}
              onClick={() => onModeChange('metadata')}
            >
              Metadata
            </button>
          </div>
          <div className="mode-text">Mode: {mode}</div>
        </div>
      </div>

      <div className="top-bar-dashboard">
        <div className="top-bar-metrics">
          {metricOrder.map((key) => (
            <div key={key} className="top-bar-metric" data-key={key} data-value={stats[key]}>
              <span className="top-bar-label">{key.toUpperCase()}</span>
              <strong className="top-bar-value">{stats[key]}</strong>
            </div>
          ))}
        </div>

        <div className="top-bar-command-cluster">
          <div className="top-bar-progress-shell" aria-label="Overall quest progress">
            <div className="top-bar-progress-copy">
              <strong className="top-bar-progress-title">{overallProgress.label}</strong>
              <span className="top-bar-progress-stage">{overallProgress.stage}</span>
              <span className="top-bar-progress-detail">{overallProgress.detail}</span>
            </div>
            <div className="top-bar-progress-track" aria-hidden="true">
              <span className="top-bar-progress-fill" style={{ width: `${overallProgress.percent}%` }} />
            </div>
          </div>

          {focusedActor ? (
            <div className="top-bar-target-shell" role="group" aria-label="Active quest target">
              <div className="top-bar-target-copy">
                <span className="top-bar-target-label">ACTIVE TARGET</span>
                <strong className="top-bar-target-name">{focusedActor.name}</strong>
                <span className="top-bar-target-action">{focusedActor.currentAction}</span>
              </div>
              <div className="top-bar-target-meta" aria-label="Target status and stage">
                <span className="top-bar-target-chip">{focusedActor.role}</span>
                <span className="top-bar-target-chip" data-status={focusedActor.status}>{focusedActor.status}</span>
                <span className="top-bar-target-chip">{focusedActor.stage}</span>
                <span className="top-bar-target-chip">{focusedActor.progressPercent}%</span>
              </div>
              <div className="top-bar-target-track" aria-hidden="true">
                <span className="top-bar-target-fill" style={{ width: `${focusedActor.progressPercent}%` }} />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
};
