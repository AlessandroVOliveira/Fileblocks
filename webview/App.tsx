import { Background, Controls, MiniMap, ReactFlow, useReactFlow } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { pathToId, type Block } from '../src/model/block';
import type { HostToWebview, ImageFormat, WebviewToHost } from '../src/model/messages';
import { renderGraphImage } from './exportImage';
import { ActionsContext, HighlightContext, RenderAllContext, type EditorActions, type Highlight } from './actions';
import { BlockNode } from './graph/BlockNode';
import { buildGraph, HEADER_HEIGHT, nodeId, ROW_HEIGHT, type Measure } from './graph/buildGraph';
import { layoutGraph, type BlockFlowNode } from './graph/layout';
import { initialCollapse } from './graph/collapse';
import { findMatches } from './graph/search';
import { idsToReveal, targetFor, type GraphTarget } from './graph/targets';
import { Icon } from './Icon';
import { SearchBox } from './SearchBox';

export interface VsCodeApi {
  postMessage(message: WebviewToHost): void;
  getState(): { collapsed: string[] } | undefined;
  setState(state: { collapsed: string[] }): void;
}

type UpdateMessage = Extract<HostToWebview, { type: 'update' }>;

/** A request to bring a block into view: expand its ancestors, then center on its row. */
interface FocusRequest {
  target: GraphTarget;
  /** Leave the viewport alone when the row is already on screen (cursor following). */
  onlyIfOffscreen: boolean;
  seq: number;
}

// Must be stable across renders, or React Flow remounts every node.
const nodeTypes = { block: BlockNode };
/** Rows closer than this to the canvas edge count as off screen. */
const SCREEN_MARGIN = 40;
/** Formats that can be checked against a schema (JSON Schema, XSD). */
const SCHEMA_FORMATS = new Set(['json', 'yaml', 'xml']);
/** Card count above which React Flow only renders the cards in view. */
const VIRTUALIZE_ABOVE = 100;

export function App({ vscode }: { vscode: VsCodeApi }) {
  const [update, setUpdate] = useState<UpdateMessage>();
  const [collapsed, setCollapsed] = useState(() => new Set(vscode.getState()?.collapsed ?? []));
  // Set when a large file was opened with its deeper levels collapsed.
  const [autoCollapsedDepth, setAutoCollapsedDepth] = useState<number>();
  const firstUpdate = useRef(true);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [focus, setFocus] = useState<FocusRequest>();
  const handledFocus = useRef(0);
  const focusSeq = useRef(0);
  const root = useRef<Block | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const { setCenter, getZoom, getViewport, getNodes } = useReactFlow();
  // Set while an image export is rendering the whole graph (virtualization off).
  const [exportFormat, setExportFormat] = useState<ImageFormat>();

  const requestFocus = useCallback((target: GraphTarget | undefined, onlyIfOffscreen: boolean) => {
    if (target) {
      setFocus({ target, onlyIfOffscreen, seq: ++focusSeq.current });
    }
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent<HostToWebview>) => {
      const message = event.data;
      if (message.type === 'update') {
        root.current = message.root;
        // Large file opened for the first time (no saved collapse state): start with deep levels collapsed,
        // before the first render so the full graph is never laid out.
        if (firstUpdate.current && message.root) {
          firstUpdate.current = false;
          const initial = vscode.getState() ? undefined : initialCollapse(message.root);
          if (initial?.depth !== undefined) {
            setCollapsed(new Set(initial.ids));
            vscode.setState({ collapsed: initial.ids });
            setAutoCollapsedDepth(initial.depth);
          }
        }
        setUpdate(message);
      } else if (message.type === 'renderImage') {
        setExportFormat(message.format);
      } else if (message.type === 'selection') {
        setSelectedId(message.path ? pathToId(message.path) : undefined);
        if (message.path && root.current) {
          requestFocus(targetFor(root.current, message.path), true);
        }
      }
    };
    window.addEventListener('message', onMessage);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, [vscode, requestFocus]);

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

  /** Collapse every container below the root, or expand everything. */
  const setAllCollapsed = (collapse: boolean) => {
    const ids: string[] = [];
    const visit = (block: Block, depth: number) => {
      if (block.children !== undefined) {
        if (depth > 0) {
          ids.push(block.id);
        }
        block.children.forEach((child) => visit(child, depth + 1));
      }
    };
    if (update?.root) {
      visit(update.root, 0);
    }
    updateCollapsed((next) => {
      next.clear();
      if (collapse) {
        // Keep the root's direct children visible as rows; collapse them so their cards are hidden.
        ids.forEach((id) => next.add(id));
      }
      return true;
    });
    setAutoCollapsedDepth(undefined);
  };

  const actions = useMemo<EditorActions>(
    () => ({ post: (message) => vscode.postMessage(message), isCollapsed: (id) => collapsed.has(id), toggleCollapsed }),
    [vscode, collapsed, toggleCollapsed],
  );

  const matches = useMemo(() => (update?.root ? findMatches(update.root, query) : []), [update, query]);
  const activeMatch = matches.length > 0 ? Math.min(activeIndex, matches.length - 1) : -1;

  const schema = update?.schema;
  const problemsById = useMemo(() => {
    const byId = new Map<string, string[]>();
    for (const problem of schema?.problems ?? []) {
      const id = pathToId(problem.path);
      byId.set(id, [...(byId.get(id) ?? []), problem.message]);
    }
    return byId;
  }, [schema]);

  const highlight = useMemo<Highlight>(
    () => ({
      matchIds: new Set(matches.map((m) => m.block.id)),
      activeId: matches[activeMatch]?.block.id,
      selectedId,
      problems: problemsById,
      hints: schema?.hints ?? {},
    }),
    [matches, activeMatch, selectedId, problemsById, schema],
  );

  // Cycles through schema problems: selects the block and brings it into view.
  const problemIndex = useRef(-1);
  const goToNextProblem = () => {
    const problems = schema?.problems ?? [];
    if (problems.length === 0 || !update?.root) {
      return;
    }
    problemIndex.current = (problemIndex.current + 1) % problems.length;
    const { path } = problems[problemIndex.current];
    setSelectedId(pathToId(path));
    // A "not allowed" property exists, but fall back to the parent if the block is gone.
    requestFocus(targetFor(update.root, path) ?? targetFor(update.root, path.slice(0, -1)), false);
  };
  const matchCards = useMemo(() => new Set(matches.map((m) => nodeId(m.card))), [matches]);

  const onQueryChange = (next: string) => {
    setQuery(next);
    setActiveIndex(0);
    requestFocus(update?.root ? findMatches(update.root, next)[0] : undefined, false);
  };

  const onNavigate = (delta: 1 | -1) => {
    if (matches.length > 0) {
      const next = (activeMatch + delta + matches.length) % matches.length;
      setActiveIndex(next);
      requestFocus(matches[next], false);
    }
  };

  // Export: wait until every card and row is in the DOM, capture, then turn virtualization back on.
  useEffect(() => {
    if (exportFormat === undefined) {
      return;
    }
    const frame = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        renderGraphImage(getNodes(), exportFormat)
          .then((dataUrl) => vscode.postMessage({ type: 'image', format: exportFormat, dataUrl }))
          .catch((error: unknown) => vscode.postMessage({ type: 'image', format: exportFormat, error: error instanceof Error ? error.message : String(error) }))
          .finally(() => setExportFormat(undefined));
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, [exportFormat, getNodes, vscode]);

  // A target inside a collapsed subtree has no card on the canvas: expand its ancestors.
  useEffect(() => {
    if (focus && focus.seq !== handledFocus.current) {
      const ids = idsToReveal(focus.target);
      updateCollapsed((next) => ids.map((id) => next.delete(id)).some(Boolean));
    }
  }, [focus, updateCollapsed]);

  const { nodes, edges } = useMemo(
    () => (update?.root ? layoutGraph(buildGraph(update.root, (id) => collapsed.has(id), measureText)) : { nodes: [], edges: [] }),
    [update, collapsed],
  );

  // Center on the target's row once its card is laid out (possibly after the expansion above).
  useEffect(() => {
    if (!focus || focus.seq === handledFocus.current) {
      return;
    }
    const card = nodes.find((node) => node.id === nodeId(focus.target.card));
    if (!card) {
      return;
    }
    handledFocus.current = focus.seq;
    const x = card.position.x + (card.width ?? 0) / 2;
    const y = card.position.y + HEADER_HEIGHT + focus.target.row * ROW_HEIGHT + ROW_HEIGHT / 2;
    if (focus.onlyIfOffscreen && isOnScreen(x, y)) {
      return;
    }
    void setCenter(x, y, { zoom: Math.max(getZoom(), 0.8), duration: 300 });

    function isOnScreen(flowX: number, flowY: number): boolean {
      const bounds = canvas.current?.getBoundingClientRect();
      if (!bounds) {
        return false;
      }
      const { x: panX, y: panY, zoom } = getViewport();
      const screenX = flowX * zoom + panX;
      const screenY = flowY * zoom + panY;
      return (
        screenX > SCREEN_MARGIN &&
        screenX < bounds.width - SCREEN_MARGIN &&
        screenY > SCREEN_MARGIN &&
        screenY < bounds.height - SCREEN_MARGIN
      );
    }
  }, [focus, nodes, setCenter, getZoom, getViewport]);

  return (
    <ActionsContext.Provider value={actions}>
      <RenderAllContext.Provider value={exportFormat !== undefined}>
      <HighlightContext.Provider value={highlight}>
        <div className="app">
          <div className="toolbar">
            <span className="format-badge">{(update?.format ?? '').toUpperCase()}</span>
            <SearchBox
              query={query}
              onQueryChange={onQueryChange}
              current={activeMatch}
              total={matches.length}
              onNavigate={onNavigate}
            />
            {schema ? (
              <button
                className={`schema-chip${schema.error ? ' schema-chip--error' : ''}`}
                title={`${schema.error ? `Could not load the schema: ${schema.error}` : `Schema: ${schema.uri}`}
Click to select another schema`}
                onClick={() => vscode.postMessage({ type: 'selectSchema' })}
              >
                <Icon name={schema.error ? 'warning' : 'json'} />
                {schema.name}
                {schema.loading && ' (loading…)'}
              </button>
            ) : (
              update && SCHEMA_FORMATS.has(update.format) && (
                <button className="schema-chip schema-chip--none" title="Select a schema for this file" onClick={() => vscode.postMessage({ type: 'selectSchema' })}>
                  <Icon name="json" />
                  No schema
                </button>
              )
            )}
            {schema && !schema.loading && !schema.error && (
              <button
                className={`problems-button${schema.problems.length > 0 ? ' problems-button--has' : ''}`}
                disabled={schema.problems.length === 0}
                title={schema.problems.length > 0 ? 'Go to the next schema problem' : 'No schema problems'}
                onClick={goToNextProblem}
              >
                <Icon name={schema.problems.length > 0 ? 'error' : 'check'} />
                {schema.problems.length}
              </button>
            )}
            {autoCollapsedDepth !== undefined && (
              <span className="toolbar-note" title="Expand nodes with their {n} / [n] summaries">
                Large file: showing the first {autoCollapsedDepth + 1} level{autoCollapsedDepth === 0 ? '' : 's'}
              </span>
            )}
            <span className="toolbar-group">
              <button className="action" title="Expand all" aria-label="Expand all" onClick={() => setAllCollapsed(false)}>
                <Icon name="expand-all" />
              </button>
              <button className="action" title="Collapse all" aria-label="Collapse all" onClick={() => setAllCollapsed(true)}>
                <Icon name="collapse-all" />
              </button>
              <button className="action" title="Export as image (PNG or SVG)" aria-label="Export as image" onClick={() => vscode.postMessage({ type: 'export' })}>
                <Icon name="export" />
              </button>
            </span>
            <button className="toolbar-button" onClick={() => vscode.postMessage({ type: 'openText' })}>
              <Icon name="go-to-file" /> Open as text
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
          <div className="canvas" ref={canvas}>
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
              // Large graphs: skip rendering cards outside the viewport.
              onlyRenderVisibleElements={exportFormat === undefined && nodes.length > VIRTUALIZE_ABOVE}
              minZoom={0.1}
              maxZoom={2}
            >
              <Background gap={20} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeClassName={(node) => (matchCards.has(node.id) ? 'minimap-match' : '')} />
            </ReactFlow>
          </div>
        </div>
      </HighlightContext.Provider>
      </RenderAllContext.Provider>
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
