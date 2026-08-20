import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const packageRoot = path.resolve(import.meta.dirname, '..');

test('@jigwright/fixture-adapter has one-way public package dependencies', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as {
    name: string;
    dependencies?: Record<string, string>;
    exports?: Record<string, string>;
  };
  assert.equal(manifest.name, '@jigwright/fixture-adapter');
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), [
    '@jigwright/core',
  ]);
  assert.deepEqual(Object.keys(manifest.exports ?? {}).sort(), [
    '.',
    './evidence-node',
    './managed-transition-reader',
    './session-runtime-layout',
    './tracked-object-reader',
  ]);

  for (const file of fs.readdirSync(path.join(packageRoot, 'src'))) {
    if (!file.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(packageRoot, 'src', file), 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/gu)) {
      const specifier = match[1]!;
      assert.equal(
        /workflow-engine|@jigwright\/(?:agent-runtime|grants|openspec-adapter)|expense/iu.test(
          specifier,
        ),
        false,
        `${file} imports forbidden implementation authority ${specifier}`,
      );
      assert.equal(
        specifier.startsWith('.') ||
          specifier.startsWith('node:') ||
          specifier.startsWith('@jigwright/core/'),
        true,
        `${file} imports undeclared package ${specifier}`,
      );
    }
  }
});
