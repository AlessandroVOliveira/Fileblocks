import { Background, Controls, MiniMap, ReactFlow } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { HostToWebview, WebviewToHost } from '../src/model/messages';
import { ActionsContext, type EditorActions } from './actions';
import { BlockNode } from './graph/BlockNode';
import { buildGraph, type Measure } from './graph/buildGraph';
import { layoutGraph, type BlockFlowNode } from './graph/layout';

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

  const toggleCollapsed = useCallback(
    (id: string) =>
      setCollapsed((previous) => {
        const next = new Set(previous);
        if (!next.delete(id)) {
          next.add(id);
        }
        vscode.setState({ collapsed: [...next] });
        return next;
      }),
    [vscode],
  );

  const actions = useMemo<EditorActions>(
    () => ({ post: (message) => vscode.postMessage(message), isCollapsed: (id) => collapsed.has(id), toggleCollapsed }),
    [vscode, collapsed, toggleCollapsed],
  );

  const { nodes, edges } = useMemo(
    () => (update?.root ? layoutGraph(buildGraph(update.root, (id) => collapsed.has(id), measureText)) : { nodes: [], edges: [] }),
    [update, collapsed],
  );

  return (
    <ActionsContext.Provider value={actions}>
      <div className="app">
        <div className="toolbar">
          <span className="format-badge">{(update?.format ?? '').toUpperCase()}</span>
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
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>
      </div>
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
