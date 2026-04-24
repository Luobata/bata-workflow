import React from 'react';

export interface RunTreeNode {
  id: string;
  name: string;
  role: string;
  status: string;
  progressPercent: number;
  children?: RunTreeNode[];
}

interface RunTreeProps {
  nodes: RunTreeNode[];
  selectedActorId: string | null;
}

const TreeBranch = ({ node, selectedActorId, depth }: { node: RunTreeNode; selectedActorId: string | null; depth: number }) => {
  const isSelected = node.id === selectedActorId;

  return (
    <li role="treeitem" aria-selected={isSelected} aria-level={depth + 1}>
      <div
        className={`run-tree-item${isSelected ? ' is-selected' : ''}`}
        data-role={node.role}
        data-status={node.status}
        data-depth={depth}
        style={{ paddingLeft: `${depth * 14}px` }}
      >
        <span className="run-tree-lane" aria-hidden="true">
          <span className="run-tree-node-core" />
        </span>
        <span className="run-tree-node-copy">
          <span className="run-tree-node-head">
            <span className="run-tree-node-name">{node.name}</span>
            <span className="run-tree-role">{node.role}</span>
          </span>
          <span className="run-tree-node-progress">
            <span className="run-tree-node-progress-track" aria-hidden="true">
              <span className="run-tree-node-progress-fill" style={{ width: `${node.progressPercent}%` }} />
            </span>
            <span className="run-tree-node-progress-label">{node.progressPercent}%</span>
          </span>
        </span>
        <span className="run-tree-node-state">{node.status}</span>
      </div>
      {node.children?.length ? (
        <ul className="run-tree-list" role="group">
          {node.children.map((child) => (
            <TreeBranch key={child.id} node={child} selectedActorId={selectedActorId} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
};

export const RunTree = ({ nodes, selectedActorId }: RunTreeProps) => {
  return (
    <section className="pixel-panel board-panel">
      <div className="panel-section">
        <h2 className="panel-title">RUN TREE</h2>
        <ul className="run-tree-list" role="tree" aria-label="Run tree">
          {nodes.map((node) => (
            <TreeBranch key={node.id} node={node} selectedActorId={selectedActorId} depth={0} />
          ))}
        </ul>
      </div>
    </section>
  );
};
