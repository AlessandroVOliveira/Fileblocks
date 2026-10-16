import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useEffect, useState, type DragEvent, type KeyboardEvent } from 'react';
import type { Block, ScalarValue } from '../../src/model/block';
import { useActions, useSearchHighlight, type EditorActions, type SearchHighlight } from '../actions';
import { displayValue, HEADER_HEIGHT, nodeId, nodeTitle, ROW_HEIGHT, summary } from './buildGraph';
import type { BlockFlowNode } from './layout';

// `nodrag nopan` stop React Flow from treating clicks/drags on interactive parts as canvas panning.
const INTERACTIVE = 'nodrag nopan';

export function BlockNode({ data }: NodeProps<BlockFlowNode>) {
  const { block, parent, width, height } = data;
  const actions = useActions();
  const search = useSearchHighlight();
  const isContainer = block.children !== undefined;
  const rows = block.children ?? [];

  return (
    <div className={`gnode gnode--${block.kind}`} style={{ width, height }}>
      {parent && <Handle type="target" position={Position.Left} isConnectable={false} style={{ top: HEADER_HEIGHT / 2 }} />}

      <div
        className={`gnode-header${isContainer && search.matchIds.has(block.id) ? ' gnode-header--match' : ''}`}
        style={{ height: HEADER_HEIGHT }}
      >
        <span className="gnode-title" title={nodeTitle(block)}>{nodeTitle(block)}</span>
        {isContainer && <span className="gnode-summary">{summary(block)}</span>}
        <span className={`gnode-actions ${INTERACTIVE}`}>
          {isContainer && (
            <ActionButton
              text="+"
              title={block.kind === 'array' ? 'Add item' : 'Add entry'}
              onClick={() => actions.post({ type: 'add', parentPath: block.path })}
            />
          )}
          {parent?.kind === 'object' && <ActionButton text="✎" title="Rename" onClick={() => rename(actions, block)} />}
          {parent && <ActionButton text="×" title="Remove" onClick={() => remove(actions, block)} />}
        </span>
      </div>

      {!isContainer && (
        <div className={`gnode-row ${INTERACTIVE}${matchClass(search, block)}`} style={{ height: ROW_HEIGHT }}>
          <ScalarInput block={block} />
        </div>
      )}
      {isContainer && rows.length === 0 && (
        <div className="gnode-row gnode-empty" style={{ height: ROW_HEIGHT }}>
          empty
        </div>
      )}
      {rows.map((child, index) => (
        <Row key={child.id} child={child} node={block} index={index} />
      ))}
    </div>
  );
}

interface DragSource {
  child: Block;
  node: Block;
  index: number;
}

/** Rows can only be dropped among their siblings: reordering never changes a block's parent. */
let dragSource: DragSource | undefined;

function Row({ child, node, index }: { child: Block; node: Block; index: number }) {
  const actions = useActions();
  const search = useSearchHighlight();
  const isContainer = child.children !== undefined;
  const collapsed = isContainer && actions.isCollapsed(child.id);
  const canRename = node.kind === 'object';
  const accepts = () => dragSource?.node.id === node.id;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      move(actions, child, node, index, index + (e.key === 'ArrowUp' ? -1 : 1));
    }
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!accepts()) {
      return;
    }
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    e.currentTarget.classList.toggle('drop-before', before);
    e.currentTarget.classList.toggle('drop-after', !before);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!dragSource || !accepts()) {
      return;
    }
    e.preventDefault();
    const insertAt = e.currentTarget.classList.contains('drop-before') ? index : index + 1;
    clearDropIndicator(e.currentTarget);
    // insertAt counts the dragged row itself; toIndex is its position once removed.
    const toIndex = insertAt > dragSource.index ? insertAt - 1 : insertAt;
    move(actions, dragSource.child, dragSource.node, dragSource.index, toIndex);
  };

  return (
    <div
      className={`gnode-row ${INTERACTIVE}${matchClass(search, child)}`}
      style={{ height: ROW_HEIGHT }}
      onKeyDown={onKeyDown}
      onDragOver={onDragOver}
      onDragLeave={(e) => clearDropIndicator(e.currentTarget)}
      onDrop={onDrop}
    >
      <span
        className="row-handle"
        title="Drag to reorder (Alt+↑/↓)"
        draggable
        onDragStart={(e) => {
          dragSource = { child, node, index };
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', child.id);
        }}
        onDragEnd={() => {
          dragSource = undefined;
          document.querySelectorAll('.drop-before, .drop-after').forEach(clearDropIndicator);
        }}
      >
        ⠿
      </span>
      <span
        className={typeof child.label === 'number' ? 'row-index' : 'row-key'}
        title={canRename ? 'Double-click to rename' : undefined}
        onDoubleClick={canRename ? () => rename(actions, child) : undefined}
      >
        {String(child.label)}
      </span>
      {isContainer ? (
        <button className="row-summary" title={collapsed ? 'Expand' : 'Collapse'} onClick={() => actions.toggleCollapsed(child.id)}>
          {summary(child)} {collapsed ? '▸' : '▾'}
        </button>
      ) : (
        <ScalarInput block={child} />
      )}
      <span className="row-actions">
        {canRename && <ActionButton text="✎" title="Rename" onClick={() => rename(actions, child)} />}
        <ActionButton text="×" title="Remove" onClick={() => remove(actions, child)} />
      </span>
      {isContainer && !collapsed && (
        <Handle
          type="source"
          position={Position.Right}
          id={nodeId(child)}
          isConnectable={false}
          style={{ top: HEADER_HEIGHT + index * ROW_HEIGHT + ROW_HEIGHT / 2 }}
        />
      )}
    </div>
  );
}

function matchClass(search: SearchHighlight, block: Block): string {
  if (search.activeId === block.id) {
    return ' row--match row--active';
  }
  return search.matchIds.has(block.id) ? ' row--match' : '';
}

function ScalarInput({ block }: { block: Block }) {
  return typeof block.value === 'boolean' ? <BooleanInput block={block} value={block.value} /> : <TextInput block={block} />;
}

function BooleanInput({ block, value }: { block: Block; value: boolean }) {
  const actions = useActions();
  return (
    <input
      type="checkbox"
      className="value value--boolean"
      checked={value}
      disabled={block.readOnly}
      onChange={(e) => setValue(actions, block, e.target.checked)}
    />
  );
}

/** Local draft so typing doesn't round-trip through the document; commits on Enter or blur. */
function TextInput({ block }: { block: Block }) {
  const actions = useActions();
  const value = block.value ?? null;
  const text = displayValue(block);
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);

  return (
    <input
      type="text"
      className={`value value--${value === null ? 'null' : typeof value}`}
      value={draft}
      title={text}
      readOnly={block.readOnly}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== text) {
          setValue(actions, block, coerce(draft, value));
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setDraft(text);
        }
      }}
    />
  );
}

function ActionButton({ text, title, onClick }: { text: string; title: string; onClick: () => void }) {
  return (
    <button className="action" title={title} onClick={onClick}>
      {text}
    </button>
  );
}

function setValue(actions: EditorActions, block: Block, value: ScalarValue): void {
  actions.post({ type: 'edit', edit: { type: 'setValue', path: block.path, value } });
}

function rename(actions: EditorActions, block: Block): void {
  actions.post({ type: 'rename', path: block.path });
}

function remove(actions: EditorActions, block: Block): void {
  actions.post({ type: 'edit', edit: { type: 'remove', path: block.path } });
}

function move(actions: EditorActions, child: Block, node: Block, index: number, toIndex: number): void {
  const count = node.children?.length ?? 0;
  if (toIndex !== index && toIndex >= 0 && toIndex < count) {
    actions.post({ type: 'edit', edit: { type: 'move', path: child.path, toIndex } });
  }
}

/** Keep the original type when the new text still fits it (e.g. "42" stays a number). */
function coerce(raw: string, previous: ScalarValue): ScalarValue {
  if (typeof previous === 'number' && raw.trim() !== '' && !Number.isNaN(Number(raw))) {
    return Number(raw);
  }
  if (previous === null && raw === 'null') {
    return null;
  }
  return raw;
}

function clearDropIndicator(element: Element): void {
  element.classList.remove('drop-before', 'drop-after');
}
