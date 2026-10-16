import type { ChildNode, Document as DomDocument, Element, Text } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { pathToId, type Block, type BlockPath } from '../model/block';
import type { BlockEdit } from '../model/messages';
import { detectEol, detectIndentUnit, lineIndentAt, rotateSpans, type Span } from './textEdits';
import type { FormatAdapter, TextChange } from './types';

/**
 * XML and HTML as blocks:
 * - an element is a block of kind 'element' (caption = tag name) whose children are its
 *   attributes (kind 'attribute', path segment '@name') followed by its content;
 * - content is child elements and non-blank text (kind 'text'), addressed by index;
 * - comments, processing instructions and blank text are not shown but stay in the file.
 *
 * Edits are applied to the text directly, so formatting, comments and entities elsewhere
 * are never touched.
 */
export function createMarkupAdapter(id: 'xml' | 'html'): FormatAdapter {
  const xmlMode = id === 'xml';
  const parse = (text: string) =>
    parseDocument(maskDoctype(text), { xmlMode, withStartIndices: true, withEndIndices: true, decodeEntities: true });

  return {
    id,

    parse(text) {
      const doc = parse(text);
      return { root: rootBlock(text, doc), errors: [] };
    },

    applyEdit(text, edit) {
      return applyMarkupEdit(text, parse(text), edit, xmlMode);
    },
  };
}

/**
 * htmlparser2 ends `<!DOCTYPE … [ internal subset ]>` at the first `>` inside the subset, leaking the
 * rest as text. The DOCTYPE is never shown as a block, so blank it out with spaces before parsing:
 * offsets of everything else stay the same.
 */
function maskDoctype(text: string): string {
  return text.replace(/<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>/i, (doctype) => doctype.replace(/[^\n]/g, ' '));
}

// ---------- source positions ----------

interface AttributeToken {
  name: string;
  /** Start of the whitespace before the attribute (removing [start, end) removes it cleanly). */
  start: number;
  nameStart: number;
  nameEnd: number;
  /** Value span without quotes; undefined for valueless HTML attributes (`<input disabled>`). */
  valueStart?: number;
  valueEnd?: number;
  quote: '"' | "'" | '';
  end: number;
}

interface ElementInfo {
  tagName: string;
  nameStart: number;
  attributes: AttributeToken[];
  /** Where a new attribute goes: right after the last attribute (or the tag name). */
  attributeInsertAt: number;
  openEnd: number;
  selfClosing: boolean;
  /** Tag name span of the closing tag, when there is an explicit one. */
  closeName?: Span;
  /** Start of the closing tag (or the element end when there is none). */
  contentEnd: number;
  end: number;
}

const ATTRIBUTE = /(\s*)([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y;
const TAG_END = /\s*(\/?)>/y;

function scanOpenTag(text: string, start: number): Omit<ElementInfo, 'closeName' | 'contentEnd' | 'end'> {
  const tagName = /<([^\s/>]+)/y;
  tagName.lastIndex = start;
  const name = tagName.exec(text)![1];
  let position = start + 1 + name.length;

  const attributes: AttributeToken[] = [];
  for (;;) {
    ATTRIBUTE.lastIndex = position;
    const match = ATTRIBUTE.exec(text);
    if (!match) {
      break;
    }
    const nameStart = position + match[1].length;
    const end = position + match[0].length;
    const raw = match[3] ?? match[4] ?? match[5];
    const quote = match[3] !== undefined ? '"' : match[4] !== undefined ? "'" : '';
    attributes.push({
      name: match[2],
      start: position,
      nameStart,
      nameEnd: nameStart + match[2].length,
      valueStart: raw === undefined ? undefined : end - quote.length - raw.length,
      valueEnd: raw === undefined ? undefined : end - quote.length,
      quote,
      end,
    });
    position = end;
  }

  TAG_END.lastIndex = position;
  const close = TAG_END.exec(text);
  return {
    tagName: name,
    nameStart: start + 1,
    attributes,
    attributeInsertAt: position,
    openEnd: close ? position + close[0].length : position,
    selfClosing: close?.[1] === '/',
  };
}

function isElement(node: ChildNode): node is Element {
  return node.type === 'tag' || node.type === 'script' || node.type === 'style';
}

function isText(node: ChildNode): node is Text {
  return node.type === 'text';
}

/** Children shown as blocks: elements and non-blank text. */
function contentNodes(parent: Element | DomDocument): (Element | Text)[] {
  return parent.children.filter((node): node is Element | Text => isElement(node) || (isText(node) && node.data.trim() !== ''));
}

function elementInfo(text: string, element: Element): ElementInfo {
  const open = scanOpenTag(text, element.startIndex!);
  if (open.selfClosing) {
    return { ...open, contentEnd: open.openEnd, end: open.openEnd };
  }
  // htmlparser2's endIndex is the end of the closing tag when there is one. For void elements and
  // implied end tags (`<li>One<li>Two`) it can point into the next tag, so compute the end ourselves.
  const rawEnd = element.endIndex! + 1;
  const closeStart = text.lastIndexOf('</', rawEnd - 1);
  const close = closeStart >= open.openEnd ? /^<\/([^\s>]+)\s*>$/.exec(text.slice(closeStart, rawEnd)) : null;
  if (close && close[1].toLowerCase() === open.tagName.toLowerCase()) {
    return {
      ...open,
      closeName: { start: closeStart + 2, end: closeStart + 2 + close[1].length },
      contentEnd: closeStart,
      end: rawEnd,
    };
  }
  const end = Math.max(open.openEnd, ...element.children.map((child) => nodeSpan(text, child)?.end ?? 0));
  return { ...open, contentEnd: end, end };
}

/** Source span of a node; text is trimmed so the span covers what is shown. */
function nodeSpan(text: string, node: ChildNode): Span | undefined {
  if (isElement(node)) {
    return { start: node.startIndex!, end: elementInfo(text, node).end };
  }
  if (isText(node)) {
    const raw = text.slice(node.startIndex!, node.endIndex! + 1);
    if (raw.trim() === '') {
      return undefined;
    }
    const start = node.startIndex! + (raw.length - raw.trimStart().length);
    return { start, end: start + raw.trim().length };
  }
  return node.startIndex === null ? undefined : { start: node.startIndex, end: node.endIndex! + 1 };
}

// ---------- blocks ----------

function rootBlock(text: string, doc: DomDocument): Block | null {
  const top = contentNodes(doc);
  if (top.length === 0) {
    return null;
  }
  if (top.length === 1 && isElement(top[0])) {
    return elementBlock(text, top[0], [], undefined);
  }
  // Several top-level nodes (e.g. an HTML fragment): a read-only list of them.
  return {
    id: pathToId([]),
    kind: 'array',
    path: [],
    caption: 'document',
    readOnly: true,
    range: { offset: 0, length: text.length },
    children: top.map((node, i) => contentBlock(text, node, [i], i)),
  };
}

function contentBlock(text: string, node: Element | Text, path: BlockPath, index: number): Block {
  return isElement(node) ? elementBlock(text, node, path, index) : textBlock(text, node, path, index);
}

function elementBlock(text: string, element: Element, path: BlockPath, label: number | undefined): Block {
  const info = elementInfo(text, element);
  const attributes: Block[] = info.attributes.map((attribute) => {
    const attributePath = [...path, `@${attribute.name}`];
    return {
      id: pathToId(attributePath),
      kind: 'attribute',
      path: attributePath,
      label: `@${attribute.name}`,
      value: element.attribs[attribute.name] ?? element.attribs[attribute.name.toLowerCase()] ?? '',
      range: { offset: attribute.nameStart, length: attribute.end - attribute.nameStart },
    };
  });
  const base = {
    id: pathToId(path),
    kind: 'element' as const,
    path,
    label,
    caption: info.tagName,
    range: { offset: element.startIndex!, length: info.end - element.startIndex! },
  };

  // Inline elements (`<li>JSON</li>`, `<a/>`, `<br>`) have no card of their own: they are a row
  // of the parent card whose value is their text. Void elements have no value at all.
  const content = contentNodes(element);
  const inline = textOnlyContent(info, content);
  if (attributes.length === 0 && inline !== undefined) {
    return { ...base, value: inline.editable ? inline.text : undefined };
  }
  return { ...base, children: [...attributes, ...content.map((node, i) => contentBlock(text, node, [...path, i], i))] };
}

/** The element's text when its content is a single text node or nothing; undefined if it has child elements. */
function textOnlyContent(info: ElementInfo, content: (Element | Text)[]): { text: string; editable: boolean } | undefined {
  if (content.length === 1 && isText(content[0])) {
    return { text: content[0].data.trim(), editable: true };
  }
  if (content.length === 0) {
    // `<a/>` and `<a></a>` can take text; void elements (`<br>`) and implied-end empties can't.
    return { text: '', editable: info.selfClosing || info.closeName !== undefined };
  }
  return undefined;
}

function textBlock(text: string, node: Text, path: BlockPath, index: number): Block {
  const span = nodeSpan(text, node)!;
  return {
    id: pathToId(path),
    kind: 'text',
    path,
    label: index,
    caption: '#text',
    value: node.data.trim(),
    range: { offset: span.start, length: span.end - span.start },
  };
}

// ---------- edits ----------

type Located =
  | { type: 'element'; node: Element; info: ElementInfo; parent: Element | DomDocument; index: number }
  | { type: 'text'; node: Text; span: Span; parent: Element | DomDocument; index: number }
  | { type: 'attribute'; owner: Element; info: ElementInfo; attribute: AttributeToken; index: number };

/** Resolves a block path against the DOM, mirroring how rootBlock/elementBlock assign paths. */
function locate(text: string, doc: DomDocument, path: BlockPath): Located | undefined {
  const top = contentNodes(doc);
  const singleRoot = top.length === 1 && isElement(top[0]) ? top[0] : undefined;
  if (path.length === 0) {
    return singleRoot ? { type: 'element', node: singleRoot, info: elementInfo(text, singleRoot), parent: doc, index: 0 } : undefined;
  }

  let parent: Element | DomDocument = singleRoot ?? doc;
  for (let i = 0; i < path.length; i++) {
    const segment = path[i];
    const last = i === path.length - 1;
    if (typeof segment === 'string') {
      if (!last || !segment.startsWith('@') || parent.type === 'root') {
        return undefined;
      }
      const owner: Element = parent;
      const info = elementInfo(text, owner);
      const index = info.attributes.findIndex((attribute) => attribute.name === segment.slice(1));
      return index < 0 ? undefined : { type: 'attribute', owner, info, attribute: info.attributes[index], index };
    }
    const node = contentNodes(parent)[segment];
    if (!node) {
      return undefined;
    }
    if (last) {
      return isElement(node)
        ? { type: 'element', node, info: elementInfo(text, node), parent, index: segment }
        : { type: 'text', node, span: nodeSpan(text, node)!, parent, index: segment };
    }
    if (!isElement(node)) {
      return undefined;
    }
    parent = node;
  }
  return undefined;
}

function applyMarkupEdit(text: string, doc: DomDocument, edit: BlockEdit, xmlMode: boolean): TextChange[] | undefined {
  switch (edit.type) {
    case 'setValue': {
      const target = locate(text, doc, edit.path);
      const value = edit.value === null || typeof edit.value !== 'object' ? String(edit.value ?? '') : undefined;
      if (value === undefined) {
        return undefined;
      }
      if (target?.type === 'attribute') {
        const { attribute } = target;
        if (attribute.valueStart === undefined) {
          return [insertAt(attribute.nameEnd, `="${escapeAttribute(value, '"')}"`)];
        }
        // Unquoted values get quotes, since the new value may contain spaces.
        const quote = attribute.quote || '"';
        const content = attribute.quote ? escapeAttribute(value, quote) : `"${escapeAttribute(value, '"')}"`;
        return [replace(attribute.valueStart, attribute.valueEnd!, content)];
      }
      if (target?.type === 'text') {
        return [replace(target.span.start, target.span.end, escapeText(value))];
      }
      if (target?.type === 'element') {
        return setElementText(text, target.node, target.info, escapeText(value));
      }
      return undefined;
    }

    case 'rename': {
      const target = locate(text, doc, edit.path);
      const name = edit.newKey.replace(/^@/, '');
      if (target?.type === 'attribute') {
        if (target.info.attributes.some((attribute) => attribute.name === name)) {
          return undefined;
        }
        return [replace(target.attribute.nameStart, target.attribute.nameEnd, name)];
      }
      if (target?.type === 'element') {
        const { info } = target;
        const changes = [replace(info.nameStart, info.nameStart + info.tagName.length, name)];
        if (info.closeName) {
          changes.push(replace(info.closeName.start, info.closeName.end, name));
        }
        return changes;
      }
      return undefined;
    }

    case 'remove': {
      const target = locate(text, doc, edit.path);
      if (!target || edit.path.length === 0) {
        return undefined;
      }
      if (target.type === 'attribute') {
        return [replace(target.attribute.start, target.attribute.end, '')];
      }
      const span = target.type === 'element' ? { start: target.node.startIndex!, end: target.info.end } : target.span;
      return [removeWithLine(text, span)];
    }

    case 'insert': {
      const parent = locate(text, doc, edit.parentPath);
      if (parent?.type !== 'element' || edit.key === undefined) {
        return undefined;
      }
      const { info, node } = parent;
      if (edit.key.startsWith('@')) {
        const name = edit.key.slice(1);
        if (info.attributes.some((attribute) => attribute.name === name)) {
          return undefined;
        }
        return [insertAt(info.attributeInsertAt, ` ${name}="${escapeAttribute(String(edit.value ?? ''), '"')}"`)];
      }
      const content =
        edit.key === '#text'
          ? escapeText(String(edit.value ?? ''))
          : xmlMode
            ? `<${edit.key}/>`
            : `<${edit.key}></${edit.key}>`;
      return appendContent(text, node, info, content, edit.key !== '#text');
    }

    case 'move': {
      const target = locate(text, doc, edit.path);
      if (!target) {
        return undefined;
      }
      // Block children list attributes first, then content; toIndex counts in that combined list.
      if (target.type === 'attribute') {
        const spans = target.info.attributes.map((attribute) => ({ start: attribute.nameStart, end: attribute.end }));
        return rotateSpans(text, spans, target.index, edit.toIndex);
      }
      const attributeCount = target.parent.type === 'root' ? 0 : elementInfo(text, target.parent).attributes.length;
      const spans = contentNodes(target.parent).map((node) => nodeSpan(text, node)!);
      return rotateSpans(text, spans, target.index, edit.toIndex - attributeCount);
    }
  }
}

/** Sets the text of an inline element (one text node or empty); elements with child elements are refused. */
function setElementText(text: string, element: Element, info: ElementInfo, escaped: string): TextChange[] | undefined {
  const content = contentNodes(element);
  if (content.length === 1 && isText(content[0])) {
    const span = nodeSpan(text, content[0])!;
    return [replace(span.start, span.end, escaped)];
  }
  if (content.length > 0) {
    return undefined;
  }
  if (info.selfClosing || info.closeName) {
    // Same as appending text to an empty element: `<a/>` -> `<a>text</a>`, `<a></a>` -> `<a>text</a>`.
    return escaped === '' ? [] : appendContent(text, element, info, escaped, false);
  }
  return undefined;
}

/** Appends a child at the end of an element, following the layout of its existing children. */
function appendContent(text: string, element: Element, info: ElementInfo, content: string, isElementContent: boolean): TextChange[] | undefined {
  const eol = detectEol(text);
  if (info.selfClosing) {
    // `<a/>` -> `<a>content</a>`: replace the `/>` (and any space before it).
    let slash = info.openEnd - 2;
    while (/\s/.test(text[slash - 1])) {
      slash--;
    }
    return [replace(slash, info.openEnd, `>${content}</${info.tagName}>`)];
  }
  if (!info.closeName) {
    // Void element (`<br>`) or implied end tag: nowhere safe to put children.
    return undefined;
  }

  const children = contentNodes(element).map((node) => nodeSpan(text, node)!);
  const last = children[children.length - 1];
  if (last) {
    // Reuse the whitespace before the last child: on its own line if it is, inline otherwise.
    const previousEnd = children.length > 1 ? children[children.length - 2].end : info.openEnd;
    const leading = text.slice(previousEnd, last.start);
    const lineBreak = leading.lastIndexOf('\n');
    const indent = lineBreak >= 0 ? leading.slice(lineBreak + 1) : '';
    const separator = lineBreak >= 0 && /^[ \t]*$/.test(indent) ? eol + indent : '';
    return [insertAt(last.end, separator + content)];
  }

  const inner = text.slice(info.openEnd, info.contentEnd);
  if (inner.trim() !== '') {
    // Only comments inside: append right before the closing tag.
    return [insertAt(info.contentEnd, content)];
  }
  if (!isElementContent) {
    return [replace(info.openEnd, info.contentEnd, content)];
  }
  const indent = lineIndentAt(text, element.startIndex!);
  return [replace(info.openEnd, info.contentEnd, `${eol}${indent}${detectIndentUnit(text)}${content}${eol}${indent}`)];
}

/** Removes a span; if that leaves its line blank, removes the whole line. */
function removeWithLine(text: string, span: Span): TextChange {
  const lineStart = text.lastIndexOf('\n', span.start - 1) + 1;
  const lineEnd = text.indexOf('\n', span.end);
  const before = text.slice(lineStart, span.start);
  const after = text.slice(span.end, lineEnd === -1 ? text.length : lineEnd);
  if (lineEnd !== -1 && /^[ \t]*$/.test(before) && /^[ \t\r]*$/.test(after)) {
    return replace(lineStart, lineEnd + 1, '');
  }
  return replace(span.start, span.end, '');
}

function replace(start: number, end: number, content: string): TextChange {
  return { offset: start, length: end - start, content };
}

function insertAt(offset: number, content: string): TextChange {
  return { offset, length: 0, content };
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

function escapeAttribute(value: string, quote: '"' | "'"): string {
  const escaped = value.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return quote === '"' ? escaped.replace(/"/g, '&quot;') : escaped.replace(/'/g, '&#39;');
}
