import type { Block, BlockPath } from '../model/block';
import type { InsertValue, SchemaHint } from '../model/messages';

export type { SchemaHint };

/** A JSON Schema object (boolean schemas are treated as "anything"). */
export type SchemaObject = Record<string, unknown>;

/** A schema together with the URI its relative `$ref`s resolve against. */
interface Located {
  schema: SchemaObject;
  base: string;
}

export interface PropertySuggestion {
  name: string;
  description?: string;
  required: boolean;
}

/**
 * Walks a JSON Schema along block paths. Combinators are merged rather than evaluated:
 * `allOf`/`anyOf`/`oneOf` branches all contribute properties, enums and descriptions,
 * which is what an editor wants for hints (validation itself is done by ajv).
 */
export class SchemaNavigator {
  /**
   * @param documents schema documents by absolute URI (without fragment), including the root
   */
  constructor(
    private readonly rootUri: string,
    private readonly documents: ReadonlyMap<string, unknown>,
  ) {}

  /** Schemas that apply at a path. Empty when the schema says nothing about it. */
  at(path: BlockPath): Located[] {
    let current = this.expand([{ schema: asObject(this.documents.get(this.rootUri)), base: this.rootUri }]);
    for (const segment of path) {
      current = this.expand(current.flatMap((located) => childSchemas(located, segment)));
      if (current.length === 0) {
        break;
      }
    }
    return current;
  }

  hint(path: BlockPath): SchemaHint {
    const here = this.at(path);
    const hint: SchemaHint = {};
    const description = firstString(here, 'description') ?? firstString(here, 'title');
    if (description) {
      hint.description = description;
    }
    const values = enumValues(here);
    if (values) {
      hint.enum = values;
    }
    const key = path[path.length - 1];
    if (typeof key === 'string' && this.requiredKeys(path.slice(0, -1)).includes(key)) {
      hint.required = true;
    }
    return hint;
  }

  requiredKeys(path: BlockPath): string[] {
    return unique(this.at(path).flatMap(({ schema }) => (Array.isArray(schema.required) ? schema.required.filter(isString) : [])));
  }

  /** Properties the schema defines for the object at `path`, required ones first. */
  properties(path: BlockPath): PropertySuggestion[] {
    const here = this.at(path);
    const required = new Set(this.requiredKeys(path));
    const byName = new Map<string, PropertySuggestion>();
    for (const located of here) {
      const properties = asObject(located.schema.properties);
      for (const [name, value] of Object.entries(properties)) {
        if (!byName.has(name)) {
          const property = this.expand([{ schema: asObject(value), base: located.base }]);
          byName.set(name, { name, description: firstString(property, 'description') ?? firstString(property, 'title'), required: required.has(name) });
        }
      }
    }
    return [...byName.values()].sort((a, b) => Number(b.required) - Number(a.required));
  }

  /** A sensible initial value for a new entry at `path`: the schema default, the first enum value, or the type's empty value. */
  defaultValue(path: BlockPath): InsertValue | undefined {
    const here = this.at(path);
    for (const { schema } of here) {
      if ('default' in schema && isInsertable(schema.default)) {
        return schema.default;
      }
    }
    const values = enumValues(here);
    if (values?.length && isInsertable(values[0])) {
      return values[0];
    }
    const types = unique(here.flatMap(({ schema }) => (Array.isArray(schema.type) ? schema.type : [schema.type]).filter(isString)));
    if (types.length !== 1) {
      return undefined;
    }
    return { string: '', number: 0, integer: 0, boolean: false, null: null, object: {}, array: [] }[types[0]] as InsertValue | undefined;
  }

  /** Follows `$ref`s and flattens combinators into a list of plain schemas. */
  private expand(list: Located[], seen = new Set<SchemaObject>()): Located[] {
    const result: Located[] = [];
    for (const located of list) {
      const { schema } = located;
      if (seen.has(schema)) {
        continue;
      }
      seen.add(schema);
      const base = typeof schema.$id === 'string' ? resolveUri(schema.$id, located.base) : located.base;
      result.push({ schema, base });
      if (typeof schema.$ref === 'string') {
        const target = this.resolveRef(schema.$ref, base);
        if (target) {
          result.push(...this.expand([target], seen));
        }
      }
      for (const keyword of ['allOf', 'anyOf', 'oneOf']) {
        const branches = schema[keyword];
        if (Array.isArray(branches)) {
          result.push(...this.expand(branches.map((branch) => ({ schema: asObject(branch), base })), seen));
        }
      }
    }
    return result;
  }

  private resolveRef(ref: string, base: string): Located | undefined {
    const absolute = resolveUri(ref, base);
    const [uri, fragment = ''] = absolute.split('#');
    const document = this.documents.get(uri);
    if (document === undefined) {
      return undefined;
    }
    const target = fragment.startsWith('/') || fragment === '' ? resolvePointer(document, fragment) : findAnchor(document, fragment);
    return target === undefined ? undefined : { schema: asObject(target), base: uri };
  }
}

function childSchemas({ schema, base }: Located, segment: string | number): Located[] {
  const at = (value: unknown) => (value === undefined || value === false ? [] : [{ schema: asObject(value), base }]);
  if (typeof segment === 'number') {
    if (Array.isArray(schema.prefixItems) && segment < schema.prefixItems.length) {
      return at(schema.prefixItems[segment]);
    }
    if (Array.isArray(schema.items)) {
      // draft-07 tuple form
      return segment < schema.items.length ? at(schema.items[segment]) : at(schema.additionalItems);
    }
    return at(schema.items);
  }
  const properties = asObject(schema.properties);
  if (segment in properties) {
    return at(properties[segment]);
  }
  const matching = Object.entries(asObject(schema.patternProperties)).filter(([pattern]) => safeTest(pattern, segment));
  if (matching.length > 0) {
    return matching.flatMap(([, value]) => at(value));
  }
  return typeof schema.additionalProperties === 'object' ? at(schema.additionalProperties) : [];
}

function enumValues(list: Located[]): unknown[] | undefined {
  const values = list.flatMap(({ schema }) => (Array.isArray(schema.enum) ? schema.enum : 'const' in schema ? [schema.const] : []));
  if (values.length === 0) {
    return undefined;
  }
  return values.filter((value, i) => values.findIndex((other) => JSON.stringify(other) === JSON.stringify(value)) === i);
}

function firstString(list: Located[], keyword: string): string | undefined {
  for (const { schema } of list) {
    if (typeof schema[keyword] === 'string') {
      return schema[keyword];
    }
  }
  return undefined;
}

/** JSON Pointer (RFC 6901) lookup, e.g. `/definitions/server`. */
export function resolvePointer(document: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '/') {
    return pointer === '' ? document : (document as Record<string, unknown>)?.[''];
  }
  let current: unknown = document;
  for (const raw of pointer.slice(1).split('/')) {
    const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** `$anchor` (2019+) or draft-07 `$id: "#name"` lookup. */
function findAnchor(document: unknown, name: string): unknown {
  const stack = [document];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node && typeof node === 'object') {
      const object = node as Record<string, unknown>;
      if (object.$anchor === name || object.$id === `#${name}`) {
        return object;
      }
      stack.push(...Object.values(object));
    }
  }
  return undefined;
}

export function resolveUri(ref: string, base: string): string {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}

/** Maps a block tree to the hint of every block, keyed by block id. Only non-empty hints are kept. */
export function hintsFor(root: Block, navigator: SchemaNavigator, prefixLength = 0): Record<string, SchemaHint> {
  const hints: Record<string, SchemaHint> = {};
  const visit = (block: Block) => {
    const hint = navigator.hint(block.path.slice(prefixLength));
    if (hint.description || hint.enum || hint.required) {
      hints[block.id] = hint;
    }
    block.children?.forEach(visit);
  };
  visit(root);
  return hints;
}

function asObject(value: unknown): SchemaObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as SchemaObject) : {};
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Only scalars and empty containers can be inserted by the editor. */
function isInsertable(value: unknown): value is InsertValue {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return true;
  }
  return Array.isArray(value) ? value.length === 0 : typeof value === 'object' && Object.keys(value as object).length === 0;
}

function safeTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, 'u').test(value);
  } catch {
    return false;
  }
}
