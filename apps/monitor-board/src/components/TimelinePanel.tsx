import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface TimelineEntry {
  id: string;
  actorId: string;
  actorName: string;
  actorType: string;
  status: string;
  timestamp: string;
  summary: string;
}

type ActorTypeFilter = 'all' | 'lead' | 'subagent' | 'worker';

const actorTypeFilterOptions: Array<{ id: ActorTypeFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'lead', label: 'Lead' },
  { id: 'subagent', label: 'Sub' },
  { id: 'worker', label: 'Worker' },
];

interface TimelinePanelProps {
  entries: TimelineEntry[];
  focusLabel: string;
  focusDetail: string;
}

export const TimelinePanel = ({ entries, focusLabel, focusDetail }: TimelinePanelProps) => {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const autoStickToBottomRef = useRef(true);
  const rowHeight = 72;
  const [actorFilter, setActorFilter] = useState<ActorTypeFilter>('all');

  const filteredEntries = actorFilter === 'all' ? entries : entries.filter((e) => e.actorType === actorFilter);

  const rowVirtualizer = useVirtualizer({
    count: filteredEntries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    measureElement: (el) => el.getBoundingClientRect().height,
    overscan: 3,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const renderedRows = virtualRows.length
    ? virtualRows.map((virtualRow) => ({
        key: virtualRow.key,
        index: virtualRow.index,
        entry: filteredEntries[virtualRow.index],
        start: virtualRow.start,
      }))
    : filteredEntries.map((entry, index) => ({
        key: entry.id,
        index,
        entry,
        start: index * rowHeight,
      }));

  const measureRef = useCallback(
    (el: HTMLDivElement | null, index: number) => {
      if (el) {
        rowVirtualizer.measureElement(el);
      }
    },
    [rowVirtualizer],
  );

  useEffect(() => {
    const parent = parentRef.current;
    if (!parent || filteredEntries.length === 0) {
      return;
    }

    if (!autoStickToBottomRef.current) {
      return;
    }

    rowVirtualizer.scrollToIndex(filteredEntries.length - 1, { align: 'end' });
  }, [filteredEntries.length, rowVirtualizer]);

  const handleTimelineScroll: React.UIEventHandler<HTMLDivElement> = (event) => {
    const element = event.currentTarget;
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    autoStickToBottomRef.current = distanceToBottom <= 20;
  };

  return (
    <section className="pixel-panel board-panel">
      <div className="panel-section timeline-panel">
        <div className="timeline-panel-head">
          <h2 className="panel-title">TIMELINE</h2>
          <div className="timeline-filter" role="group" aria-label="Filter timeline by actor type">
            {actorTypeFilterOptions.map((opt) => (
              <button
                key={opt.id}
                type="button"
                className={`mode-button timeline-filter-btn${actorFilter === opt.id ? ' is-active' : ''}`}
                onClick={() => setActorFilter(opt.id)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <div className="timeline-focus-banner" role="status" aria-label="Timeline focus lock">
          <strong className="timeline-focus-label">{focusLabel}</strong>
          <span className="timeline-focus-detail">{focusDetail}</span>
        </div>
        <div ref={parentRef} className="timeline-scroll" aria-label="Timeline" onScroll={handleTimelineScroll}>
          <div className="timeline-virtual-space" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
            {renderedRows.map(({ key, index, entry, start }) => (
              <div
                key={key}
                ref={(el) => measureRef(el, index)}
                data-index={index}
                className="timeline-row"
                data-actor-id={entry.actorId}
                data-actor-type={entry.actorType}
                data-status={entry.status}
                style={{ transform: `translateY(${start}px)` }}
              >
                <span className="timeline-rail" aria-hidden="true">
                  <span className="timeline-rail-core" />
                </span>
                <div className="timeline-body">
                  <div className="timeline-copy">
                    <div className="timeline-copy-head">
                      <span className="timeline-time">[{entry.timestamp}]</span>
                      <span className="timeline-actor">{entry.actorName}</span>
                    </div>
                    <div className="timeline-message">{entry.summary}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
