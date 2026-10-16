import type { FormatAdapter } from './types';

// TODO: implement with a position-aware parser so edits keep the original formatting.
export const xmlAdapter: FormatAdapter = {
  id: 'xml',
  parse() {
    return { root: null, errors: [{ message: 'XML support is not implemented yet.' }] };
  },
  applyEdit() {
    return undefined;
  },
};
