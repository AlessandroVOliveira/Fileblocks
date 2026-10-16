import { parse as parseJsonc } from 'jsonc-parser';

/**
 * The schema a file points to itself:
 * - JSON: a root `"$schema": "<uri>"` property;
 * - YAML: a `# yaml-language-server: $schema=<uri>` modeline (the Red Hat YAML convention),
 *   or a root `$schema: <uri>` key;
 * - TOML: a `#:schema <uri>` directive (the Taplo convention);
 * - XML: `xsi:noNamespaceSchemaLocation`, or the first location of `xsi:schemaLocation`.
 */
export function inlineSchemaReference(text: string, format: string): string | undefined {
  if (format === 'json') {
    const value = parseJsonc(text, [], { allowTrailingComma: true }) as unknown;
    const reference = value !== null && typeof value === 'object' ? (value as Record<string, unknown>).$schema : undefined;
    return typeof reference === 'string' ? reference : undefined;
  }
  if (format === 'yaml') {
    const modeline = /^#\s*yaml-language-server:\s*\$schema=(\S+)/m.exec(text);
    if (modeline) {
      return modeline[1];
    }
    return /^\$schema:\s*["']?([^"'\s#]+)/m.exec(text)?.[1];
  }
  if (format === 'toml') {
    // Taplo's `#:schema <uri>` directive.
    return /^#:schema\s+(\S+)/m.exec(text)?.[1];
  }
  if (format === 'xml') {
    const noNamespace = /\b(?:[\w.-]+:)?noNamespaceSchemaLocation\s*=\s*["']\s*([^"'\s]+)/.exec(text);
    if (noNamespace) {
      return noNamespace[1];
    }
    // Pairs of "namespace location": take the first location.
    return /\b(?:[\w.-]+:)?schemaLocation\s*=\s*["']\s*\S+\s+([^"'\s]+)/.exec(text)?.[1];
  }
  return undefined;
}

/**
 * Whether a `fileMatch` / `yaml.schemas` glob applies to a file. Patterns are matched against the
 * end of the path, like VS Code does: `package.json` matches any package.json, `/config/*.json`
 * only those under a `config` folder, `**` spans folders. Negated patterns (`!x`) never match.
 */
export function fileMatches(pattern: string, filePath: string): boolean {
  if (pattern.startsWith('!')) {
    return false;
  }
  const path = filePath.replace(/\\/g, '/');
  const glob = pattern.replace(/\\/g, '/').replace(/^\.?\//, '');
  const source = glob
    .split(/(\*\*\/?|\*|\?)/)
    .map((part) => {
      if (part === '**/' || part === '**') {
        return '(?:.*/)?';
      }
      if (part === '*') {
        return '[^/]*';
      }
      if (part === '?') {
        return '[^/]';
      }
      return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`(?:^|/)${source}$`, 'i').test(path);
}

export interface SchemaSetting {
  /** Schema location as written in the setting (absolute URI or workspace-relative path). */
  url?: string;
  /** Inline schema (`json.schemas[].schema`). */
  schema?: unknown;
  fileMatch: string[];
}

/**
 * Reads `json.schemas` (array of { fileMatch, url | schema }), `yaml.schemas` ({ url: glob | glob[] })
 * and, for XML, `xml.fileAssociations` (array of { pattern, systemId }, the Red Hat XML convention).
 */
export function schemaSettings(jsonSchemas: unknown, yamlSchemas: unknown, format: string, xmlAssociations?: unknown): SchemaSetting[] {
  const settings: SchemaSetting[] = [];
  if (format === 'xml') {
    for (const entry of Array.isArray(xmlAssociations) ? xmlAssociations : []) {
      if (entry && typeof entry.pattern === 'string' && typeof entry.systemId === 'string') {
        settings.push({ url: entry.systemId, fileMatch: [entry.pattern] });
      }
    }
    return settings;
  }
  if (Array.isArray(jsonSchemas)) {
    for (const entry of jsonSchemas) {
      if (entry && typeof entry === 'object' && Array.isArray(entry.fileMatch)) {
        settings.push({ url: typeof entry.url === 'string' ? entry.url : undefined, schema: entry.schema, fileMatch: entry.fileMatch.filter((p: unknown) => typeof p === 'string') });
      }
    }
  }
  if (format === 'yaml' && yamlSchemas && typeof yamlSchemas === 'object') {
    for (const [url, globs] of Object.entries(yamlSchemas as Record<string, unknown>)) {
      const fileMatch = (Array.isArray(globs) ? globs : [globs]).filter((p): p is string => typeof p === 'string');
      settings.push({ url, fileMatch });
    }
  }
  return settings;
}
