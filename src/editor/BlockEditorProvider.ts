import * as vscode from 'vscode';
import { findBlock, findBlockAt, type Block, type BlockPath } from '../model/block';
import { convertValue, typeOf, type ValueType } from '../model/convert';
import type { BlockEdit, HostToWebview, InsertValue, SchemaInfo, WebviewToHost } from '../model/messages';
import { getAdapter, type FormatAdapter } from '../parsers';
import type { PropertySuggestion } from '../schema/navigator';
import { SchemaService, type LoadedSchema, type SchemaReference } from '../schema/SchemaService';
import { xsdSuggestions } from '../schema/xsd';
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

/** The schema state of one editor: which schema applies, and its load result. */
interface EditorSchema {
  reference: SchemaReference;
  loaded?: LoadedSchema;
  error?: string;
}

/** Formats checked against a schema: JSON Schema for JSON/YAML/TOML, XSD for XML. */
const SCHEMA_FORMATS = new Set(['json', 'yaml', 'toml', 'xml']);

/** Debounce for re-parsing while the user types in the text editor. */
const UPDATE_DELAY_MS = 50;

/**
 * Custom text editor: the TextDocument stays the source of truth (so undo/redo, save
 * and dirty state work natively). The webview only renders blocks and sends edits back.
 */
export class BlockEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'fileblocks.blockEditor';

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const schemas = new SchemaService(context.workspaceState);
    const provider = new BlockEditorProvider(context, schemas);
    return vscode.Disposable.from(
      schemas,
      vscode.window.registerCustomEditorProvider(BlockEditorProvider.viewType, provider, { supportsMultipleEditorsPerDocument: true }),
      vscode.commands.registerCommand('fileblocks.selectSchema', () => {
        if (provider.activeEditor) {
          void provider.promptSelectSchema(provider.activeEditor.document);
        }
      }),
      vscode.commands.registerCommand('fileblocks.exportImage', () => {
        if (provider.activeEditor) {
          void provider.promptExport(provider.activeEditor.webview);
        }
      }),
    );
  }

  /** The focused block editor, for commands run from the palette. */
  private activeEditor: { document: vscode.TextDocument; webview: vscode.Webview } | undefined;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly schemas: SchemaService,
  ) {}

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const adapter = getAdapter(document);
    const webview = panel.webview;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')],
    };
    webview.html = getWebviewHtml(webview, this.context.extensionUri);

    // JSON Schema for this document: re-located on every update (the file's `$schema` can change),
    // loaded asynchronously; when loading finishes the graph is updated again.
    let schema: EditorSchema | undefined;
    const refreshSchema = (force = false) => {
      const reference = adapter && SCHEMA_FORMATS.has(adapter.id) ? this.schemas.locate(document, adapter.id) : undefined;
      if (!force && reference?.uri === schema?.reference.uri) {
        return;
      }
      const current: EditorSchema | undefined = reference && { reference };
      schema = current;
      if (!current) {
        return;
      }
      this.schemas.load(current.reference).then(
        (loaded) => (current.loaded = loaded),
        (error: unknown) => (current.error = error instanceof Error ? error.message : String(error)),
      ).finally(() => {
        if (schema === current) {
          postUpdate();
        }
      });
    };

    const postUpdate = () => {
      refreshSchema();
      const text = document.getText();
      const result = adapter ? adapter.parse(text) : { root: null, errors: [{ message: `Unsupported format: ${document.languageId}` }] };
      const message: HostToWebview = {
        type: 'update',
        format: adapter?.id ?? document.languageId,
        ...result,
        schema: schema && adapter ? this.schemaInfo(schema, adapter, text, result.root) : undefined,
      };
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
      this.schemas.onDidChange(() => {
        refreshSchema(true);
        postUpdate();
      }),
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
              void this.promptInsert(document, adapter, message.parentPath, schema?.loaded);
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
          case 'export':
            void this.promptExport(webview);
            break;
          case 'image':
            void this.saveImage(document, message);
            break;
          case 'selectSchema':
            void this.promptSelectSchema(document);
            break;
          case 'openText':
            void vscode.commands.executeCommand('vscode.openWith', document.uri, 'default', vscode.ViewColumn.Beside);
            break;
        }
      }),
    ];

    const editor = { document, webview };
    if (panel.active) {
      this.activeEditor = editor;
    }
    subscriptions.push(
      panel.onDidChangeViewState(() => {
        if (panel.active) {
          this.activeEditor = editor;
        }
      }),
    );
    panel.onDidDispose(() => {
      subscriptions.forEach((d) => d.dispose());
      if (this.activeEditor === editor) {
        this.activeEditor = undefined;
      }
    });
  }

  /** Asks for PNG or SVG, then has the webview render the graph (it answers with an 'image' message). */
  private async promptExport(webview: vscode.Webview): Promise<void> {
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'PNG', description: 'Bitmap image', format: 'png' as const },
        { label: 'SVG', description: 'Vector image', format: 'svg' as const },
      ],
      { title: 'Fileblocks: Export Graph as Image' },
    );
    if (choice) {
      const message: HostToWebview = { type: 'renderImage', format: choice.format };
      void webview.postMessage(message);
    }
  }

  private async saveImage(document: vscode.TextDocument, image: Extract<WebviewToHost, { type: 'image' }>): Promise<void> {
    if (image.error || !image.dataUrl) {
      void vscode.window.showErrorMessage(`Fileblocks: could not export the graph: ${image.error ?? 'empty image'}`);
      return;
    }
    const baseName = document.uri.path.split('/').pop()?.replace(/\.[^.]+$/, '') || 'graph';
    const target = await vscode.window.showSaveDialog({
      title: 'Export Graph as Image',
      defaultUri: vscode.Uri.joinPath(document.uri, '..', `${baseName}.${image.format}`),
      filters: image.format === 'png' ? { 'PNG image': ['png'] } : { 'SVG image': ['svg'] },
    });
    if (!target) {
      return;
    }
    const payload = image.dataUrl.slice(image.dataUrl.indexOf(',') + 1);
    // html-to-image returns base64 for PNG and a URI-encoded string for SVG.
    const bytes = image.format === 'png' ? Buffer.from(payload, 'base64') : new TextEncoder().encode(decodeURIComponent(payload));
    await vscode.workspace.fs.writeFile(target, bytes);
    void vscode.window.showInformationMessage(`Fileblocks: graph exported to ${vscode.workspace.asRelativePath(target)}`);
  }

  /** "Select Schema…": pick a file or URL for this document, go back to automatic detection, or turn the schema off. */
  private async promptSelectSchema(document: vscode.TextDocument): Promise<void> {
    type Choice = { label: string; action: 'file' | 'url' | 'auto' | 'none' };
    const items: Choice[] = [
      { label: '$(file) Browse for a schema file…', action: 'file' },
      { label: '$(globe) Enter a schema URL…', action: 'url' },
      ...(this.schemas.hasOverride(document.uri) ? [{ label: "$(discard) Use the file's own schema or the settings", action: 'auto' as const }] : []),
      { label: '$(circle-slash) No schema for this file', action: 'none' },
    ];
    const choice = await vscode.window.showQuickPick(items, { title: 'Fileblocks: Select Schema' });
    if (!choice) {
      return;
    }
    if (choice.action === 'file') {
      const [file] =
        (await vscode.window.showOpenDialog({
          title: 'Select Schema',
          canSelectMany: false,
          defaultUri: vscode.Uri.joinPath(document.uri, '..'),
          filters: { Schemas: ['json', 'xsd', 'yaml', 'yml'], 'All files': ['*'] },
        })) ?? [];
      if (file) {
        await this.schemas.setOverride(document.uri, file.toString());
      }
    } else if (choice.action === 'url') {
      const url = await vscode.window.showInputBox({
        title: 'Select Schema',
        prompt: 'Schema URL',
        placeHolder: 'https://json.schemastore.org/package.json',
        validateInput: (value) => (/^https?:\/\/\S+$/.test(value) ? undefined : 'Enter an http(s) URL'),
      });
      if (url) {
        await this.schemas.setOverride(document.uri, url);
      }
    } else {
      await this.schemas.setOverride(document.uri, choice.action === 'none' ? null : undefined);
    }
  }

  private schemaInfo(
    schema: EditorSchema,
    adapter: FormatAdapter,
    text: string,
    root: Block | null,
  ): SchemaInfo {
    if (schema.loaded) {
      return this.schemas.info(schema.loaded, adapter, text, root);
    }
    const name = decodeURIComponent(schema.reference.uri.split('/').pop() ?? schema.reference.uri);
    return { name, uri: schema.reference.uri, loading: !schema.error, error: schema.error, problems: [], hints: {} };
  }

  private async promptInsert(document: vscode.TextDocument, adapter: FormatAdapter, parentPath: BlockPath, schema?: LoadedSchema): Promise<void> {
    const text = document.getText();
    const root = adapter.parse(text).root;
    const parent = findBlock(root, parentPath);
    if (parent?.kind === 'element' && !parent.readOnly) {
      return this.promptInsertMarkup(document, adapter, parent, schema?.kind === 'xsd' ? xsdSuggestions(root, schema.model, parentPath) : undefined);
    }
    if ((parent?.kind !== 'object' && parent?.kind !== 'array') || parent.readOnly) {
      return;
    }
    const title = 'Fileblocks: Add entry';
    const schemaPath = SchemaService.schemaPath(adapter, text, parentPath);
    const navigator = schema?.kind === 'json' ? schema.navigator : undefined;

    let key: string | undefined;
    if (parent.kind === 'object') {
      const existing = siblingKeys(parent.children);
      // With a schema, offer the properties it defines (required first) before free typing.
      const suggestions = navigator?.properties(schemaPath).filter((property) => !existing.includes(property.name)) ?? [];
      key = await pickName(title, suggestions, 'Property to add', 'Key for the new entry', (value) => validateKey(value, existing));
      if (key === undefined) {
        return;
      }
    }

    // The schema's default / enum / type decides the initial value; otherwise ask for a type.
    const childSegment = parent.kind === 'array' ? (parent.children?.length ?? 0) : key!;
    let value = navigator?.defaultValue([...schemaPath, childSegment]);
    if (value === undefined) {
      const type = await vscode.window.showQuickPick(VALUE_TYPES, { title, placeHolder: 'Type of the new value' });
      if (!type) {
        return;
      }
      value = type.value();
    }
    await this.applyEdit(document, adapter, { type: 'insert', parentPath, key, value });
  }

  /** XML/HTML: an element can get a child element, an attribute or text. With an XSD, its names are offered first. */
  private async promptInsertMarkup(
    document: vscode.TextDocument,
    adapter: FormatAdapter,
    parent: Block,
    suggestions?: { attributes: PropertySuggestion[]; elements: PropertySuggestion[] },
  ): Promise<void> {
    const title = `Fileblocks: Add to <${parent.caption}>`;
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Child element', what: 'element' as const },
        { label: 'Attribute', what: 'attribute' as const },
        { label: 'Text', what: 'text' as const },
      ],
      { title, placeHolder: 'What to add' },
    );
    if (!choice) {
      return;
    }

    if (choice.what === 'text') {
      const text = await vscode.window.showInputBox({ title, prompt: 'Text content' });
      if (text) {
        await this.applyEdit(document, adapter, { type: 'insert', parentPath: parent.path, key: '#text', value: text });
      }
      return;
    }

    const existing = choice.what === 'attribute' ? attributeNames(parent) : [];
    const name = await pickName(
      title,
      (choice.what === 'attribute' ? suggestions?.attributes : suggestions?.elements) ?? [],
      choice.what === 'attribute' ? 'Attribute to add' : 'Element to add',
      choice.what === 'attribute' ? 'Attribute name' : 'Tag name',
      (value) => validateMarkupName(value, choice.what, existing),
    );
    if (name === undefined) {
      return;
    }
    const edit: BlockEdit =
      choice.what === 'attribute'
        ? { type: 'insert', parentPath: parent.path, key: `@${name}`, value: '' }
        : { type: 'insert', parentPath: parent.path, key: name, value: {} };
    await this.applyEdit(document, adapter, edit);
  }

  private async promptChangeType(document: vscode.TextDocument, adapter: FormatAdapter, path: BlockPath): Promise<void> {
    const block = findBlock(adapter.parse(document.getText()).root, path);
    if (!block || block.readOnly || (block.kind !== 'object' && block.kind !== 'array' && block.kind !== 'scalar')) {
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
    const block = findBlock(root, path);
    const parent = path.length > 0 ? findBlock(root, path.slice(0, -1)) : undefined;
    if (!block) {
      return;
    }

    let current: string;
    let validate: (value: string) => string | undefined;
    if (block.kind === 'element') {
      current = block.caption ?? '';
      validate = (value) => validateMarkupName(value, 'element', []);
    } else if (block.kind === 'attribute' && parent) {
      current = String(block.label).slice(1);
      const existing = attributeNames(parent).filter((name) => name !== current);
      validate = (value) => validateMarkupName(value, 'attribute', existing);
    } else if (parent?.kind === 'object' && typeof block.label === 'string') {
      current = block.label;
      const existing = siblingKeys(parent.children).filter((key) => key !== current);
      validate = (value) => validateKey(value, existing);
    } else {
      return;
    }

    const newKey = await vscode.window.showInputBox({ title: 'Fileblocks: Rename', value: current, validateInput: validate });
    if (newKey === undefined || newKey === current) {
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

/**
 * Asks for a key/name: the schema's suggestions first (required ones marked), with "Other…" for free
 * typing; without suggestions, straight to the input box. Undefined when cancelled.
 */
async function pickName(
  title: string,
  suggestions: PropertySuggestion[],
  placeHolder: string,
  prompt: string,
  validate: (value: string) => string | undefined,
): Promise<string | undefined> {
  if (suggestions.length > 0) {
    const items = [
      ...suggestions.map((s) => ({ label: s.name, description: s.required ? 'required' : undefined, detail: s.description, name: s.name as string | undefined })),
      { label: '$(edit) Other…', name: undefined },
    ];
    const picked = await vscode.window.showQuickPick(items, { title, placeHolder, matchOnDetail: true });
    if (!picked) {
      return undefined;
    }
    if (picked.name !== undefined) {
      return picked.name;
    }
  }
  return vscode.window.showInputBox({ title, prompt, validateInput: validate });
}

function attributeNames(element: Block): string[] {
  return (element.children ?? []).filter((child) => child.kind === 'attribute').map((child) => String(child.label).slice(1));
}

/** Tag names follow XML naming; attribute names only exclude characters that would break the tag (allows `@click`, `:class`). */
function validateMarkupName(value: string, what: 'element' | 'attribute', existing: string[]): string | undefined {
  const valid = what === 'element' ? /^[A-Za-z_][\w.\-:]*$/ : /^[^\s"'>/=]+$/;
  if (!valid.test(value)) {
    return what === 'element' ? 'Not a valid tag name' : 'Not a valid attribute name';
  }
  return existing.includes(value) ? `"${value}" already exists` : undefined;
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
