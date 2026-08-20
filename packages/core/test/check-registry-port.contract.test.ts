import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const sourceUrl = new URL('../src/check-registry-port.ts', import.meta.url);
const manifestUrl = new URL('../package.json', import.meta.url);

function assertTypeOnlyCoreSource(source: string): void {
  assert.doesNotMatch(
    source,
    /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var|function|class|enum|namespace)\b|^\s*import(?!\s+type\b)|^\s*export\s+(?!type\b)(?:\*|\{)/m,
  );
}

test('core publishes a type-only versioned CheckRegistry port', () => {
  const source = fs.readFileSync(sourceUrl, 'utf8');
  const manifest = JSON.parse(fs.readFileSync(manifestUrl, 'utf8')) as {
    name?: unknown;
    exports?: Record<string, unknown>;
  };

  assert.equal(manifest.name, '@jigwright/core');
  assert.equal(
    manifest.exports?.['./check-registry-port'],
    './src/check-registry-port.ts',
  );
  assert.match(
    source,
    /readonly contractVersion: 'jigwright\.check-registry-port\.v1'/,
  );
  assert.match(source, /export interface CheckDefinitionV1/);
  assert.match(source, /export interface CheckRegistryV1/);
  assert.match(source, /export interface CheckRegistryPortV1/);
  assertTypeOnlyCoreSource(source);
  assert.doesNotMatch(
    source,
    /expense-app|openspec|fixture-checks|workflow\/checks\.json|@expense/i,
  );
});

test('type-only guard rejects value declarations and runtime module edges', () => {
  for (const forbidden of [
    'export const registry = {};',
    'let mutable = true;',
    'var legacy = true;',
    'namespace Internal {}',
    'export class Registry {}',
    'export function load() {}',
    'export enum Version { V1 }',
    "import { value } from './value.ts';",
    "export { value } from './value.ts';",
    "export * from './value.ts';",
  ]) {
    assert.throws(() => assertTypeOnlyCoreSource(forbidden));
  }

  assert.doesNotThrow(() =>
    assertTypeOnlyCoreSource(
      "import type { Input } from './input.ts';\nexport type { Output } from './output.ts';",
    ),
  );
});
