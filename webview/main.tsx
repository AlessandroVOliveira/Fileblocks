import '@xyflow/react/dist/style.css';
import './styles.css';
import { ReactFlowProvider } from '@xyflow/react';
import { createRoot } from 'react-dom/client';
import { App, type VsCodeApi } from './App';

declare function acquireVsCodeApi(): VsCodeApi;

// The provider lets App use useReactFlow() (e.g. to center on search results).
createRoot(document.getElementById('app')!).render(
  <ReactFlowProvider>
    <App vscode={acquireVsCodeApi()} />
  </ReactFlowProvider>,
);
