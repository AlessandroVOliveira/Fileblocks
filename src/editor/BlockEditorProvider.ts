import * as vscode from 'vscode';
import { findBlock, findBlockAt, type Block, type BlockPath } from '../model/block';
import { convertValue, typeOf, type ValueType } from '../model/convert';
import type { BlockEdit, HostToWebview, InsertValue, WebviewToHost } from '../model/messages';
import { getAdapter, type FormatAdapter } from '../parsers';
import { getWebviewHtml } from './webviewHtml';

interface ValueTypeItem extends vscode.QuickPickItem {
  type: ValueType;
  /** Default value for a new entry of this type. */
  value: () => InsertValue;
}

const VALUE_TYPES: ValueTypeItem[] = [
  { label: 'String', type: 'string', value: () => '' },
  { label: 'Number', type: 'number', value: () => 0 },
  { label: 'Boolean', type: 'boolean', value: () => false },
  { label: 'Null', type: 'null', value: () => null },
  { label: 'Object', type: 'object', value: () => ({}) },
  { label: 'Array', type: 'array', value: () => [] },
];

/** Debounce for re-parsing while the user types in the text editor. */
const UPDATE_DELAY_MS = 50;

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

    // Cursor moves are frequent: reuse the parse until the document changes.
    let parsed: { version: number; root: Block | null } | undefined;
    const currentRoot = () => {
      if (parsed?.version !== document.version) {
        parsed = { version: document.version, root: adapter?.parse(document.getText()).root ?? null };
      }
      return parsed.root;
    };

    const postSelection = (path: BlockPath | null) => {
      const message: HostToWebview = { type: 'selection', path };
      void webview.postMessage(message);
    };

    let selectionTimer: ReturnType<typeof setTimeout> | undefined;
    const isUserSelection = (kind: vscode.TextEditorSelectionChangeKind | undefined) =>
      kind === vscode.TextEditorSelectionChangeKind.Keyboard || kind === vscode.TextEditorSelectionChangeKind.Mouse;

    let updateTimer: ReturnType<typeof setTimeout> | undefined;

    const subscriptions = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === document.uri.toString()) {
          clearTimeout(updateTimer);
          updateTimer = setTimeout(postUpdate, UPDATE_DELAY_MS);
        }
      }),
      { dispose: () => clearTimeout(updateTimer) },
      // Follow the text editor's cursor in the graph. Selections made by the extension itself
      // (revealing a block) have kind Command and are skipped, so the two never ping-pong.
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor.document.uri.toString() !== document.uri.toString() || !isUserSelection(e.kind)) {
          return;
        }
        clearTimeout(selectionTimer);
        selectionTimer = setTimeout(() => {
          const offset = document.offsetAt(e.selections[0].active);
          postSelection(findBlockAt(currentRoot(), offset)?.path ?? null);
        }, 75);
      }),
      { dispose: () => clearTimeout(selectionTimer) },
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
          case 'changeType':
            if (adapter) {
              void this.promptChangeType(document, adapter, message.path);
            }
            break;
          case 'reveal':
            if (adapter) {
              postSelection(message.path);
              void this.revealInText(document, adapter, message.path);
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
    if ((parent?.kind !== 'object' && parent?.kind !== 'array') || parent.readOnly) {
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

  private async promptChangeType(document: vscode.TextDocument, adapter: FormatAdapter, path: BlockPath): Promise<void> {
    const block = findBlock(adapter.parse(document.getText()).root, path);
    if (!block || block.readOnly) {
      return;
    }
    const current = typeOf(block);
    const items = VALUE_TYPES.map((item) => ({ ...item, description: item.type === current ? 'current' : undefined }));
    const picked = await vscode.window.showQuickPick(items, { title: 'Fileblocks: Change type', placeHolder: `Convert from ${current} to…` });
    if (!picked || picked.type === current) {
      return;
    }

    const childCount = block.children?.length ?? 0;
    if (childCount > 0) {
      const confirm = `Convert to ${picked.label}`;
      const answer = await vscode.window.showWarningMessage(
        `"${String(block.label ?? 'root')}" has ${childCount} item(s) that will be removed (Ctrl+Z undoes it).`,
        { modal: true },
        confirm,
      );
      if (answer !== confirm) {
        return;
      }
    }
    await this.applyEdit(document, adapter, { type: 'setValue', path, value: convertValue(block, picked.type) });
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

  /** Selects the block's source in the text editor beside the graph, reusing one if it is already visible. */
  private async revealInText(document: vscode.TextDocument, adapter: FormatAdapter, path: BlockPath): Promise<void> {
    const range = findBlock(adapter.parse(document.getText()).root, path)?.range;
    if (!range) {
      return;
    }
    const selection = new vscode.Range(document.positionAt(range.offset), document.positionAt(range.offset + range.length));
    const visible = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === document.uri.toString());
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: visible?.viewColumn ?? vscode.ViewColumn.Beside,
      // Keep focus on the graph so the user can keep clicking through it.
      preserveFocus: true,
      selection,
    });
    editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
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
