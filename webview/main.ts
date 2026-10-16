import type { HostToWebview, WebviewToHost } from '../src/model/messages';
import { render } from './render';

interface WebviewState {
  collapsed: string[];
}

declare function acquireVsCodeApi(): {
  postMessage(message: WebviewToHost): void;
  getState(): WebviewState | undefined;
  setState(state: WebviewState): void;
};

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;
const collapsed = new Set(vscode.getState()?.collapsed ?? []);
let lastUpdate: HostToWebview | undefined;

function rerender(): void {
  if (!lastUpdate) {
    return;
  }
  render(app, lastUpdate, {
    post: (message) => vscode.postMessage(message),
    isCollapsed: (id) => collapsed.has(id),
    toggleCollapsed: (id) => {
      if (!collapsed.delete(id)) {
        collapsed.add(id);
      }
      vscode.setState({ collapsed: [...collapsed] });
      rerender();
    },
  });
}

window.addEventListener('message', (event: MessageEvent<HostToWebview>) => {
  if (event.data.type === 'update') {
    lastUpdate = event.data;
    rerender();
  }
});

vscode.postMessage({ type: 'ready' });
