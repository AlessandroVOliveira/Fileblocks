import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathToId } from '../src/model/block';
import { createMarkupAdapter } from '../src/parsers/markupAdapter';
import { inlineSchemaReference, schemaSettings } from '../src/schema/association';
import { checkSimpleValue, parseXsd, validateXml, xsdDependencies, xsdHints, XsdModel, xsdSuggestions } from '../src/schema/xsd';

const xml = createMarkupAdapter('xml');
const xsdText = readFileSync('samples/catalog.xsd', 'utf8');
const xmlText = readFileSync('samples/catalog.xml', 'utf8');
const model = new XsdModel([parseXsd(xsdText)]);
const { root } = xml.parse(xmlText);

test('finds the schema location in the XML and in xml.fileAssociations', () => {
  assert.equal(inlineSchemaReference(xmlText, 'xml'), 'catalog.xsd');
  assert.equal(inlineSchemaReference('<a xmlns:xsi="x" xsi:schemaLocation="urn:a  a.xsd"/>', 'xml'), 'a.xsd');
  assert.equal(inlineSchemaReference('<a/>', 'xml'), undefined);
  assert.deepEqual(schemaSettings(undefined, undefined, 'xml', [{ pattern: '**/*.cfg.xml', systemId: 'cfg.xsd' }]), [
    { url: 'cfg.xsd', fileMatch: ['**/*.cfg.xml'] },
  ]);
});

test('validates attributes, text, child elements and occurrences', () => {
  const problems = validateXml(root, model).map((p) => `${JSON.stringify(p.path)} ${p.message}`);
  // Paths: catalog children are [@xmlns:xsi, @xsi:..., @version, @updated, title(0), book(1), book(2), magazine(3)]
  assert.deepEqual(problems.sort(), [
    '["@updated"] Must be a date (YYYY-MM-DD)',
    '[1,"@available"] Must be true or false',
    '[1,2] Must be at least 0',
    '[1,3] Must be one of: "hardcover", "paperback", "ebook"',
    '[2,"@isbn"] Must match the pattern \\d{13}',
    '[2,4] <author> can appear at most 3 times',
    '[2] Missing required element <price>',
    '[3] Element <magazine> is not allowed here',
  ].sort());
});

test('reports undeclared roots and missing required attributes', () => {
  assert.deepEqual(validateXml(xml.parse('<shop/>').root, model), [{ path: [], message: 'Element <shop> is not declared in the schema' }]);
  const missing = validateXml(xml.parse('<catalog><title>t</title><book isbn="1234567890123"><name>n</name><author>a</author><price>1</price></book></catalog>').root, model);
  assert.deepEqual(missing, [{ path: [], message: 'Missing required attribute "version"' }]);
});

test('hints: documentation, required and enumerations', () => {
  const hints = xsdHints(root, model);
  assert.equal(hints[pathToId([])]?.description, 'A list of books for sale.');
  assert.equal(hints[pathToId([1, 0])]?.description, 'Book title as printed on the cover.');
  assert.equal(hints[pathToId([1, 0])]?.required, true);
  assert.equal(hints[pathToId([1, '@isbn'])]?.description, '13-digit ISBN.');
  assert.equal(hints[pathToId([1, '@isbn'])]?.required, true);
  assert.deepEqual(hints[pathToId([1, 3])]?.enum, ['hardcover', 'paperback', 'ebook']);
});

test('suggestions for the + prompt skip what is present or full', () => {
  const second = xsdSuggestions(root, model, [2]);
  assert.deepEqual(second.attributes.map((a) => a.name), ['available']);
  // <name> is already there and may appear once; <author> is at its maximum (4 > 3).
  assert.deepEqual(second.elements.map((e) => [e.name, e.required]), [['price', true], ['format', false]]);
});

test('simple type checks', () => {
  assert.equal(checkSimpleValue('12', { base: 'positiveInteger' }), undefined);
  assert.equal(checkSimpleValue('0', { base: 'positiveInteger' }), 'Must be greater than 0');
  assert.equal(checkSimpleValue('abc', { base: 'int' }), 'Must be an integer');
  assert.equal(checkSimpleValue('2026-01-31', { base: 'date' }), undefined);
  assert.equal(checkSimpleValue('2026-02-30', { base: 'date' }), 'Must be a date (YYYY-MM-DD)');
  assert.equal(checkSimpleValue('toolong', { base: 'string', maxLength: 3 }), 'Must be at most 3 characters long');
});

test('include/import locations are listed for loading', () => {
  const doc = parseXsd('<xs:schema xmlns:xs="x"><xs:include schemaLocation="common.xsd"/><xs:import namespace="n" schemaLocation="other.xsd"/></xs:schema>');
  assert.deepEqual(xsdDependencies(doc), ['common.xsd', 'other.xsd']);
});
