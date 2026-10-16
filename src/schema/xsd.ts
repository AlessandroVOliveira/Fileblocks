import type { ChildNode, Document as DomDocument, Element as DomElement } from 'domhandler';
import { parseDocument } from 'htmlparser2';
import { findBlock, type Block, type BlockPath } from '../model/block';
import type { SchemaHint, SchemaProblem } from '../model/messages';
import type { PropertySuggestion } from './navigator';

/**
 * A practical subset of XML Schema (XSD), evaluated on the block tree:
 * - global/local `element` (name, ref, type, minOccurs/maxOccurs), anonymous types;
 * - `complexType` with sequence/choice/all/group, attribute/attributeGroup/anyAttribute, `any`,
 *   mixed content, simpleContent and complexContent extension;
 * - `simpleType` restrictions (enumeration, min/max inclusive/exclusive, length facets, pattern)
 *   over built-in types (string, integer family, decimal/float/double, boolean, date/time);
 * - `include`/`import` are merged, matching names by local name (namespaces are not checked).
 * Not checked: element order inside a sequence, identity constraints, substitution groups.
 */

export interface XsdSimpleType {
  base: string;
  enumeration?: string[];
  minInclusive?: number;
  maxInclusive?: number;
  minExclusive?: number;
  maxExclusive?: number;
  minLength?: number;
  maxLength?: number;
  length?: number;
  patterns?: string[];
}

interface XsdAttribute {
  name: string;
  required: boolean;
  type: XsdSimpleType;
  documentation?: string;
}

interface XsdChild {
  name: string;
  /** Maximum occurrences (Infinity for unbounded). */
  max: number;
  declaration: DomElement;
}

export interface XsdType {
  documentation?: string;
  attributes: Map<string, XsdAttribute>;
  anyAttribute: boolean;
  children: Map<string, XsdChild>;
  anyElement: boolean;
  /** Each group is satisfied when at least one of its element names is present. */
  requiredGroups: string[][];
  /** Element-only content ('none'), mixed, unconstrained ('any'), or a simple type for the text. */
  text: 'none' | 'mixed' | 'any' | XsdSimpleType;
}

const ANY_TYPE: XsdType = {
  attributes: new Map(),
  anyAttribute: true,
  children: new Map(),
  anyElement: true,
  requiredGroups: [],
  text: 'any',
};

export function parseXsd(text: string): DomDocument {
  return parseDocument(text, { xmlMode: true });
}

/** `xs:include` / `xs:import` locations of a schema document, to load before building the model. */
export function xsdDependencies(document: DomDocument): string[] {
  const schema = schemaElement(document);
  return schema
    ? elementChildren(schema)
        .filter((child) => local(child.name) === 'include' || local(child.name) === 'import')
        .map((child) => child.attribs.schemaLocation)
        .filter((location): location is string => !!location)
    : [];
}

export class XsdModel {
  private readonly globals = {
    element: new Map<string, DomElement>(),
    complexType: new Map<string, DomElement>(),
    simpleType: new Map<string, DomElement>(),
    group: new Map<string, DomElement>(),
    attributeGroup: new Map<string, DomElement>(),
    attribute: new Map<string, DomElement>(),
  };
  private readonly types = new Map<DomElement, XsdType>();
  private readonly simpleTypes = new Map<DomElement, XsdSimpleType>();

  constructor(documents: DomDocument[]) {
    for (const document of documents) {
      const schema = schemaElement(document);
      for (const child of schema ? elementChildren(schema) : []) {
        const kind = local(child.name) as keyof XsdModel['globals'];
        if (kind in this.globals && child.attribs.name && !this.globals[kind].has(child.attribs.name)) {
          this.globals[kind].set(child.attribs.name, child);
        }
      }
    }
  }

  get rootElementNames(): string[] {
    return [...this.globals.element.keys()];
  }

  globalElement(name: string): DomElement | undefined {
    return this.globals.element.get(local(name));
  }

  /** The type of an element declaration (resolving `ref`). */
  typeOf(declaration: DomElement): XsdType {
    const cached = this.types.get(declaration);
    if (cached) {
      return cached;
    }
    // Guard against recursive types while computing.
    this.types.set(declaration, ANY_TYPE);
    const type = this.computeElementType(declaration);
    this.types.set(declaration, type);
    return type;
  }

  documentation(declaration: DomElement): string | undefined {
    const target = declaration.attribs.ref ? this.globalElement(declaration.attribs.ref) ?? declaration : declaration;
    return documentationOf(target) ?? this.typeOf(target).documentation;
  }

  private computeElementType(declaration: DomElement): XsdType {
    if (declaration.attribs.ref) {
      const target = this.globalElement(declaration.attribs.ref);
      return target ? this.typeOf(target) : ANY_TYPE;
    }
    const typeName = declaration.attribs.type;
    if (typeName) {
      const complex = this.globals.complexType.get(local(typeName));
      if (complex) {
        return this.complexType(complex);
      }
      return { ...emptyType(), text: this.simpleType(typeName) };
    }
    const inlineComplex = childNamed(declaration, 'complexType');
    if (inlineComplex) {
      return this.complexType(inlineComplex);
    }
    const inlineSimple = childNamed(declaration, 'simpleType');
    if (inlineSimple) {
      return { ...emptyType(), text: this.simpleTypeFromNode(inlineSimple) };
    }
    return ANY_TYPE;
  }

  private complexType(node: DomElement): XsdType {
    const type = emptyType(node.attribs.mixed === 'true' ? 'mixed' : 'none');
    type.documentation = documentationOf(node);
    this.addComplexContent(type, node);
    return type;
  }

  /** Particles and attributes declared directly in a complexType (or an extension/restriction). */
  private addComplexContent(type: XsdType, node: DomElement): void {
    for (const child of elementChildren(node)) {
      switch (local(child.name)) {
        case 'sequence':
        case 'choice':
        case 'all':
        case 'group':
          this.addParticle(type, child, 1, true);
          break;
        case 'attribute':
          this.addAttribute(type, child);
          break;
        case 'attributeGroup':
          this.addAttributeGroup(type, child);
          break;
        case 'anyAttribute':
          type.anyAttribute = true;
          break;
        case 'simpleContent': {
          const derivation = elementChildren(child).find((c) => ['extension', 'restriction'].includes(local(c.name)));
          if (derivation) {
            const base = derivation.attribs.base ?? '';
            const baseComplex = this.globals.complexType.get(local(base));
            if (baseComplex) {
              const inherited = this.complexType(baseComplex);
              inherited.attributes.forEach((attribute, name) => type.attributes.set(name, attribute));
              type.text = inherited.text;
            } else {
              type.text = { ...this.simpleType(base), ...facetsOf(derivation) };
            }
            this.addComplexContent(type, derivation);
          }
          break;
        }
        case 'complexContent': {
          if (child.attribs.mixed === 'true') {
            type.text = 'mixed';
          }
          const derivation = elementChildren(child).find((c) => ['extension', 'restriction'].includes(local(c.name)));
          if (derivation) {
            const baseComplex = this.globals.complexType.get(local(derivation.attribs.base ?? ''));
            if (baseComplex && local(derivation.name) === 'extension') {
              const base = this.complexType(baseComplex);
              base.attributes.forEach((attribute, name) => type.attributes.set(name, attribute));
              base.children.forEach((element, name) => type.children.set(name, element));
              type.requiredGroups.push(...base.requiredGroups);
              type.anyAttribute ||= base.anyAttribute;
              type.anyElement ||= base.anyElement;
              if (base.text === 'mixed') {
                type.text = 'mixed';
              }
            }
            this.addComplexContent(type, derivation);
          }
          break;
        }
      }
    }
  }

  /**
   * Adds the elements a particle allows. `multiplier` is the product of the enclosing particles'
   * maxOccurs; `required` is whether the enclosing particles are themselves required.
   */
  private addParticle(type: XsdType, node: DomElement, multiplier: number, required: boolean): void {
    const min = Number(node.attribs.minOccurs ?? 1);
    const ownMax = node.attribs.maxOccurs === 'unbounded' ? Infinity : Number(node.attribs.maxOccurs ?? 1);
    const max = multiplier * ownMax;
    const isRequired = required && min > 0;
    switch (local(node.name)) {
      case 'element': {
        const name = local(node.attribs.name ?? node.attribs.ref ?? '');
        if (!name) {
          return;
        }
        const existing = type.children.get(name);
        type.children.set(name, { name, max: (existing?.max ?? 0) + max, declaration: node });
        if (isRequired) {
          type.requiredGroups.push([name]);
        }
        break;
      }
      case 'sequence':
      case 'all':
        elementChildren(node).forEach((child) => this.addParticle(type, child, max, isRequired));
        break;
      case 'choice': {
        elementChildren(node).forEach((child) => this.addParticle(type, child, max, false));
        const names = this.elementNames(node);
        if (isRequired && names.length > 0) {
          type.requiredGroups.push(names);
        }
        break;
      }
      case 'group': {
        const group = node.attribs.ref ? this.globals.group.get(local(node.attribs.ref)) : node;
        const model = group && elementChildren(group).find((c) => ['sequence', 'choice', 'all'].includes(local(c.name)));
        if (model) {
          this.addParticle(type, model, max, isRequired);
        }
        break;
      }
      case 'any':
        type.anyElement = true;
        break;
    }
  }

  private elementNames(node: DomElement): string[] {
    return elementChildren(node).flatMap((child) => {
      const kind = local(child.name);
      if (kind === 'element') {
        return [local(child.attribs.name ?? child.attribs.ref ?? '')].filter(Boolean);
      }
      if (kind === 'group' && child.attribs.ref) {
        const group = this.globals.group.get(local(child.attribs.ref));
        return group ? this.elementNames(group) : [];
      }
      return ['sequence', 'choice', 'all'].includes(kind) ? this.elementNames(child) : [];
    });
  }

  private addAttribute(type: XsdType, node: DomElement): void {
    const name = local(node.attribs.name ?? node.attribs.ref ?? '');
    if (!name || node.attribs.use === 'prohibited') {
      return;
    }
    const declaration = node.attribs.ref ? this.globals.attribute.get(name) ?? node : node;
    const inlineSimple = childNamed(declaration, 'simpleType');
    type.attributes.set(name, {
      name,
      required: node.attribs.use === 'required',
      type: inlineSimple ? this.simpleTypeFromNode(inlineSimple) : this.simpleType(declaration.attribs.type ?? 'string'),
      documentation: documentationOf(node) ?? documentationOf(declaration),
    });
  }

  private addAttributeGroup(type: XsdType, node: DomElement): void {
    const group = node.attribs.ref ? this.globals.attributeGroup.get(local(node.attribs.ref)) : node;
    if (group && group !== node) {
      this.addComplexContent(type, group);
    }
  }

  private simpleType(name: string): XsdSimpleType {
    const node = this.globals.simpleType.get(local(name));
    return node ? this.simpleTypeFromNode(node) : { base: local(name) };
  }

  private simpleTypeFromNode(node: DomElement): XsdSimpleType {
    const cached = this.simpleTypes.get(node);
    if (cached) {
      return cached;
    }
    this.simpleTypes.set(node, { base: 'string' });
    let result: XsdSimpleType = { base: 'string' };
    const restriction = childNamed(node, 'restriction');
    if (restriction) {
      const inner = childNamed(restriction, 'simpleType');
      const base = inner ? this.simpleTypeFromNode(inner) : this.simpleType(restriction.attribs.base ?? 'string');
      result = { ...base, ...facetsOf(restriction) };
    }
    // list / union: accepted as plain strings.
    this.simpleTypes.set(node, result);
    return result;
  }
}

// ---------- validation and hints on the block tree ----------

/** An element block together with the schema type that applies to it. */
interface Visit {
  block: Block;
  type: XsdType;
  declaration: DomElement;
  /** Type of the parent element (undefined at the root). */
  parentType?: XsdType;
}

/** Element blocks in document order, each with its resolved type. Undeclared elements are reported and skipped. */
function walk(root: Block | null, model: XsdModel, problems?: SchemaProblem[]): Visit[] {
  const visits: Visit[] = [];
  const visitElement = (block: Block, declaration: DomElement, parentType?: XsdType) => {
    const type = model.typeOf(declaration);
    visits.push({ block, type, declaration, parentType });
    for (const child of block.children ?? []) {
      if (child.kind !== 'element') {
        continue;
      }
      const childDeclaration = type.children.get(local(child.caption ?? ''))?.declaration;
      if (childDeclaration) {
        visitElement(child, childDeclaration, type);
      } else if (!type.anyElement) {
        problems?.push({ path: child.path, message: `Element <${child.caption}> is not allowed here` });
      }
    }
  };
  const roots = root?.kind === 'element' ? [root] : (root?.children ?? []).filter((child) => child.kind === 'element');
  for (const block of roots) {
    const declaration = model.globalElement(block.caption ?? '');
    if (declaration) {
      visitElement(block, declaration);
    } else {
      problems?.push({ path: block.path, message: `Element <${block.caption}> is not declared in the schema` });
    }
  }
  return visits;
}

export function validateXml(root: Block | null, model: XsdModel): SchemaProblem[] {
  const problems: SchemaProblem[] = [];
  for (const { block, type } of walk(root, model, problems)) {
    const children = block.children ?? [];

    // Attributes
    const attributes = children.filter((child) => child.kind === 'attribute');
    for (const attribute of attributes) {
      const name = String(attribute.label).slice(1);
      if (isNamespaceAttribute(name)) {
        continue;
      }
      const declaration = type.attributes.get(local(name));
      if (!declaration) {
        if (!type.anyAttribute) {
          problems.push({ path: attribute.path, message: 'Attribute is not allowed by the schema' });
        }
        continue;
      }
      const message = checkSimpleValue(String(attribute.value ?? ''), declaration.type);
      if (message) {
        problems.push({ path: attribute.path, message });
      }
    }
    const present = new Set(attributes.map((attribute) => local(String(attribute.label).slice(1))));
    for (const declaration of type.attributes.values()) {
      if (declaration.required && !present.has(declaration.name)) {
        problems.push({ path: block.path, message: `Missing required attribute "${declaration.name}"` });
      }
    }

    // Text content: inline elements carry it as their value, others as #text rows.
    const texts = children.filter((child) => child.kind === 'text');
    const inlineText = block.children === undefined && typeof block.value === 'string' ? block.value : undefined;
    if (type.text === 'none') {
      for (const text of texts) {
        problems.push({ path: text.path, message: 'Text is not allowed here' });
      }
      if (inlineText) {
        problems.push({ path: block.path, message: 'Text is not allowed here' });
      }
    } else if (typeof type.text === 'object') {
      const value = inlineText ?? texts.map((text) => String(text.value ?? '')).join(' ');
      const message = checkSimpleValue(value, type.text);
      if (message) {
        problems.push({ path: texts[0]?.path ?? block.path, message });
      }
    }

    // Child element counts and required children
    const counts = new Map<string, number>();
    for (const child of children) {
      if (child.kind !== 'element') {
        continue;
      }
      const name = local(child.caption ?? '');
      const count = (counts.get(name) ?? 0) + 1;
      counts.set(name, count);
      const max = type.children.get(name)?.max;
      if (max !== undefined && count > max) {
        problems.push({ path: child.path, message: `<${name}> can appear at most ${max} time${max === 1 ? '' : 's'}` });
      }
    }
    for (const group of type.requiredGroups) {
      if (!group.some((name) => counts.has(name))) {
        problems.push({
          path: block.path,
          message: group.length === 1 ? `Missing required element <${group[0]}>` : `Missing one of ${group.map((name) => `<${name}>`).join(', ')}`,
        });
      }
    }
  }
  return problems;
}

export function xsdHints(root: Block | null, model: XsdModel): Record<string, SchemaHint> {
  const hints: Record<string, SchemaHint> = {};
  const add = (id: string, hint: SchemaHint) => {
    if (hint.description || hint.enum || hint.required) {
      hints[id] = hint;
    }
  };
  for (const { block, type, declaration, parentType } of walk(root, model)) {
    const name = local(block.caption ?? '');
    const textEnum = typeof type.text === 'object' ? type.text.enumeration : undefined;
    add(block.id, {
      description: model.documentation(declaration),
      // Inline elements show their text as the row value: offer the enumeration there.
      enum: block.children === undefined ? textEnum : undefined,
      required: parentType?.requiredGroups.some((group) => group.length === 1 && group[0] === name),
    });
    for (const child of block.children ?? []) {
      if (child.kind === 'attribute') {
        const attribute = type.attributes.get(local(String(child.label).slice(1)));
        if (attribute) {
          add(child.id, { description: attribute.documentation, enum: attribute.type.enumeration, required: attribute.required });
        }
      } else if (child.kind === 'text' && textEnum) {
        add(child.id, { enum: textEnum });
      }
    }
  }
  return hints;
}

/** Attributes and child elements the schema allows at an element, for the "+" prompt. */
export function xsdSuggestions(root: Block | null, model: XsdModel, path: BlockPath): { attributes: PropertySuggestion[]; elements: PropertySuggestion[] } {
  const visit = walk(root, model).find((v) => JSON.stringify(v.block.path) === JSON.stringify(path));
  const block = findBlock(root, path);
  if (!visit || !block) {
    return { attributes: [], elements: [] };
  }
  const children = block.children ?? [];
  const presentAttributes = new Set(children.filter((c) => c.kind === 'attribute').map((c) => local(String(c.label).slice(1))));
  const counts = new Map<string, number>();
  children.filter((c) => c.kind === 'element').forEach((c) => counts.set(local(c.caption ?? ''), (counts.get(local(c.caption ?? '')) ?? 0) + 1));
  const requiredElements = new Set(visit.type.requiredGroups.flat());
  const byRequired = (a: PropertySuggestion, b: PropertySuggestion) => Number(b.required) - Number(a.required);
  return {
    attributes: [...visit.type.attributes.values()]
      .filter((attribute) => !presentAttributes.has(attribute.name))
      .map((attribute) => ({ name: attribute.name, description: attribute.documentation, required: attribute.required }))
      .sort(byRequired),
    elements: [...visit.type.children.values()]
      .filter((element) => (counts.get(element.name) ?? 0) < element.max)
      .map((element) => ({ name: element.name, description: model.documentation(element.declaration), required: requiredElements.has(element.name) && !counts.has(element.name) }))
      .sort(byRequired),
  };
}

export function checkSimpleValue(value: string, type: XsdSimpleType): string | undefined {
  const trimmed = value.trim();
  if (type.enumeration && !type.enumeration.includes(trimmed)) {
    return `Must be one of: ${type.enumeration.map((v) => JSON.stringify(v)).join(', ')}`;
  }
  const base = type.base;
  if (INTEGER_TYPES.has(base)) {
    if (!/^[+-]?\d+$/.test(trimmed)) {
      return 'Must be an integer';
    }
    const number = Number(trimmed);
    if ((base === 'positiveInteger' && number < 1) || (NON_NEGATIVE.has(base) && number < 0)) {
      return base === 'positiveInteger' ? 'Must be greater than 0' : 'Must not be negative';
    }
    if ((base === 'negativeInteger' && number >= 0) || (base === 'nonPositiveInteger' && number > 0)) {
      return base === 'negativeInteger' ? 'Must be less than 0' : 'Must not be positive';
    }
  } else if (['decimal', 'float', 'double'].includes(base)) {
    if (trimmed === '' || Number.isNaN(Number(trimmed))) {
      return 'Must be a number';
    }
  } else if (base === 'boolean') {
    if (!['true', 'false', '1', '0'].includes(trimmed)) {
      return 'Must be true or false';
    }
  } else if (base === 'date' && !(/^-?\d{4,}-\d{2}-\d{2}(Z|[+-]\d{2}:\d{2})?$/.test(trimmed) && isRealDate(trimmed))) {
    return 'Must be a date (YYYY-MM-DD)';
  } else if (base === 'dateTime' && !(/^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(trimmed) && isRealDate(trimmed))) {
    return 'Must be a date and time (YYYY-MM-DDThh:mm:ss)';
  } else if (base === 'time' && !/^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(trimmed)) {
    return 'Must be a time (hh:mm:ss)';
  }

  const number = Number(trimmed);
  if (type.minInclusive !== undefined && number < type.minInclusive) {
    return `Must be at least ${type.minInclusive}`;
  }
  if (type.maxInclusive !== undefined && number > type.maxInclusive) {
    return `Must be at most ${type.maxInclusive}`;
  }
  if (type.minExclusive !== undefined && number <= type.minExclusive) {
    return `Must be greater than ${type.minExclusive}`;
  }
  if (type.maxExclusive !== undefined && number >= type.maxExclusive) {
    return `Must be less than ${type.maxExclusive}`;
  }
  if (type.length !== undefined && value.length !== type.length) {
    return `Must be exactly ${type.length} characters long`;
  }
  if (type.minLength !== undefined && value.length < type.minLength) {
    return `Must be at least ${type.minLength} characters long`;
  }
  if (type.maxLength !== undefined && value.length > type.maxLength) {
    return `Must be at most ${type.maxLength} characters long`;
  }
  // Several patterns in one restriction are alternatives.
  if (type.patterns?.length && !type.patterns.some((pattern) => safeFullMatch(pattern, value))) {
    return `Must match the pattern ${type.patterns.join(' | ')}`;
  }
  return undefined;
}

/** Whether the YYYY-MM-DD part names a day that exists (rejects month 13, Feb 30…). */
function isRealDate(value: string): boolean {
  const [, year, month, day] = /^(-?\d{4,})-(\d{2})-(\d{2})/.exec(value) ?? [];
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCMonth() === Number(month) - 1 && date.getUTCDate() === Number(day);
}

// ---------- DOM helpers ----------

const INTEGER_TYPES = new Set([
  'integer', 'int', 'long', 'short', 'byte',
  'nonNegativeInteger', 'positiveInteger', 'nonPositiveInteger', 'negativeInteger',
  'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte',
]);
const NON_NEGATIVE = new Set(['nonNegativeInteger', 'unsignedLong', 'unsignedInt', 'unsignedShort', 'unsignedByte']);

function emptyType(text: XsdType['text'] = 'none'): XsdType {
  return { attributes: new Map(), anyAttribute: false, children: new Map(), anyElement: false, requiredGroups: [], text };
}

function facetsOf(restriction: DomElement): Partial<XsdSimpleType> {
  const facets: Partial<XsdSimpleType> = {};
  const enumeration: string[] = [];
  const patterns: string[] = [];
  for (const facet of elementChildren(restriction)) {
    const value = facet.attribs.value;
    if (value === undefined) {
      continue;
    }
    switch (local(facet.name)) {
      case 'enumeration':
        enumeration.push(value);
        break;
      case 'pattern':
        patterns.push(value);
        break;
      case 'minInclusive':
      case 'maxInclusive':
      case 'minExclusive':
      case 'maxExclusive':
      case 'minLength':
      case 'maxLength':
      case 'length':
        facets[local(facet.name) as 'minInclusive'] = Number(value);
        break;
    }
  }
  if (enumeration.length > 0) {
    facets.enumeration = enumeration;
  }
  if (patterns.length > 0) {
    facets.patterns = patterns;
  }
  return facets;
}

function schemaElement(document: DomDocument): DomElement | undefined {
  return elementChildren(document).find((child) => local(child.name) === 'schema');
}

function elementChildren(node: DomElement | DomDocument): DomElement[] {
  return (node.children as ChildNode[]).filter((child): child is DomElement => child.type === 'tag');
}

function childNamed(node: DomElement, name: string): DomElement | undefined {
  return elementChildren(node).find((child) => local(child.name) === name);
}

function documentationOf(node: DomElement): string | undefined {
  const documentation = childNamed(node, 'annotation') && childNamed(childNamed(node, 'annotation')!, 'documentation');
  const text = documentation ? textContent(documentation).replace(/\s+/g, ' ').trim() : '';
  return text || undefined;
}

function textContent(node: DomElement): string {
  return (node.children as ChildNode[]).map((child) => (child.type === 'text' ? child.data : child.type === 'tag' ? textContent(child) : '')).join('');
}

/** Name without namespace prefix. */
function local(name: string): string {
  return name.slice(name.indexOf(':') + 1);
}

function isNamespaceAttribute(name: string): boolean {
  return name === 'xmlns' || name.startsWith('xmlns:') || name.startsWith('xsi:');
}

/** XSD patterns are implicitly anchored; most of their syntax matches JavaScript regexes. */
function safeFullMatch(pattern: string, value: string): boolean {
  try {
    return new RegExp(`^(?:${pattern})$`, 'u').test(value);
  } catch {
    return true;
  }
}
