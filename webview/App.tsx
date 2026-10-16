import { Background, Controls, MiniMap, ReactFlow, useReactFlow } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HostToWebview, WebviewToHost } from '../src/model/messages';
import { ActionsContext, SearchContext, type EditorActions, type SearchHighlight } from './actions';
import { BlockNode } from './graph/BlockNode';
import { buildGraph, HEADER_HEIGHT, nodeId, ROW_HEIGHT, type Measure } from './graph/buildGraph';
import { layoutGraph, type BlockFlowNode } from './graph/layout';
import { findMatches, idsToReveal } from './graph/search';
import { SearchBox } from './SearchBox';

export interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState(): { collapsed: string[] } | undefined;
  setState(state: { collapsed: string[] }): void;
}

// Must be stable across renders, or React Flow remounts every node.
const nodeTypes = { block: BlockNode };

export function App({ vscode }: { vscode: VsCodeApi }) {
  const [update, setUpdate] = useState<HostToWebview>();
  const [collapsed, setCollapsed] = useState(() => new Set(vscode.getState()?.collapsed ?? []));
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  // Bumped whenever the user navigates search results; each value is centered once.
  const [centerRequest, setCenterRequest] = useState(0);
  const centeredRequest = useRef(0);
  const { setCenter, getZoom } = useReactFlow();

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebview>) => {
      if (event.data.type === 'update') {
        setUpdate(event.data);
      }
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [vscode]);

  const updateCollapsed = useCallback(
    (change: (next: Set<string>) => boolean) =>
      setCollapsed((previous) => {
        const next = new Set(previous);
        if (!change(next)) {
          return previous;
        }
        vscode.setState({ collapsed: [...next] });
        return next;
      }),
    [vscode],
  );

  const toggleCollapsed = useCallback(
    (id: string) =>
      updateCollapsed((next) => {
        if (!next.delete(id)) {
          next.add(id);
        }
        return true;
      }),
    [updateCollapsed],
  );

  const actions = useMemo<EditorActions>(
    () => ({ post: (message) => vscode.postMessage(message), isCollapsed: (id) => collapsed.has(id), toggleCollapsed }),
    [vscode, collapsed, toggleCollapsed],
  );

  const matches = useMemo(() => (update?.root ? findMatches(update.root, query) : []), [update, query]);
  const active = matches.length > 0 ? matches[Math.min(activeIndex, matches.length - 1)] : undefined;

  const highlight = useMemo<SearchHighlight>(
    () => ({ matchIds: new Set(matches.map((m) => m.block.id)), activeId: active?.block.id }),
    [matches, active],
  );
  const matchCards = useMemo(() => new Set(matches.map((m) => nodeId(m.card))), [matches]);

  const onQueryChange = (next: string) => {
    setQuery(next);
    setActiveIndex(0);
    setCenterRequest((n) => n + 1);
  };

  const onNavigate = (delta: 1 | -1) => {
    if (matches.length > 0) {
      setActiveIndex((i) => (Math.min(i, matches.length - 1) + delta + matches.length) % matches.length);
      setCenterRequest((n) => n + 1);
    }
  };

  // A match inside a collapsed subtree has no card on the canvas: expand its ancestors.
  useEffect(() => {
    if (active && centerRequest !== centeredRequest.current) {
      const ids = idsToReveal(active);
      updateCollapsed((next) => ids.map((id) => next.delete(id)).some(Boolean));
    }
  }, [active, centerRequest, updateCollapsed]);

  const { nodes, edges } = useMemo(
    () => (update?.root ? layoutGraph(buildGraph(update.root, (id) => collapsed.has(id), measureText)) : { nodes: [], edges: [] }),
    [update, collapsed],
  );

  // Center on the active match once its card is laid out (possibly after the expansion above).
  useEffect(() => {
    if (!active || centerRequest === centeredRequest.current) {
      return;
    }
    const card = nodes.find((node) => node.id === nodeId(active.card));
    if (card) {
      centeredRequest.current = centerRequest;
      const x = card.position.x + (card.width ?? 0) / 2;
      const y = card.position.y + HEADER_HEIGHT + active.row * ROW_HEIGHT + ROW_HEIGHT / 2;
      void setCenter(x, y, { zoom: Math.max(getZoom(), 0.8), duration: 300 });
    }
  }, [active, nodes, centerRequest, setCenter, getZoom]);

  return (
    <ActionsContext.Provider value={actions}>
      <SearchContext.Provider value={highlight}>
        <div className="app">
          <div className="toolbar">
            <span className="format-badge">{(update?.format ?? '').toUpperCase()}</span>
            <SearchBox
              query={query}
              onQueryChange={onQueryChange}
              current={Math.min(activeIndex, matches.length - 1)}
              total={matches.length}
              onNavigate={onNavigate}
            />
            <button className="toolbar-button" onClick={() => vscode.postMessage({ type: 'openText' })}>
              Open as text
            </button>
          </div>
          {update && update.errors.length > 0 && (
            <ul className="errors">
              {update.errors.map((error, i) => (
                <li key={i}>
                  {error.message}
                  {error.offset !== undefined && ` (offset ${error.offset})`}
                </li>
              ))}
            </ul>
          )}
          <div className="canvas">
            <ReactFlow<BlockFlowNode>
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              // Fits once, when the first nodes are measured (React Flow retries until there are nodes);
              // later updates keep the user's pan/zoom.
              fitView
              fitViewOptions={{ padding: 0.15, maxZoom: 1.2 }}
              nodesDraggable={false}
              nodesConnectable={false}
              deleteKeyCode={null}
              minZoom={0.1}
              maxZoom={2}
            >
              <Background gap={20} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeClassName={(node) => (matchCards.has(node.id) ? 'minimap-match' : '')} />
            </ReactFlow>
          </div>
        </div>
      </SearchContext.Provider>
    </ActionsContext.Provider>
  );
}

let measureContext: CanvasRenderingContext2D | null | undefined;
const fonts = { label: '', value: '' };

/** Text width in the webview's fonts, used to size nodes before they render. */
const measureText: Measure = (text, font) => {
  if (measureContext === undefined) {
    measureContext = document.createElement('canvas').getContext('2d');
    const style = getComputedStyle(document.body);
    const editorSize = style.getPropertyValue('--vscode-editor-font-size').trim() || style.fontSize;
    const editorFamily = style.getPropertyValue('--vscode-editor-font-family').trim() || 'monospace';
    fonts.label = `${style.fontSize} ${style.fontFamily}`;
    fonts.value = `${editorSize} ${editorFamily}`;
  }
  if (!measureContext) {
    return text.length * 8;
  }
  measureContext.font = fonts[font];
  return measureContext.measureText(text).width;
};
