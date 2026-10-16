import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { pathToId } from '../src/model/block';
import { createMarkupAdapter } from '../src/parsers/markupAdapter';
import { doctypeOf, DtdModel, parseContentModel } from '../src/schema/dtd';
import { validateXml, xsdHints, xsdSuggestions } from '../src/schema/xsd';

const xml = createMarkupAdapter('xml');
const dtdText = readFileSync('samples/notes.dtd', 'utf8');
const xmlText = readFileSync('samples/notes.xml', 'utf8');
const model = new DtdModel(dtdText);
const { root } = xml.parse(xmlText);

test('reads the DOCTYPE: system id, public id and internal subset', () => {
  assert.deepEqual(doctypeOf(xmlText), { root: 'notes', systemId: 'notes.dtd', internalSubset: undefined });
  assert.deepEqual(doctypeOf('<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0//EN" "xhtml1.dtd">'), { root: 'html', systemId: 'xhtml1.dtd', internalSubset: undefined });
  assert.deepEqual(doctypeOf('<!DOCTYPE a [\n  <!ELEMENT a (#PCDATA)>\n]>\n<a/>'), { root: 'a', systemId: undefined, internalSubset: '<!ELEMENT a (#PCDATA)>' });
  assert.equal(doctypeOf('<a/>'), undefined);
});

test('parses content models with sequences, choices and occurrences', () => {
  assert.deepEqual(parseContentModel('(a, (b | c)+, d?)'), {
    kind: 'sequence',
    min: 1,
    max: 1,
    items: [
      { kind: 'element', name: 'a', min: 1, max: 1 },
      { kind: 'choice', min: 1, max: Infinity, items: [{ kind: 'element', name: 'b', min: 1, max: 1 }, { kind: 'element', name: 'c', min: 1, max: 1 }] },
      { kind: 'element', name: 'd', min: 0, max: 1 },
    ],
  });
});

test('validates against the DTD with the shared XML validator', () => {
  // notes children: [@version, owner(0), note(1), note(2), memo(3)]
  const problems = validateXml(root, model).map((p) => `${JSON.stringify(p.path)} ${p.message}`);
  assert.deepEqual(problems.sort(), [
    '["@version"] Must be one of: "1.0"',
    '[1,"@priority"] Must be one of: "low", "normal", "high"',
    '[1,1,3] Missing required attribute "href"',
    '[1,3,"@name"] Must match the pattern [\\w.:-]+',
    '[2,"@archived"] Must be one of: "yes", "no"',
    '[2] Missing required attribute "id"',
    '[2] Missing required element <title>',
    '[3] Element <memo> is not allowed here',
  ].sort());
});

test('mixed content allows text and the listed elements; EMPTY allows nothing', () => {
  const ok = validateXml(xml.parse('<body>text <em>x</em><link href="u">l</link></body>').root, model);
  assert.deepEqual(ok, []);
  const bad = validateXml(xml.parse('<body><title>t</title></body>').root, model);
  assert.deepEqual(bad, [{ path: [0], message: 'Element <title> is not allowed here' }]);
  assert.deepEqual(validateXml(xml.parse('<tag name="a">text</tag>').root, model), [{ path: [0], message: 'Text is not allowed here' }]);
});

test('internal subset declarations come first and parameter entities expand', () => {
  const internal = new DtdModel('<!ELEMENT owner (first, last)> <!ELEMENT first (#PCDATA)> <!ELEMENT last (#PCDATA)>\n' + dtdText);
  assert.deepEqual(validateXml(xml.parse('<owner>Jane</owner>').root, internal).map((p) => p.message), [
    'Text is not allowed here',
    'Missing required element <first>',
    'Missing required element <last>',
  ]);
});

test('comments before <!ELEMENT> become documentation; + suggestions', () => {
  const hints = xsdHints(root, model);
  assert.equal(hints[pathToId([])]?.description, 'A collection of notes.');
  assert.equal(hints[pathToId([1])]?.description, 'One note: a title, a body and optional tags.');
  assert.equal(hints[pathToId([1, '@id'])]?.required, true);
  assert.deepEqual(hints[pathToId([2, '@archived'])]?.enum, ['yes', 'no']);
  const suggestions = xsdSuggestions(root, model, [2]);
  assert.deepEqual(suggestions.attributes.map((a) => [a.name, a.required]), [['id', true], ['priority', false]]);
  assert.deepEqual(suggestions.elements.map((e) => e.name), ['title', 'tag']);
});

test('a DOCTYPE with an internal subset does not leak into the XML tree', () => {
  const text = '<?xml version="1.0"?>\n<!DOCTYPE a [\n  <!ELEMENT a (b)>\n  <!ELEMENT b (#PCDATA)>\n]>\n<a><b>x</b></a>\n';
  const { root } = xml.parse(text);
  assert.equal(root?.kind, 'element');
  assert.equal(root?.caption, 'a');
  const internal = new DtdModel(doctypeOf(text)!.internalSubset!);
  assert.deepEqual(validateXml(root, internal), []);
});
