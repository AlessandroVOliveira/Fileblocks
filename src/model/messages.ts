/** Message protocol shared by the extension host and the webview. */

import type { Block, BlockPath, ScalarValue } from './block';

export interface ParseError {
  message: string;
  offset?: number;
}

export type BlockEdit = { type: 'setValue'; path: BlockPath; value: ScalarValue };

export type HostToWebview = {
  type: 'update';
  format: string;
  root: Block | null;
  errors: ParseError[];
};

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'edit'; edit: BlockEdit }
  | { type: 'openText' };
