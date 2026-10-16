import assert from 'node:assert/strict';
import type { BlockEdit } from '../src/model/messages';
import type { FormatAdapter } from '../src/parsers';

/** Applies an edit through the adapter and returns the resulting text. */
export function edit(adapter: FormatAdapter, text: string, blockEdit: BlockEdit): string {
  const changes = adapter.applyEdit(text, blockEdit);
  assert.ok(changes, `edit was rejected: ${JSON.stringify(blockEdit)}`);
  return [...changes]
    .sort((a, b) => b.offset - a.offset)
    .reduce((result, c) => result.slice(0, c.offset) + c.content + result.slice(c.offset + c.length), text);
}
