import { getNodesBounds, type Node } from '@xyflow/react';
import { toPng, toSvg } from 'html-to-image';
import type { ImageFormat } from '../src/model/messages';

const PADDING = 40;
/** Browsers refuse canvases much larger than this; big graphs are exported at a lower pixel ratio. */
const MAX_PNG_SIDE = 8000;

/**
 * Renders the whole graph (not just the visible part) as a data URL. The caller must make sure every
 * card and row is in the DOM first (virtualization off).
 */
export async function renderGraphImage(nodes: Node[], format: ImageFormat): Promise<string> {
  const viewport = document.querySelector<HTMLElement>('.react-flow__viewport');
  if (!viewport || nodes.length === 0) {
    throw new Error('There is nothing to export.');
  }
  const bounds = getNodesBounds(nodes);
  const width = Math.ceil(bounds.width + PADDING * 2);
  const height = Math.ceil(bounds.height + PADDING * 2);
  const options = {
    backgroundColor: getComputedStyle(document.body).backgroundColor,
    width,
    height,
    // The webview's CSP blocks the font fetches html-to-image would do; icons are left out instead.
    skipFonts: true,
    filter: (node: HTMLElement) => !node.classList?.contains('codicon') && !node.classList?.contains('react-flow__handle'),
    style: {
      width: `${width}px`,
      height: `${height}px`,
      transform: `translate(${PADDING - bounds.x}px, ${PADDING - bounds.y}px) scale(1)`,
    },
  };
  // Each edge is its own <svg> left at the default 300×150 size with overflow visible; html-to-image
  // clips to that box, so grow them to cover the graph while capturing.
  // Edge paths get their stroke from a CSS variable that html-to-image doesn't carry over, so the
  // lines would come out invisible: inline the computed stroke while capturing.
  const edgeSvgs = Array.from(viewport.querySelectorAll<SVGSVGElement>('.react-flow__edges svg'));
  const edgePaths = Array.from(viewport.querySelectorAll<SVGPathElement>('.react-flow__edge-path'));
  const touched: Element[] = [...edgeSvgs, ...edgePaths];
  const previous = touched.map((element) => element.getAttribute('style'));
  edgeSvgs.forEach((svg) => {
    svg.style.width = `${Math.ceil(bounds.x + bounds.width + PADDING)}px`;
    svg.style.height = `${Math.ceil(bounds.y + bounds.height + PADDING)}px`;
  });
  edgePaths.forEach((path) => {
    const computed = getComputedStyle(path);
    path.style.stroke = computed.stroke;
    path.style.strokeWidth = computed.strokeWidth;
    path.style.fill = 'none';
  });
  try {
    if (format === 'svg') {
      return await toSvg(viewport, options);
    }
    return await toPng(viewport, { ...options, pixelRatio: Math.min(2, MAX_PNG_SIDE / Math.max(width, height)) });
  } finally {
    touched.forEach((element, i) => (previous[i] === null ? element.removeAttribute('style') : element.setAttribute('style', previous[i]!)));
  }
}
