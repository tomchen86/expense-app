import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('core publishes a type-only versioned tracked-object reader port', () => {
  const source = fs.readFileSync(
    new URL('../src/tracked-object-reader-port.ts', import.meta.url),
    'utf8',
  );
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { exports?: Record<string, unknown> };

  assert.equal(
    manifest.exports?.['./tracked-object-reader-port'],
    './src/tracked-object-reader-port.ts',
  );
  assert.match(
    source,
    /readonly contractVersion: 'jigwright\.tracked-object-reader-port\.v1'/,
  );
  assert.match(source, /export interface TrackedObjectSnapshotV1/);
  assert.match(source, /export interface TrackedObjectReaderPortV1/);
  assert.doesNotMatch(
    source,
    /^\s*(?:export\s+)?(?:const|let|var|function|class|enum|namespace)\b|^\s*import(?!\s+type\b)|^\s*export\s+(?!type\b)(?:\*|\{)/m,
  );
  assert.doesNotMatch(
    source,
    /expense-app|openspec|authority|workflowError|child_process/i,
  );
});
