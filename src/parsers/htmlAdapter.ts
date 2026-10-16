import type { FormatAdapter } from './types';

// TODO: implement with a position-aware parser so edits keep the original formatting.
export const htmlAdapter: FormatAdapter = {
  id: 'html',
  parse() {
    return { root: null, errors: [{ message: 'HTML support is not implemented yet.' }] };
  },
  applyEdit() {
    return undefined;
  },
};
