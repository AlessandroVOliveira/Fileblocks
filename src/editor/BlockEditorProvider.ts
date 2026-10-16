import * as vscode from 'vscode';
import type { BlockEdit, HostToWebview, WebviewToHost } from '../model/messages';
import { getAdapter, type FormatAdapter } from '../parsers';
import { getWebviewHtml } from './webviewHtml';

/**
 * Custom text editor: the TextDocument stays the source of truth (so undo/redo, save
 * and dirty state work natively). The webview only renders blocks and sends edits back.
 */
export class BlockEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'fileblocks.blockEditor';

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      BlockEditorProvider.viewType,
      new BlockEditorProvider(context),
      { supportsMultipleEditorsPerDocument: true },
    );
  }

  private constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const adapter = getAdapter(document);
    const webview = panel.webview;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    webview.html = getWebviewHtml(webview, this.context.extensionUri);

    const postUpdate = () => {
      const result = adapter
        ? adapter.parse(document.getText())
        : { root: null, errors: [{ message: `Unsupported format: ${document.languageId}` }] };
      const message: HostToWebview = { type: 'update', format: adapter?.id ?? document.languageId, ...result };
      void webview.postMessage(message);
    };

    const subscriptions = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString()) {
          postUpdate();
        }
      }),
      webview.onDidReceiveMessage((message: WebviewToHost) => {
        switch (message.type) {
          case 'ready':
            postUpdate();
            break;
          case 'edit':
            if (adapter) {
              void this.applyEdit(document, adapter, message.edit);
            }
            break;
          case 'openText':
            void vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', vscode.ViewColumn.Beside);
            break;
        }
      }),
    ];

    panel.onDidDispose(() => subscriptions.forEach((d) => d.dispose()));
  }

  private async applyEdit(document: vscode.TextDocument, adapter: FormatAdapter, edit: BlockEdit): Promise<void> {
    const changes = adapter.applyEdit(document.getText(), edit);
    if (!changes) {
      void vscode.window.showWarningMessage(`Fileblocks: this edit is not supported for ${adapter.id} yet.`);
      return;
    }
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const change of changes) {
      const range = new vscode.Range(
        document.positionAt(change.offset),
        document.positionAt(change.offset + change.length),
      );
      workspaceEdit.replace(document.uri, range, change.content);
    }
    await vscode.workspace.applyEdit(workspaceEdit);
  }
}
