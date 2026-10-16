import '@xyflow/react/dist/style.css';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { App, type VsCodeApi } from './App';

declare function acquireVsCodeApi(): VsCodeApi;

createRoot(document.getElementById('app')!).render(<App vscode={acquireVsCodeApi()} />);
