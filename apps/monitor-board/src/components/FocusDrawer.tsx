import React from 'react';

export interface FocusDrawerViewModel {
  title: string;
  focusLine: string;
  detailLines: string[];
  chips: string[];
}

interface FocusDrawerProps {
  viewModel: FocusDrawerViewModel;
}

export const FocusDrawer = ({ viewModel }: FocusDrawerProps) => {
  return (
    <section className="pixel-panel board-panel focus-drawer">
      <div className="panel-section">
        <div className="focus-shell">
          <div className="focus-shell-head">
            <h2 className="panel-title">{viewModel.title}</h2>
            <span className="focus-shell-status">Quest Window</span>
          </div>

          <div className="focus-chip-list" aria-label="Focus metadata">
            {viewModel.chips.map((chip, index) => (
              <span key={`${chip}-${index}`} className="focus-chip">
                {chip}
              </span>
            ))}
          </div>

          <div className="focus-dialog">
            <p className="focus-text">{viewModel.focusLine}</p>
            {viewModel.detailLines.map((line, index) => (
              <p key={`${line}-${index}`} className="focus-detail">
                {line}
              </p>
            ))}
            <div className="focus-dialog-footer">
              <span className="focus-dialog-action">A: Inspect</span>
              <span className="focus-dialog-action">B: Return</span>
              <span className="focus-dialog-cursor" aria-hidden="true">
                █
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
