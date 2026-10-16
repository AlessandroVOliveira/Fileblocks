import type { TextChange } from './types';

/**
 * Reduces a whole-text rewrite to the single changed span, so the editor's undo stack,
 * cursor and decorations are disturbed as little as possible.
 */
export function diffText(before: string, after: string): TextChange[] {
  if (before === after) {
    return [];
  }
  const maxPrefix = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < maxPrefix && before.charCodeAt(prefix) === after.charCodeAt(prefix)) {
    prefix++;
  }
  const maxSuffix = maxPrefix - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++;
  }
  return [{ offset: prefix, length: before.length - prefix - suffix, content: after.slice(prefix, after.length - suffix) }];
}
