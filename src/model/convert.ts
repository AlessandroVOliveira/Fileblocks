import type { Block } from './block';
import type { InsertValue } from './messages';

export type ValueType = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

export const VALUE_TYPES: ValueType[] = ['string', 'number', 'boolean', 'null', 'object', 'array'];

export function typeOf(block: Block): ValueType {
  if (block.kind === 'object' || block.kind === 'array') {
    return block.kind;
  }
  const value = block.value ?? null;
  return value === null ? 'null' : (typeof value as 'string' | 'number' | 'boolean');
}

/** Converts a block's value to another type, keeping as much of it as makes sense. */
export function convertValue(block: Block, type: ValueType): InsertValue {
  const value = block.kind === 'scalar' ? block.value ?? null : null;
  switch (type) {
    case 'string':
      return value === null ? '' : String(value);
    case 'number': {
      // true -> 1, "42" -> 42; anything that isn't a finite number becomes 0.
      const number = Number(value);
      return value !== null && value !== '' && Number.isFinite(number) ? number : 0;
    }
    case 'boolean':
      return typeof value === 'string' ? value.trim().toLowerCase() === 'true' : Boolean(value);
    case 'null':
      return null;
    case 'object':
      return {};
    case 'array':
      return [];
  }
}
