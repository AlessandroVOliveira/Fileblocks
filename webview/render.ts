import { pathToId, type Block, type ScalarValue } from '../src/model/block';
import type { HostToWebview, WebviewToHost } from '../src/model/messages';

export interface RenderContext {
  post(message: WebviewToHost): void;
  isCollapsed(id: string): boolean;
  toggleCollapsed(id: string): void;
}

interface DragSource {
  block: Block;
  parent: Block;
  index: number;
}

let dragSource: DragSource | undefined;
/** Element to focus after the next render (e.g. the handle of a block that was just moved). */
let pendingFocusKey: string | undefined;

// Plain DOM for now; swap for a UI framework once the block interactions grow
// (schema-driven inputs, multi-select).
export function render(container: HTMLElement, update: HostToWebview, ctx: RenderContext): void {
  // Every update rebuilds the DOM, so remember what had focus and restore it afterwards.
  const focusKey = pendingFocusKey ?? (document.activeElement as HTMLElement | null)?.dataset?.focusKey;
  pendingFocusKey = undefined;

  const toolbar = el('div', 'toolbar');
  toolbar.append(el('span', 'format-badge', update.format.toUpperCase()));
  const openText = el('button', 'toolbar-button', 'Open as text');
  openText.addEventListener('click', () => ctx.post({ type: 'openText' }));
  toolbar.append(openText);

  const content: HTMLElement[] = [toolbar];

  if (update.errors.length > 0) {
    const errors = el('ul', 'errors');
    for (const error of update.errors) {
      const suffix = error.offset !== undefined ? ` (offset ${error.offset})` : '';
      errors.append(el('li', undefined, error.message + suffix));
    }
    content.push(errors);
  }

  if (update.root) {
    content.push(renderBlock(update.root, ctx));
  }

  container.replaceChildren(...content);

  if (focusKey) {
    const target = container.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusKey)}"]`);
    target?.focus();
    if (target instanceof HTMLInputElement && target.type === 'text') {
      target.setSelectionRange(target.value.length, target.value.length);
    }
  }
}

function renderBlock(block: Block, ctx: RenderContext, parent?: Block, index = 0): HTMLElement {
  const node = el('div', `block block--${block.kind}`);
  const header = el('div', 'block-header');
  node.append(header);

  const isContainer = block.children !== undefined;
  const collapsed = isContainer && ctx.isCollapsed(block.id);
  const canRename = parent?.kind === 'object';
  const rename = () => ctx.post({ type: 'rename', path: block.path });
  const remove = () => ctx.post({ type: 'edit', edit: { type: 'remove', path: block.path } });

  if (parent) {
    header.append(renderHandle(block, parent, index, node, ctx, { rename: canRename ? rename : undefined, remove }));
    attachDropTarget(node, parent, index, ctx);
    header.addEventListener('keydown', (e) => {
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        moveBlock(block, parent, index, index + (e.key === 'ArrowUp' ? -1 : 1), ctx);
      }
    });
  }

  if (isContainer) {
    const toggle = el('button', 'block-toggle', collapsed ? '▸' : '▾');
    toggle.title = collapsed ? 'Expand' : 'Collapse';
    toggle.addEventListener('click', () => ctx.toggleCollapsed(block.id));
    header.append(toggle);
  }

  if (block.label !== undefined) {
    const label = el('span', typeof block.label === 'number' ? 'block-index' : 'block-key', String(block.label));
    if (canRename) {
      label.title = 'Double-click to rename';
      label.addEventListener('dblclick', rename);
    }
    header.append(label);
  }

  if (block.kind === 'scalar') {
    header.append(renderScalarInput(block, ctx));
  } else if (isContainer) {
    const count = block.children!.length;
    header.append(el('span', 'block-summary', block.kind === 'array' ? `[${count}]` : `{${count}}`));
  }

  const actions = el('span', 'block-actions');
  if (isContainer) {
    actions.append(actionButton('+', block.kind === 'array' ? 'Add item' : 'Add entry', () => ctx.post({ type: 'add', parentPath: block.path })));
  }
  if (canRename) {
    actions.append(actionButton('✎', 'Rename (F2)', rename));
  }
  if (parent) {
    actions.append(actionButton('×', 'Remove (Delete)', remove));
  }
  header.append(actions);

  if (isContainer && !collapsed) {
    const children = el('div', 'block-children');
    block.children!.forEach((child, i) => children.append(renderBlock(child, ctx, block, i)));
    node.append(children);
  }

  return node;
}

function renderHandle(
  block: Block,
  parent: Block,
  index: number,
  node: HTMLElement,
  ctx: RenderContext,
  commands: { rename?: () => void; remove: () => void },
): HTMLElement {
  const handle = el('button', 'block-handle', '⠿');
  handle.title = 'Drag to reorder (Alt+↑/↓)';
  handle.draggable = true;
  handle.dataset.focusKey = `${block.id}:handle`;

  handle.addEventListener('keydown', (e) => {
    if (e.key === 'Delete') {
      e.preventDefault();
      commands.remove();
    } else if (e.key === 'F2' && commands.rename) {
      e.preventDefault();
      commands.rename();
    }
  });

  handle.addEventListener('dragstart', (e) => {
    dragSource = { block, parent, index };
    node.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', block.id);
      e.dataTransfer.setDragImage(node, 12, 12);
    }
  });
  handle.addEventListener('dragend', () => {
    dragSource = undefined;
    node.classList.remove('dragging');
    document.querySelectorAll('.drop-before, .drop-after').forEach(clearDropIndicator);
  });

  return handle;
}

/** Blocks only accept drops from siblings: reordering never changes a block's parent. */
function attachDropTarget(node: HTMLElement, parent: Block, index: number, ctx: RenderContext): void {
  const accepts = () => dragSource !== undefined && dragSource.parent.id === parent.id;

  node.addEventListener('dragover', (e) => {
    if (!accepts()) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const rect = node.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    node.classList.toggle('drop-before', before);
    node.classList.toggle('drop-after', !before);
  });

  node.addEventListener('dragleave', (e) => {
    if (!node.contains(e.relatedTarget as Node | null)) {
      clearDropIndicator(node);
    }
  });

  node.addEventListener('drop', (e) => {
    if (!dragSource || !accepts()) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const insertAt = node.classList.contains('drop-before') ? index : index + 1;
    clearDropIndicator(node);
    // insertAt counts the dragged block itself; toIndex is its position once removed.
    const toIndex = insertAt > dragSource.index ? insertAt - 1 : insertAt;
    moveBlock(dragSource.block, dragSource.parent, dragSource.index, toIndex, ctx);
  });
}

function moveBlock(block: Block, parent: Block, index: number, toIndex: number, ctx: RenderContext): void {
  const count = parent.children?.length ?? 0;
  if (toIndex === index || toIndex < 0 || toIndex >= count) {
    return;
  }
  // Array items are identified by index, so the moved block's id changes; object entries keep theirs.
  const newPath = parent.kind === 'array' ? [...parent.path, toIndex] : block.path;
  pendingFocusKey = `${pathToId(newPath)}:handle`;
  ctx.post({ type: 'edit', edit: { type: 'move', path: block.path, toIndex } });
}

function clearDropIndicator(element: Element): void {
  element.classList.remove('drop-before', 'drop-after');
}

function renderScalarInput(block: Block, ctx: RenderContext): HTMLElement {
  const value = block.value ?? null;
  const send = (next: ScalarValue) => ctx.post({ type: 'edit', edit: { type: 'setValue', path: block.path, value: next } });

  if (typeof value === 'boolean') {
    const input = el('input', 'block-value block-value--boolean');
    input.type = 'checkbox';
    input.checked = value;
    input.disabled = !!block.readOnly;
    input.dataset.focusKey = `${block.id}:value`;
    input.addEventListener('change', () => send(input.checked));
    return input;
  }

  const input = el('input', `block-value block-value--${value === null ? 'null' : typeof value}`);
  input.type = 'text';
  input.value = value === null ? 'null' : String(value);
  input.readOnly = !!block.readOnly;
  input.dataset.focusKey = `${block.id}:value`;
  input.addEventListener('change', () => send(coerce(input.value, value)));
  return input;
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

function actionButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const button = el('button', 'block-action', text);
  button.title = title;
  button.addEventListener('click', onClick);
  return button;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) {
    element.className = className;
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}
