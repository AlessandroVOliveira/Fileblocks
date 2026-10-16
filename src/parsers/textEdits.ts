import type { TextChange } from './types';

/** A [start, end) range of source text. */
export interface Span {
  start: number;
  end: number;
}

/**
 * Moves the sibling at `from` to `to` by rotating the source text of the siblings in between.
 * The separators between siblings (commas, whitespace, line breaks) stay where they are, so the
 * container's layout is untouched.
 */
export function rotateSpans(text: string, spans: Span[], from: number, to: number): TextChange[] | undefined {
  if (from < 0 || from >= spans.length || to < 0 || to >= spans.length) {
    return undefined;
  }
  if (from === to) {
    return [];
  }
  const order = spans.map((_, i) => i);
  order.splice(to, 0, ...order.splice(from, 1));
  const low = Math.min(from, to);
  const high = Math.max(from, to);

  let content = '';
  for (let i = low; i <= high; i++) {
    const span = spans[order[i]];
    content += text.slice(span.start, span.end);
    if (i < high) {
      content += text.slice(spans[i].end, spans[i + 1].start);
    }
  }
  return [{ offset: spans[low].start, length: spans[high].end - spans[low].start, content }];
}

/** Leading whitespace of the line that contains `offset`. */
export function lineIndentAt(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

/** One indentation step, inferred from the first indented line; falls back to 2 spaces. */
export function detectIndentUnit(text: string): string {
  return /^([ \t]+)\S/m.exec(text)?.[1] ?? '  ';
}

export function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
