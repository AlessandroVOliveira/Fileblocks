import type { Block, ScalarValue } from '../src/model/block';
import type { HostToWebview, WebviewToHost } from '../src/model/messages';

export interface RenderContext {
  post(message: WebviewToHost): void;
  isCollapsed(id: string): boolean;
  toggleCollapsed(id: string): void;
}

// Plain DOM for now; swap for a UI framework once the block interactions grow
// (drag & drop, add/remove, schema-driven inputs).
export function render(container: HTMLElement, update: HostToWebview, ctx: RenderContext): void {
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
}

function renderBlock(block: Block, ctx: RenderContext): HTMLElement {
  const node = el('div', `block block--${block.kind}`);
  const header = el('div', 'block-header');
  node.append(header);

  const isContainer = block.children !== undefined;
  const collapsed = isContainer && ctx.isCollapsed(block.id);

  if (isContainer) {
    const toggle = el('button', 'block-toggle', collapsed ? '▸' : '▾');
    toggle.addEventListener('click', () => ctx.toggleCollapsed(block.id));
    header.append(toggle);
  }

  if (block.label !== undefined) {
    header.append(el('span', typeof block.label === 'number' ? 'block-index' : 'block-key', String(block.label)));
  }

  if (block.kind === 'scalar') {
    header.append(renderScalarInput(block, ctx));
  } else if (isContainer) {
    const count = block.children!.length;
    header.append(el('span', 'block-summary', block.kind === 'array' ? `[${count}]` : `{${count}}`));
  }

  if (isContainer && !collapsed) {
    const children = el('div', 'block-children');
    for (const child of block.children!) {
      children.append(renderBlock(child, ctx));
    }
    node.append(children);
  }

  return node;
}

function renderScalarInput(block: Block, ctx: RenderContext): HTMLElement {
  const value = block.value ?? null;
  const send = (next: ScalarValue) => ctx.post({ type: 'edit', edit: { type: 'setValue', path: block.path, value: next } });

  if (typeof value === 'boolean') {
    const input = el('input', 'block-value block-value--boolean');
    input.type = 'checkbox';
    input.checked = value;
    input.disabled = !!block.readOnly;
    input.addEventListener('change', () => send(input.checked));
    return input;
  }

  const input = el('input', `block-value block-value--${value === null ? 'null' : typeof value}`);
  input.value = value === null ? 'null' : String(value);
  input.readOnly = !!block.readOnly;
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
