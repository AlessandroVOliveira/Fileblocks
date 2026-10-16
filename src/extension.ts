import * as vscode from 'vscode';
import { BlockEditorProvider } from './editor/BlockEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    BlockEditorProvider.register(context),
    vscode.commands.registerCommand('fileblocks.openBlockEditor', (uri?: vscode.Uri) => {
      const target = uri ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        return;
      }
      return vscode.commands.executeCommand('vscode.openWith', target, BlockEditorProvider.viewType);
    }),
  );
}

export function deactivate(): void {}
