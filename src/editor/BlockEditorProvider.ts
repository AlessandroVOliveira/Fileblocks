import * as vscode from 'vscode';
import { findBlock, type BlockPath } from '../model/block';
import type { BlockEdit, HostToWebview, InsertValue, WebviewToHost } from '../model/messages';
import { getAdapter, type FormatAdapter } from '../parsers';
import { getWebviewHtml } from './webviewHtml';

interface ValueTypeItem extends vscode.QuickPickItem {
  value: () => InsertValue;
}

const VALUE_TYPES: ValueTypeItem[] = [
  { label: 'String', value: () => '' },
  { label: 'Number', value: () => 0 },
  { label: 'Boolean', value: () => false },
  { label: 'Null', value: () => null },
  { label: 'Object', value: () => ({}) },
  { label: 'Array', value: () => [] },
];

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
          case 'add':
            if (adapter) {
              void this.promptInsert(document, adapter, message.parentPath);
            }
            break;
          case 'rename':
            if (adapter) {
              void this.promptRename(document, adapter, message.path);
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

  private async promptInsert(document: vscode.TextDocument, adapter: FormatAdapter, parentPath: BlockPath): Promise<void> {
    const parent = findBlock(adapter.parse(document.getText()).root, parentPath);
    if (parent?.kind !== 'object' && parent?.kind !== 'array') {
      return;
    }

    let key: string | undefined;
    if (parent.kind === 'object') {
      const existing = siblingKeys(parent.children);
      key = await vscode.window.showInputBox({
        title: 'Fileblocks: Add entry',
        prompt: 'Key for the new entry',
        validateInput: (value) => validateKey(value, existing),
      });
      if (key === undefined) {
        return;
      }
    }

    const type = await vscode.window.showQuickPick(VALUE_TYPES, { title: 'Fileblocks: Add entry', placeHolder: 'Type of the new value' });
    if (!type) {
      return;
    }
    await this.applyEdit(document, adapter, { type: 'insert', parentPath, key, value: type.value() });
  }

  private async promptRename(document: vscode.TextDocument, adapter: FormatAdapter, path: BlockPath): Promise<void> {
    const root = adapter.parse(document.getText()).root;
    const parent = findBlock(root, path.slice(0, -1));
    const currentKey = path[path.length - 1];
    if (parent?.kind !== 'object' || typeof currentKey !== 'string') {
      return;
    }

    const existing = siblingKeys(parent.children).filter((key) => key !== currentKey);
    const newKey = await vscode.window.showInputBox({
      title: 'Fileblocks: Rename key',
      value: currentKey,
      validateInput: (value) => validateKey(value, existing),
    });
    if (newKey === undefined || newKey === currentKey) {
      return;
    }
    await this.applyEdit(document, adapter, { type: 'rename', path, newKey });
  }

  private async applyEdit(document: vscode.TextDocument, adapter: FormatAdapter, edit: BlockEdit): Promise<void> {
    const changes = adapter.applyEdit(document.getText(), edit);
    if (!changes) {
      void vscode.window.showWarningMessage(`Fileblocks: could not apply "${edit.type}" to this ${adapter.id} file.`);
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

function siblingKeys(children: { label?: string | number }[] = []): string[] {
  return children.map((child) => String(child.label));
}

function validateKey(value: string, existing: string[]): string | undefined {
  if (value === '') {
    return 'Key cannot be empty';
  }
  return existing.includes(value) ? `"${value}" already exists` : undefined;
}
