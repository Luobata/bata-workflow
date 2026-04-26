import React, { useEffect, useRef } from 'react';
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

interface TimelinePanelProps {
  entries: TimelineEntry[];
  focusLabel: string;
  focusDetail: string;
}

export const TimelinePanel = ({ entries, focusLabel, focusDetail }: TimelinePanelProps) => {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const autoStickToBottomRef = useRef(true);
  const rowHeight = 72;

  const rowVirtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 3,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const renderedRows = virtualRows.length
    ? virtualRows.map((virtualRow) => ({
        key: virtualRow.key,
        entry: entries[virtualRow.index],
        start: virtualRow.start,
      }))
    : entries.map((entry, index) => ({
        key: entry.id,
        entry,
        start: index * rowHeight,
      }));

  useEffect(() => {
    const parent = parentRef.current;
    if (!parent || entries.length === 0) {
      return;
    }

    if (!autoStickToBottomRef.current) {
      return;
    }

    rowVirtualizer.scrollToIndex(entries.length - 1, { align: 'end' });
  }, [entries.length, rowVirtualizer]);

  const handleTimelineScroll: React.UIEventHandler<HTMLDivElement> = (event) => {
    const element = event.currentTarget;
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    autoStickToBottomRef.current = distanceToBottom <= 20;
  };

  return (
    <section className="pixel-panel board-panel">
      <div className="panel-section timeline-panel">
        <h2 className="panel-title">TIMELINE</h2>
        <div className="timeline-focus-banner" role="status" aria-label="Timeline focus lock">
          <strong className="timeline-focus-label">{focusLabel}</strong>
          <span className="timeline-focus-detail">{focusDetail}</span>
        </div>
        <div ref={parentRef} className="timeline-scroll" aria-label="Timeline" onScroll={handleTimelineScroll}>
          <div className="timeline-virtual-space" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
            {renderedRows.map(({ key, entry, start }) => (
              <div
                key={key}
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
