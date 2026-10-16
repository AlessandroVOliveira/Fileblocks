import { createContext, useContext } from 'react';
import type { WebviewToHost } from '../src/model/messages';

export interface EditorActions {
  post(message: WebviewToHost): void;
  isCollapsed(id: string): boolean;
  toggleCollapsed(id: string): void;
}

export const ActionsContext = createContext<EditorActions | null>(null);

export function useActions(): EditorActions {
  const actions = useContext(ActionsContext);
  if (!actions) {
    throw new Error('useActions must be used inside ActionsContext');
  }
  return actions;
}
