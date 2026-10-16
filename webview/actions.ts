import { createContext, useContext } from 'react';
import type { SchemaHint, WebviewToHost } from '../src/model/messages';

export interface EditorActions {
  post(message: WebviewToHost): void;
  isCollapsed(id: string): boolean;
  toggleCollapsed(id: string): void;
}

export const ActionsContext = createContext<EditorActions | null>(null);

export interface Highlight {
  /** Ids of blocks whose key or value matches the search. */
  matchIds: ReadonlySet<string>;
  /** Id of the match the user navigated to. */
  activeId?: string;
  /** Id of the block under the text editor's cursor (or last clicked). */
  selectedId?: string;
  /** JSON Schema problem messages by block id. */
  problems: ReadonlyMap<string, string[]>;
  /** JSON Schema hints (description, enum, required) by block id. */
  hints: Readonly<Record<string, SchemaHint>>;
}

export const HighlightContext = createContext<Highlight>({ matchIds: new Set(), problems: new Map(), hints: {} });

export function useHighlight(): Highlight {
  return useContext(HighlightContext);
}

export function useActions(): EditorActions {
  const actions = useContext(ActionsContext);
  if (!actions) {
    throw new Error('useActions must be used inside ActionsContext');
  }
  return actions;
}
