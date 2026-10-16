import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pathToId } from '../src/model/block';
import { jsonAdapter } from '../src/parsers/jsonAdapter';
import { yamlAdapter } from '../src/parsers/yamlAdapter';
import { fileMatches, inlineSchemaReference, schemaSettings } from '../src/schema/association';
import { hintsFor, SchemaNavigator } from '../src/schema/navigator';
import { compileSchema, instancePathToBlockPath, validate } from '../src/schema/validate';

const ROOT = 'https://example.com/schemas/app.json';
const COMMON = 'https://example.com/schemas/common.json';

const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'App config',
  type: 'object',
  required: ['name', 'servers'],
  additionalProperties: false,
  properties: {
    $schema: { type: 'string' },
    name: { type: 'string', description: 'Application name' },
    mode: { enum: ['dev', 'prod'], default: 'dev' },
    servers: { type: 'array', items: { $ref: '#/definitions/server' } },
    owner: { $ref: 'common.json#/definitions/person' },
    labels: { type: 'object', additionalProperties: { type: 'string' } },
  },
  definitions: {
    server: {
      type: 'object',
      required: ['host'],
      properties: {
        host: { type: 'string', description: 'Host name' },
        port: { type: 'integer', minimum: 1 },
        secure: { type: 'boolean' },
      },
    },
  },
};

const common = { definitions: { person: { type: 'object', properties: { email: { type: 'string', format: 'email', description: 'Contact' } } } } };
const documents = new Map<string, unknown>([
  [ROOT, schema],
  [COMMON, common],
]);
const navigator = new SchemaNavigator(ROOT, documents);

test('navigator follows properties, items, $ref and remote $ref', () => {
  assert.equal(navigator.hint(['name']).description, 'Application name');
  assert.equal(navigator.hint(['name']).required, true);
  assert.equal(navigator.hint(['servers', 3, 'host']).description, 'Host name');
  assert.equal(navigator.hint(['servers', 0, 'host']).required, true);
  assert.equal(navigator.hint(['owner', 'email']).description, 'Contact');
  assert.deepEqual(navigator.hint(['mode']).enum, ['dev', 'prod']);
  assert.deepEqual(navigator.hint(['labels', 'anything']), {});
});

test('navigator suggests properties (required first) and default values', () => {
  assert.deepEqual(
    navigator.properties([]).map((p) => [p.name, p.required]).slice(0, 3),
    [['name', true], ['servers', true], ['$schema', false]],
  );
  assert.deepEqual(navigator.properties(['servers', 0]).map((p) => p.name), ['host', 'port', 'secure']);
  assert.equal(navigator.defaultValue(['mode']), 'dev');
  assert.equal(navigator.defaultValue(['servers', 0, 'port']), 0);
  assert.equal(navigator.defaultValue(['servers', 0, 'secure']), false);
  assert.deepEqual(navigator.defaultValue(['servers']), []);
  assert.equal(navigator.defaultValue(['unknown']), undefined);
});

const text = `{
  "$schema": "${ROOT}",
  "name": 42,
  "mode": "staging",
  "servers": [{ "host": "a", "port": 0 }, { "port": 8080 }],
  "owner": { "email": "not-an-email" },
  "extra": true
}`;

test('validation maps ajv errors to block paths with readable messages', async () => {
  const validator = await compileSchema(schema, ROOT, async (uri) => documents.get(uri.split('#')[0]) as object);
  const { root } = jsonAdapter.parse(text);
  const [instance] = jsonAdapter.instances!(text);
  const problems = validate(validator, instance.value, root!).map((p) => [JSON.stringify(p.path), p.message]);
  assert.deepEqual(new Set(problems.map(([path]) => path)), new Set([
    '["name"]',
    '["mode"]',
    '["servers",0,"port"]',
    '["servers",1]',
    '["owner","email"]',
    '["extra"]',
  ]));
  assert.ok(problems.some(([path, message]) => path === '["mode"]' && message === 'Must be one of: "dev", "prod"'));
  assert.ok(problems.some(([path, message]) => path === '["servers",1]' && message === 'Missing required property "host"'));
  assert.ok(problems.some(([path, message]) => path === '["extra"]' && message === 'Property is not allowed by the schema'));
});

test('hintsFor keys hints by block id', () => {
  const { root } = jsonAdapter.parse(text);
  const hints = hintsFor(root!, navigator);
  assert.equal(hints[pathToId(['servers', 0, 'host'])]?.description, 'Host name');
  assert.equal(hints[pathToId(['extra'])], undefined);
});

test('multi-document YAML: each document validates on its own', async () => {
  const validator = await compileSchema({ type: 'object', required: ['kind'] }, 'inmemory://k.json', async () => ({}));
  const yaml = 'kind: A\n---\nname: b\n';
  const { root } = yamlAdapter.parse(yaml);
  const problems = yamlAdapter.instances!(yaml).flatMap((instance) => {
    const block = root!.children![instance.prefix[0] as number];
    return validate(validator, instance.value, block, instance.prefix);
  });
  assert.deepEqual(problems, [{ path: [1], message: 'Missing required property "kind"' }]);
});

test('instance paths: array indexes vs numeric object keys', () => {
  const { root } = jsonAdapter.parse('{ "list": [1, 2], "map": { "0": "x" } }');
  assert.deepEqual(instancePathToBlockPath('/list/1', root!), ['list', 1]);
  assert.deepEqual(instancePathToBlockPath('/map/0', root!), ['map', '0']);
});

test('schema references inside files and settings globs', () => {
  assert.equal(inlineSchemaReference('{ "$schema": "./s.json", "a": 1 }', 'json'), './s.json');
  assert.equal(inlineSchemaReference('# yaml-language-server: $schema=https://x/s.json\na: 1\n', 'yaml'), 'https://x/s.json');
  assert.equal(inlineSchemaReference('a: 1\n', 'yaml'), undefined);

  assert.ok(fileMatches('package.json', 'C:/work/app/package.json'));
  assert.ok(!fileMatches('package.json', 'C:/work/app/my-package.json'));
  assert.ok(fileMatches('*.config.json', 'src/app.config.json'));
  assert.ok(fileMatches('/config/**/*.yaml', 'repo/config/a/b/c.yaml'));
  assert.ok(!fileMatches('!*.json', 'a.json'));

  const settings = schemaSettings([{ fileMatch: ['*.app.json'], url: './app.schema.json' }], { 'https://x/k8s.json': ['k8s/*.yaml'] }, 'yaml');
  assert.deepEqual(settings.map((s) => s.url), ['./app.schema.json', 'https://x/k8s.json']);
});
