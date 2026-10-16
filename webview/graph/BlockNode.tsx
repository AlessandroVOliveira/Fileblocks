import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useEffect, useState, type DragEvent, type KeyboardEvent } from 'react';
import type { Block, ScalarValue } from '../../src/model/block';
import { useActions, useHighlight, type EditorActions, type Highlight } from '../actions';
import { displayValue, HEADER_HEIGHT, nodeId, nodeTitle, ROW_HEIGHT, rowLabel, summary } from './buildGraph';
import type { BlockFlowNode } from './layout';

// `nodrag nopan` stop React Flow from treating clicks/drags on interactive parts as canvas panning.
const INTERACTIVE = 'nodrag nopan';

export function BlockNode({ data }: NodeProps<BlockFlowNode>) {
  const { block, parent, width, height } = data;
  const actions = useActions();
  const highlight = useHighlight();
  const isContainer = block.children !== undefined;
  const rows = block.children ?? [];

  return (
    <div className={`gnode gnode--${block.kind}${highlight.selectedId === block.id ? ' gnode--selected' : ''}`} style={{ width, height }}>
      {parent && <Handle type="target" position={Position.Left} isConnectable={false} style={{ top: HEADER_HEIGHT / 2 }} />}

      <div
        className={`gnode-header${isContainer && highlight.matchIds.has(block.id) ? ' gnode-header--match' : ''}`}
        style={{ height: HEADER_HEIGHT }}
      >
        <span className="gnode-title" title={`${nodeTitle(block)} · Click to show in text`} onClick={() => reveal(actions, block)}>
          {nodeTitle(block)}
        </span>
        {isContainer && <span className="gnode-summary">{summary(block)}</span>}
        <span className={`gnode-actions ${INTERACTIVE}`}>
          {isContainer && !block.readOnly && (
            <ActionButton
              text="+"
              title={block.kind === 'array' ? 'Add item' : block.kind === 'element' ? 'Add child, attribute or text' : 'Add entry'}
              onClick={() => actions.post({ type: 'add', parentPath: block.path })}
            />
          )}
          {canChangeType(block) && <ActionButton text="⇄" title="Change type" onClick={() => changeType(actions, block)} />}
          {canRename(block, parent) && <ActionButton text="✎" title="Rename" onClick={() => rename(actions, block)} />}
          {parent && !parent.readOnly && <ActionButton text="×" title="Remove" onClick={() => remove(actions, block)} />}
        </span>
      </div>

      {!isContainer && (
        <div className={`gnode-row ${INTERACTIVE}${matchClass(highlight, block)}`} style={{ height: ROW_HEIGHT }}>
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
  const highlight = useHighlight();
  const isContainer = child.children !== undefined;
  const collapsed = isContainer && actions.isCollapsed(child.id);
  const renamable = canRename(child, node);
  // Rows of a read-only container (YAML documents, top-level HTML nodes) can't be moved or removed.
  const fixed = !!node.readOnly;
  // Attributes and element content are reordered separately: an attribute never moves among children.
  const accepts = () => !fixed && dragSource?.node.id === node.id && moveGroup(dragSource.child) === moveGroup(child);
  const siblings = node.children ?? [];

  const onKeyDown = (e: KeyboardEvent) => {
    if (!fixed && e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const toIndex = index + (e.key === 'ArrowUp' ? -1 : 1);
      if (siblings[toIndex] && moveGroup(siblings[toIndex]) === moveGroup(child)) {
        move(actions, child, node, index, toIndex);
      }
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
      className={`gnode-row ${INTERACTIVE}${matchClass(highlight, child)}`}
      style={{ height: ROW_HEIGHT }}
      onKeyDown={onKeyDown}
      onDragOver={onDragOver}
      onDragLeave={(e) => clearDropIndicator(e.currentTarget)}
      onDrop={onDrop}
    >
      <span
        className={`row-handle${fixed ? ' row-handle--fixed' : ''}`}
        title={fixed ? undefined : 'Drag to reorder (Alt+↑/↓)'}
        draggable={!fixed}
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
        className={rowKeyClass(child)}
        title={renamable ? 'Click to show in text · Double-click to rename' : 'Click to show in text'}
        onClick={() => reveal(actions, child)}
        onDoubleClick={renamable ? () => rename(actions, child) : undefined}
      >
        {rowLabel(child)}
      </span>
      {isContainer ? (
        <button className="row-summary" title={collapsed ? 'Expand' : 'Collapse'} onClick={() => actions.toggleCollapsed(child.id)}>
          {summary(child)} {collapsed ? '▸' : '▾'}
        </button>
      ) : child.value === undefined ? (
        // Void element (<br>): just the tag, nothing to edit.
        <span className="row-void" />
      ) : (
        <ScalarInput block={child} />
      )}
      <span className="row-actions">
        {child.kind === 'element' && !child.readOnly && (
          // Inline element (no card of its own): adding an attribute or child gives it a card.
          <ActionButton text="+" title="Add child, attribute or text" onClick={() => actions.post({ type: 'add', parentPath: child.path })} />
        )}
        {canChangeType(child) && <ActionButton text="⇄" title="Change type" onClick={() => changeType(actions, child)} />}
        {renamable && <ActionButton text="✎" title="Rename" onClick={() => rename(actions, child)} />}
        {!fixed && <ActionButton text="×" title="Remove" onClick={() => remove(actions, child)} />}
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

/** JSON/YAML values can switch type; XML/HTML elements, attributes and text can't. */
function canChangeType(block: Block): boolean {
  return !block.readOnly && (block.kind === 'object' || block.kind === 'array' || block.kind === 'scalar');
}

/** Object keys, attribute names and tag names can be renamed. */
function canRename(block: Block, parent: Block | undefined): boolean {
  return !block.readOnly && (parent?.kind === 'object' || block.kind === 'element' || block.kind === 'attribute');
}

function moveGroup(block: Block): 'attribute' | 'content' {
  return block.kind === 'attribute' ? 'attribute' : 'content';
}

function rowKeyClass(block: Block): string {
  if (block.kind === 'attribute') {
    return 'row-key row-key--attribute';
  }
  if (block.kind === 'element') {
    return 'row-key row-key--element';
  }
  return typeof block.label === 'number' ? 'row-index' : 'row-key';
}

function matchClass(highlight: Highlight, block: Block): string {
  let classes = '';
  if (highlight.matchIds.has(block.id)) {
    classes += highlight.activeId === block.id ? ' row--match row--active' : ' row--match';
  }
  if (highlight.selectedId === block.id) {
    classes += ' row--selected';
  }
  return classes;
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

function reveal(actions: EditorActions, block: Block): void {
  actions.post({ type: 'reveal', path: block.path });
}

function changeType(actions: EditorActions, block: Block): void {
  actions.post({ type: 'changeType', path: block.path });
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
