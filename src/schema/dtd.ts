import { ANY_TYPE, emptyType, type ElementSchema, type XsdSimpleType, type XsdType } from './xsd';

/**
 * DTD support, producing the same element model as the XSD subset so validation, hints and
 * suggestions are shared:
 * - `<!ELEMENT>` with EMPTY, ANY, (#PCDATA), mixed content `(#PCDATA|a|b)*` and children models
 *   with `,` `|` and `? * +`;
 * - `<!ATTLIST>` with CDATA/ID/NMTOKEN…/enumerated types and #REQUIRED / #IMPLIED / #FIXED defaults;
 * - parameter entities (`<!ENTITY % name "…">` / `%name;`) declared in the DTD itself;
 * - the comment right before an `<!ELEMENT>` becomes the element's documentation.
 * Element order inside a sequence is not checked (same as for XSD).
 */

interface ElementDeclaration {
  name: string;
  content: string;
  documentation?: string;
}

interface AttributeDeclaration {
  name: string;
  type: string;
  enumeration?: string[];
  required: boolean;
  fixed?: string;
}

type Particle =
  | { kind: 'element'; name: string; min: number; max: number }
  | { kind: 'sequence' | 'choice'; items: Particle[]; min: number; max: number };

/** Where an XML document points to its DTD: `<!DOCTYPE root SYSTEM "x.dtd" [ internal subset ]>`. */
export interface Doctype {
  root: string;
  systemId?: string;
  internalSubset?: string;
}

export function doctypeOf(text: string): Doctype | undefined {
  const match = /<!DOCTYPE\s+([^\s[>]+)(?:\s+(?:SYSTEM\s+(["'])(.*?)\2|PUBLIC\s+(["'])(?:.*?)\4\s+(["'])(.*?)\5))?\s*(?:\[([\s\S]*?)\]\s*)?>/.exec(text);
  if (!match) {
    return undefined;
  }
  const systemId = match[3] ?? match[6];
  const internalSubset = match[7]?.trim();
  return { root: match[1], systemId: systemId || undefined, internalSubset: internalSubset || undefined };
}

export class DtdModel implements ElementSchema {
  private readonly elements = new Map<string, ElementDeclaration>();
  private readonly attributes = new Map<string, Map<string, AttributeDeclaration>>();
  private readonly types = new Map<string, XsdType>();

  /** @param text DTD declarations (internal subset first, then the external DTD: the first declaration wins). */
  constructor(text: string) {
    for (const declaration of scanDeclarations(expandParameterEntities(text))) {
      if (declaration.keyword === 'ELEMENT') {
        const [, name, content] = /^(\S+)\s+([\s\S]*)$/.exec(declaration.body) ?? [];
        if (name && !this.elements.has(name)) {
          this.elements.set(name, { name, content: content.trim(), documentation: declaration.comment });
        }
      } else if (declaration.keyword === 'ATTLIST') {
        this.addAttributes(declaration.body);
      }
    }
  }

  get elementNames(): string[] {
    return [...this.elements.keys()];
  }

  /** Any declared element can be a root (the DOCTYPE names the actual one). Declarations are element names. */
  globalElement(name: string): string | undefined {
    return this.elements.has(name) ? name : undefined;
  }

  documentation(declaration: string): string | undefined {
    return this.elements.get(declaration)?.documentation;
  }

  typeOf(declaration: string): XsdType {
    let type = this.types.get(declaration);
    if (!type) {
      type = this.computeType(declaration);
      this.types.set(declaration, type);
    }
    return type;
  }

  private computeType(name: string): XsdType {
    const element = this.elements.get(name);
    if (!element) {
      return ANY_TYPE;
    }
    const spec = element.content;
    let type: XsdType;
    if (spec === 'EMPTY') {
      type = emptyType('none');
    } else if (spec === 'ANY') {
      type = { ...emptyType('mixed'), anyElement: true };
    } else if (spec.includes('#PCDATA')) {
      // (#PCDATA) or mixed content (#PCDATA|a|b)*: text plus any number of the listed elements.
      type = emptyType('mixed');
      for (const child of spec.match(/[^\s()|,*+?#]+/g)?.filter((token) => token !== 'PCDATA') ?? []) {
        type.children.set(child, { name: child, max: Infinity, declaration: child });
      }
    } else {
      type = emptyType('none');
      const particle = parseContentModel(spec);
      if (particle) {
        addParticle(type, particle, 1, true);
      }
    }
    type.documentation = element.documentation;
    for (const attribute of this.attributes.get(name)?.values() ?? []) {
      const simple: XsdSimpleType = { base: 'string' };
      if (attribute.fixed !== undefined) {
        simple.enumeration = [attribute.fixed];
      } else if (attribute.enumeration) {
        simple.enumeration = attribute.enumeration;
      } else if (attribute.type === 'NMTOKEN') {
        simple.patterns = ['[\\w.:-]+'];
      }
      type.attributes.set(attribute.name, { name: attribute.name, required: attribute.required, type: simple });
    }
    return type;
  }

  private addAttributes(body: string): void {
    const tokens = body.match(/\([^)]*\)|"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
    const element = tokens.shift();
    if (!element) {
      return;
    }
    const declared = this.attributes.get(element) ?? new Map<string, AttributeDeclaration>();
    this.attributes.set(element, declared);
    while (tokens.length >= 2) {
      const name = tokens.shift()!;
      let type = tokens.shift()!;
      let enumeration: string[] | undefined;
      if (type === 'NOTATION') {
        type = tokens.shift() ?? '';
      }
      if (type.startsWith('(')) {
        enumeration = type.slice(1, -1).split('|').map((value) => value.trim()).filter(Boolean);
      }
      const defaultDeclaration = tokens.shift();
      let required = false;
      let fixed: string | undefined;
      if (defaultDeclaration === '#REQUIRED') {
        required = true;
      } else if (defaultDeclaration === '#FIXED') {
        fixed = unquote(tokens.shift() ?? '');
      }
      // A plain default value ("x") and #IMPLIED need nothing more. The first declaration wins.
      if (!declared.has(name)) {
        declared.set(name, { name, type, enumeration, required, fixed });
      }
    }
  }
}

/** Same flattening as for XSD particles: allowed children, maximum counts and required groups. */
function addParticle(type: XsdType, particle: Particle, multiplier: number, required: boolean): void {
  const max = multiplier * particle.max;
  const isRequired = required && particle.min > 0;
  if (particle.kind === 'element') {
    const existing = type.children.get(particle.name);
    type.children.set(particle.name, { name: particle.name, max: (existing?.max ?? 0) + max, declaration: particle.name });
    if (isRequired) {
      type.requiredGroups.push([particle.name]);
    }
    return;
  }
  if (particle.kind === 'sequence') {
    particle.items.forEach((item) => addParticle(type, item, max, isRequired));
    return;
  }
  particle.items.forEach((item) => addParticle(type, item, max, false));
  const names = elementNames(particle);
  if (isRequired && names.length > 0) {
    type.requiredGroups.push(names);
  }
}

function elementNames(particle: Particle): string[] {
  return particle.kind === 'element' ? [particle.name] : particle.items.flatMap(elementNames);
}

/** Parses a children content model such as `(head, (p | list)+, foot?)`. */
export function parseContentModel(spec: string): Particle | undefined {
  const tokens = spec.match(/[(),|?*+]|[^\s(),|?*+]+/g) ?? [];
  let position = 0;

  const occurrence = (): { min: number; max: number } => {
    const token = tokens[position];
    if (token === '?' || token === '*' || token === '+') {
      position++;
      return { min: token === '+' ? 1 : 0, max: token === '?' ? 1 : Infinity };
    }
    return { min: 1, max: 1 };
  };

  const particle = (): Particle | undefined => {
    const token = tokens[position++];
    if (token === undefined) {
      return undefined;
    }
    if (token !== '(') {
      return { kind: 'element', name: token, ...occurrence() };
    }
    const items: Particle[] = [];
    let kind: 'sequence' | 'choice' = 'sequence';
    while (position < tokens.length && tokens[position] !== ')') {
      const item = particle();
      if (item) {
        items.push(item);
      }
      if (tokens[position] === ',' || tokens[position] === '|') {
        kind = tokens[position] === '|' ? 'choice' : 'sequence';
        position++;
      }
    }
    position++; // ')'
    return { kind, items, ...occurrence() };
  };

  return particle();
}

interface Declaration {
  keyword: string;
  body: string;
  /** The comment right before the declaration, if any. */
  comment?: string;
}

/** Splits a DTD into `<!KEYWORD …>` declarations (quotes may contain `>`), remembering the preceding comment. */
function scanDeclarations(text: string): Declaration[] {
  const declarations: Declaration[] = [];
  let comment: string | undefined;
  let position = 0;
  while ((position = text.indexOf('<!', position)) !== -1) {
    if (text.startsWith('<!--', position)) {
      const end = text.indexOf('-->', position + 4);
      comment = text.slice(position + 4, end === -1 ? undefined : end).replace(/\s+/g, ' ').trim() || undefined;
      position = end === -1 ? text.length : end + 3;
      continue;
    }
    let end = position + 2;
    let quote: string | undefined;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quote) {
        if (char === quote) {
          quote = undefined;
        }
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '>') {
        break;
      }
    }
    const [, keyword, body] = /^<!(\w+)\s*([\s\S]*)$/.exec(text.slice(position, end)) ?? [];
    if (keyword) {
      declarations.push({ keyword, body: body.trim(), comment: keyword === 'ELEMENT' ? comment : undefined });
    }
    comment = undefined;
    position = end + 1;
  }
  return declarations;
}

/** Substitutes `%name;` with the values of `<!ENTITY % name "…">` declared in the DTD. */
function expandParameterEntities(text: string): string {
  const entities = new Map<string, string>();
  for (const [, name, , value] of text.matchAll(/<!ENTITY\s+%\s+([\w.:-]+)\s+(["'])([\s\S]*?)\2\s*>/g)) {
    if (!entities.has(name)) {
      entities.set(name, value);
    }
  }
  let expanded = text;
  // Entities can reference each other; a few passes cover realistic nesting without looping forever.
  for (let pass = 0; pass < 10 && /%[\w.:-]+;/.test(expanded); pass++) {
    expanded = expanded.replace(/%([\w.:-]+);/g, (reference, name: string) => entities.get(name) ?? reference);
  }
  return expanded;
}

function unquote(value: string): string {
  return /^(["']).*\1$/s.test(value) ? value.slice(1, -1) : value;
}
