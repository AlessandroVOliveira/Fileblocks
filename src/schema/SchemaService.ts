import type { AnySchemaObject, ValidateFunction } from 'ajv';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import * as vscode from 'vscode';
import { parse as parseYaml } from 'yaml';
import { findBlock, type Block, type BlockPath } from '../model/block';
import type { SchemaHint, SchemaInfo, SchemaProblem } from '../model/messages';
import type { FormatAdapter } from '../parsers';
import { fileMatches, inlineSchemaReference, schemaSettings } from './association';
import { hintsFor, resolveUri, SchemaNavigator } from './navigator';
import { compileSchema, validate } from './validate';

export interface SchemaReference {
  uri: string;
  /** Inline schema from `json.schemas[].schema`. */
  inline?: unknown;
}

export interface LoadedSchema {
  uri: string;
  name: string;
  navigator: SchemaNavigator;
  validator: ValidateFunction;
}

const DOWNLOAD_TIMEOUT_MS = 15_000;
const OVERRIDES_KEY = 'fileblocks.schemaOverrides';

/** A schema chosen with "Select Schema…": a URI, or null for "no schema". */
type Override = string | null;

/**
 * Finds, loads and compiles the JSON Schema of a document. Shared by all open editors, so a
 * schema is downloaded and compiled once. Caches are dropped when a loaded schema file is
 * saved or the schema settings change; `onDidChange` tells editors to refresh.
 */
export class SchemaService implements vscode.Disposable {
  private readonly documents = new Map<string, Promise<unknown>>();
  private readonly compiled = new Map<string, Promise<LoadedSchema>>();
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly subscriptions: vscode.Disposable[];
  readonly onDidChange = this.changed.event;

  constructor(private readonly state: vscode.Memento) {
    this.subscriptions = [
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (this.documents.has(document.uri.toString())) {
          this.clear();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (['json.schemas', 'yaml.schemas', 'json.schemaDownload.enable'].some((section) => e.affectsConfiguration(section))) {
          this.clear();
        }
      }),
    ];
  }

  dispose(): void {
    this.subscriptions.forEach((d) => d.dispose());
    this.changed.dispose();
  }

  /** The schema that applies to a document: its own reference first, then `json.schemas` / `yaml.schemas`. */
  locate(document: vscode.TextDocument, format: string): SchemaReference | undefined {
    const override = this.overrides()[document.uri.toString()];
    if (override !== undefined) {
      return override === null ? undefined : { uri: override };
    }
    const inline = inlineSchemaReference(document.getText(), format);
    if (inline) {
      return { uri: resolveUri(inline, document.uri.toString()) };
    }
    const settings = schemaSettings(
      vscode.workspace.getConfiguration('json').get('schemas'),
      vscode.workspace.getConfiguration('yaml').get('schemas'),
      format,
    );
    const relative = vscode.workspace.asRelativePath(document.uri, false);
    const folder = vscode.workspace.getWorkspaceFolder(document.uri)?.uri;
    for (const [i, setting] of settings.entries()) {
      if (!setting.fileMatch.some((pattern) => fileMatches(pattern, relative) || fileMatches(pattern, document.uri.path))) {
        continue;
      }
      if (setting.schema !== undefined) {
        return { uri: `inmemory://fileblocks/settings-${i}.json`, inline: setting.schema };
      }
      if (setting.url) {
        return { uri: resolveUri(setting.url, folder ? `${folder.toString()}/` : document.uri.toString()) };
      }
    }
    return undefined;
  }

  /** Sets (URI), disables (null) or clears (undefined) the schema chosen for a document. */
  async setOverride(document: vscode.Uri, override: Override | undefined): Promise<void> {
    const overrides = { ...this.overrides() };
    if (override === undefined) {
      delete overrides[document.toString()];
    } else {
      overrides[document.toString()] = override;
    }
    await this.state.update(OVERRIDES_KEY, overrides);
    this.changed.fire();
  }

  hasOverride(document: vscode.Uri): boolean {
    return document.toString() in this.overrides();
  }

  private overrides(): Record<string, Override> {
    return this.state.get<Record<string, Override>>(OVERRIDES_KEY, {});
  }

  load(reference: SchemaReference): Promise<LoadedSchema> {
    let loaded = this.compiled.get(reference.uri);
    if (!loaded) {
      loaded = this.compile(reference);
      this.compiled.set(reference.uri, loaded);
      // Don't cache failures: a later refresh retries (e.g. after fixing the schema or going online).
      loaded.catch(() => this.compiled.delete(reference.uri));
    }
    return loaded;
  }

  /** Problems and hints for every value of the document the schema applies to. */
  info(loaded: LoadedSchema, adapter: FormatAdapter, text: string, root: Block | null): SchemaInfo {
    const problems: SchemaProblem[] = [];
    const hints: Record<string, SchemaHint> = {};
    for (const instance of adapter.instances?.(text) ?? []) {
      const block = instance.prefix.length > 0 ? findBlock(root, instance.prefix) : root;
      if (block) {
        problems.push(...validate(loaded.validator, instance.value, block, instance.prefix));
        Object.assign(hints, hintsFor(block, loaded.navigator, instance.prefix.length));
      }
    }
    return { name: loaded.name, uri: loaded.uri, problems, hints };
  }

  /** Path inside the validated value (drops the document index of multi-document YAML). */
  static schemaPath(adapter: FormatAdapter, text: string, path: BlockPath): BlockPath {
    const prefix = adapter.instances?.(text).find((instance) => instance.prefix.every((segment, i) => path[i] === segment))?.prefix ?? [];
    return path.slice(prefix.length);
  }

  private clear(): void {
    this.documents.clear();
    this.compiled.clear();
    this.changed.fire();
  }

  private async compile(reference: SchemaReference): Promise<LoadedSchema> {
    const root = reference.inline ?? (await this.fetch(reference.uri));
    const documents = new Map<string, unknown>();
    const register = (uri: string, document: unknown) => {
      documents.set(withoutFragment(uri), document);
      // Schemas often declare an absolute `$id` that their own `$ref`s resolve against.
      const id = (document as { $id?: unknown })?.$id;
      if (typeof id === 'string' && /^[a-z][\w+.-]*:/i.test(id)) {
        documents.set(withoutFragment(id), document);
      }
    };
    register(reference.uri, root);

    const validator = await compileSchema(root, reference.uri, async (uri) => {
      const document = await this.fetch(withoutFragment(uri));
      register(uri, document);
      return document as AnySchemaObject;
    });
    const title = (root as { title?: unknown })?.title;
    return {
      uri: reference.uri,
      name: typeof title === 'string' ? title : decodeURIComponent(reference.uri.split(/[/\\]/).pop() ?? reference.uri),
      navigator: new SchemaNavigator(withoutFragment(reference.uri), documents),
      validator,
    };
  }

  private fetch(uri: string): Promise<unknown> {
    let document = this.documents.get(uri);
    if (!document) {
      document = this.read(uri);
      this.documents.set(uri, document);
      document.catch(() => this.documents.delete(uri));
    }
    return document;
  }

  private async read(uri: string): Promise<unknown> {
    const parsed = vscode.Uri.parse(uri);
    if (parsed.scheme === 'http' || parsed.scheme === 'https') {
      if (!vscode.workspace.getConfiguration('json').get<boolean>('schemaDownload.enable', true)) {
        throw new Error('Schema download is disabled (json.schemaDownload.enable)');
      }
      const response = await fetch(uri, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} while loading ${uri}`);
      }
      return parseSchemaText(await response.text(), uri);
    }
    const bytes = await vscode.workspace.fs.readFile(parsed);
    return parseSchemaText(new TextDecoder().decode(bytes), uri);
  }
}

function parseSchemaText(text: string, uri: string): unknown {
  if (/\.ya?ml$/i.test(withoutFragment(uri))) {
    return parseYaml(text);
  }
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown;
  if (value === undefined || (errors.length > 0 && typeof value !== 'object')) {
    throw new Error(`${uri} is not valid JSON`);
  }
  return value;
}

function withoutFragment(uri: string): string {
  return uri.split('#')[0];
}
