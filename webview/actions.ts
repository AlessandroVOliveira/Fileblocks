import { createContext, useContext } from 'react';
import type { WebviewToHost } from '../src/model/messages';

export interface EditorActions {
  post(message: WebviewToHost): void;
  isCollapsed(id: string): boolean;
  toggleCollapsed(id: string): void;
}

export const ActionsContext = createContext<EditorActions | null>(null);

export interface SearchHighlight {
  /** Ids of blocks whose key or value matches the search. */
  matchIds: ReadonlySet<string>;
  /** Id of the match the user navigated to. */
  activeId?: string;
}

export const SearchContext = createContext<SearchHighlight>({ matchIds: new Set() });

export function useSearchHighlight(): SearchHighlight {
  return useContext(SearchContext);
}

export function useActions(): EditorActions {
  const actions = useContext(ActionsContext);
  if (!actions) {
    throw new Error('useActions must be used inside ActionsContext');
  }
  return actions;
}
