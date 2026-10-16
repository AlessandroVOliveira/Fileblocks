import Ajv, { type AnySchemaObject, type ErrorObject, type Options, type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import type { Block, BlockPath } from '../model/block';
import type { SchemaProblem } from '../model/messages';

export type { SchemaProblem };

/**
 * Compiles a schema with the ajv flavour matching its `$schema` (draft-07 by default).
 * `loadSchema` fetches remote `$ref`s.
 */
export async function compileSchema(
  schema: unknown,
  /** Where the schema was loaded from; relative `$ref`s resolve against it when the schema has no `$id`. */
  uri: string,
  loadSchema: (uri: string) => Promise<AnySchemaObject>,
): Promise<ValidateFunction> {
  const source = schema as AnySchemaObject;
  const dialect = typeof source.$schema === 'string' ? source.$schema : '';
  const options: Options = { allErrors: true, strict: false, loadSchema, validateSchema: false };
  const ajv = dialect.includes('2020-12') ? new Ajv2020(options) : dialect.includes('2019-09') ? new Ajv2019(options) : new Ajv(options);
  addFormats(ajv);
  const copy: AnySchemaObject = { ...source, $id: source.$id ?? source.id ?? uri };
  // Older drafts (04/06) declare a meta-schema ajv doesn't ship; their keywords mostly still work.
  if (dialect && !/2019-09|2020-12|draft-07/.test(dialect)) {
    delete copy.$schema;
  }
  return ajv.compileAsync(copy);
}

/**
 * Validates `value` and maps ajv errors to block paths. `root` is the block of the validated
 * value (used to tell array indexes from object keys); `prefix` is prepended to every path
 * (the document index in multi-document YAML).
 */
export function validate(validator: ValidateFunction, value: unknown, root: Block, prefix: BlockPath = []): SchemaProblem[] {
  // `$schema` at the root is how the file points to its schema; it is not part of the data.
  const instance = isPlainObject(value) && '$schema' in value ? { ...value, $schema: undefined } : value;
  if (validator(withoutUndefined(instance))) {
    return [];
  }
  const problems = new Map<string, SchemaProblem>();
  for (const error of validator.errors ?? []) {
    const problem = toProblem(error, root);
    if (!problem) {
      continue;
    }
    const path = [...prefix, ...problem.path];
    const key = `${JSON.stringify(path)}\n${problem.message}`;
    if (!problems.has(key)) {
      problems.set(key, { path, message: problem.message });
    }
  }
  return dropCombinatorNoise([...problems.values()]);
}

function toProblem(error: ErrorObject, root: Block): SchemaProblem | undefined {
  const path = instancePathToBlockPath(error.instancePath, root);
  const params = error.params as Record<string, unknown>;
  switch (error.keyword) {
    case 'required':
      return { path, message: `Missing required property "${String(params.missingProperty)}"` };
    case 'additionalProperties':
      return { path: [...path, String(params.additionalProperty)], message: 'Property is not allowed by the schema' };
    case 'enum':
      return { path, message: `Must be one of: ${(params.allowedValues as unknown[]).map((v) => JSON.stringify(v)).join(', ')}` };
    case 'const':
      return { path, message: `Must be ${JSON.stringify(params.allowedValue)}` };
    case 'if':
      // Always paired with the more specific error from `then`/`else`.
      return undefined;
    default:
      return { path, message: capitalize(error.message ?? 'Invalid value') };
  }
}

/** ajv reports "must match a schema in anyOf" next to each branch's errors; keep it only when nothing more specific exists. */
function dropCombinatorNoise(problems: SchemaProblem[]): SchemaProblem[] {
  return problems.filter((problem) => {
    if (!/^Must match (a schema in anyOf|exactly one schema in oneOf)/.test(problem.message)) {
      return true;
    }
    const prefix = JSON.stringify(problem.path).slice(0, -1);
    return !problems.some((other) => other !== problem && JSON.stringify(other.path).startsWith(prefix));
  });
}

/** `/servers/0/port` -> ['servers', 0, 'port'], using the block tree to tell array indexes from keys. */
export function instancePathToBlockPath(pointer: string, root: Block): BlockPath {
  if (pointer === '') {
    return [];
  }
  const path: BlockPath = [];
  let block: Block | undefined = root;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    const segment: string | number = block?.kind === 'array' ? Number(key) : key;
    path.push(segment);
    block = block?.children?.find((child) => child.label === segment);
  }
  return path;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Drops keys set to undefined (the removed `$schema`) so `additionalProperties: false` doesn't see them. */
function withoutUndefined(value: unknown): unknown {
  return isPlainObject(value) ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) : value;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
