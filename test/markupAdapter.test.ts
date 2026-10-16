import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findBlock, findBlockAt, type Block } from '../src/model/block';
import { createMarkupAdapter } from '../src/parsers/markupAdapter';
import { edit } from './helpers';

const xml = createMarkupAdapter('xml');
const html = createMarkupAdapter('html');

const source = `<?xml version="1.0"?>
<project name="demo" version='3'>
  <!-- authors -->
  <author email="jane@example.com">Jane &amp; co</author>
  <tags>
    <tag>json</tag>
    <tag>yaml</tag>
  </tags>
  <empty/>
  <none></none>
</project>
`;

const slice = (text: string, block: Block | undefined) => text.slice(block!.range!.offset, block!.range!.offset + block!.range!.length);

test('parses elements, attributes and text into blocks', () => {
  const { root, errors } = xml.parse(source);
  assert.deepEqual(errors, []);
  assert.equal(root?.kind, 'element');
  assert.equal(root?.caption, 'project');
  assert.deepEqual(
    root?.children?.map((c) => c.caption ?? c.label),
    ['@name', '@version', 'author', 'tags', 'empty', 'none'],
  );
  const author = findBlock(root, [0])!;
  assert.deepEqual(author.children?.map((c) => [c.kind, c.label, c.value]), [
    ['attribute', '@email', 'jane@example.com'],
    ['text', 0, 'Jane & co'],
  ]);
  assert.equal(findBlock(root, ['@version'])?.value, '3');
});

test('ranges cover elements, attributes and trimmed text', () => {
  const { root } = xml.parse(source);
  assert.equal(slice(source, findBlock(root, [0, '@email'])), 'email="jane@example.com"');
  assert.equal(slice(source, findBlock(root, [0, 0])), 'Jane &amp; co');
  assert.equal(slice(source, findBlock(root, [1, 1])), '<tag>yaml</tag>');
  assert.deepEqual(findBlockAt(root, source.indexOf('yaml'))?.path, [1, 1, 0]);
});

test('setValue edits attribute values and text, escaping them', () => {
  assert.equal(edit(xml, source, { type: 'setValue', path: ['@name'], value: 'a "b" & c' }), source.replace('name="demo"', 'name="a &quot;b&quot; &amp; c"'));
  assert.equal(edit(xml, source, { type: 'setValue', path: ['@version'], value: "4'" }), source.replace("version='3'", "version='4&#39;'"));
  assert.equal(edit(xml, source, { type: 'setValue', path: [0, 0], value: 'Bob <3' }), source.replace('Jane &amp; co', 'Bob &lt;3'));
});

test('rename changes attribute names and both tags of an element', () => {
  assert.equal(edit(xml, source, { type: 'rename', path: [0, '@email'], newKey: 'mail' }), source.replace('email=', 'mail='));
  assert.equal(edit(xml, source, { type: 'rename', path: [0], newKey: 'owner' }), source.replace('<author email', '<owner email').replace('</author>', '</owner>'));
  assert.equal(edit(xml, source, { type: 'rename', path: [2], newKey: 'blank' }), source.replace('<empty/>', '<blank/>'));
  assert.equal(xml.applyEdit(source, { type: 'rename', path: ['@name'], newKey: 'version' }), undefined);
});

test('remove deletes attributes and whole lines of elements', () => {
  assert.equal(edit(xml, source, { type: 'remove', path: ['@version'] }), source.replace(" version='3'", ''));
  assert.equal(edit(xml, source, { type: 'remove', path: [1, 0] }), source.replace('    <tag>json</tag>\n', ''));
  assert.equal(xml.applyEdit(source, { type: 'remove', path: [] }), undefined);
});

test('insert adds attributes, elements and text following the layout', () => {
  assert.equal(edit(xml, source, { type: 'insert', parentPath: [1], key: '@kind', value: '' }), source.replace('<tags>', '<tags kind="">'));
  assert.equal(
    edit(xml, source, { type: 'insert', parentPath: [1], key: 'tag', value: {} }),
    source.replace('<tag>yaml</tag>\n', '<tag>yaml</tag>\n    <tag/>\n'),
  );
  assert.equal(edit(xml, source, { type: 'insert', parentPath: [2], key: '#text', value: 'x' }), source.replace('<empty/>', '<empty>x</empty>'));
  assert.equal(
    edit(xml, source, { type: 'insert', parentPath: [3], key: 'child', value: {} }),
    source.replace('<none></none>', '<none>\n    <child/>\n  </none>'),
  );
});

test('move reorders elements and attributes, keeping the layout', () => {
  // Block children are [@name, @version, author, tags, empty, none]: toIndex counts attributes first.
  assert.equal(
    edit(xml, source, { type: 'move', path: [1, 1], toIndex: 0 }),
    source.replace('<tag>json</tag>\n    <tag>yaml</tag>', '<tag>yaml</tag>\n    <tag>json</tag>'),
  );
  assert.equal(edit(xml, source, { type: 'move', path: ['@version'], toIndex: 0 }), source.replace(`name="demo" version='3'`, `version='3' name="demo"`));
  const moved = edit(xml, source, { type: 'move', path: [3], toIndex: 2 });
  assert.ok(moved.indexOf('<none>') < moved.indexOf('<author'), moved);
  assert.ok(moved.includes('<!-- authors -->'));
});

const page = `<!DOCTYPE html>
<ul class=list>
  <li>One
  <li disabled>Two</li>
</ul>
<P>Hi <b>there</b></P>`;

test('HTML: implied end tags, valueless and unquoted attributes, tag case', () => {
  const { root } = html.parse(page);
  // Two top-level elements: a read-only document list.
  assert.equal(root?.readOnly, true);
  assert.equal(root?.children?.length, 2);
  const firstLi = findBlock(root, [0, 0])!;
  assert.equal(slice(page, firstLi), '<li>One');
  assert.equal(findBlock(root, [0, 1, '@disabled'])?.value, '');
  assert.equal(findBlock(root, [1])?.caption, 'P');

  assert.equal(edit(html, page, { type: 'setValue', path: [0, '@class'], value: 'a b' }), page.replace('class=list', 'class="a b"'));
  assert.equal(edit(html, page, { type: 'setValue', path: [0, 1, '@disabled'], value: 'yes' }), page.replace('disabled>', 'disabled="yes">'));
  assert.equal(edit(html, page, { type: 'rename', path: [1], newKey: 'div' }), page.replace('<P>', '<div>').replace('</P>', '</div>'));
  assert.equal(edit(html, page, { type: 'insert', parentPath: [1], key: 'i', value: {} }), page.replace('<b>there</b>', '<b>there</b><i></i>'));
  assert.equal(html.applyEdit(page, { type: 'insert', parentPath: [0, 0], key: 'span', value: {} }), undefined);
});
