import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { createFixtureTrackedObjectReaderPort } from '../src/fixture-tracked-object-reader.ts';

const TREE_OID = 'a'.repeat(40);

test('fixture tracked-object adapter maps its distinct schema to the public port', () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { exports?: Record<string, unknown> };
  assert.equal(
    manifest.exports?.['./tracked-object-reader'],
    './src/fixture-tracked-object-reader.ts',
  );
  const port = createFixtureTrackedObjectReaderPort([
    {
      kind: 'jigwright.fixture-tracked-tree.v1',
      treeOid: TREE_OID,
      files: {
        'src/second.ts': 'second marker\n',
        'src/first.ts': 'first marker\n',
      },
    },
  ]);

  const snapshot = port.readPinnedTree({
    repositoryRoot: '/fixture/repository',
    treeOid: TREE_OID,
    limits: { maxBlobBytes: 1024, maxTotalScannedBytes: 1024 },
  });
  assert.equal(port.contractVersion, 'jigwright.tracked-object-reader-port.v1');
  assert.equal(snapshot.treeOid, TREE_OID);
  assert.match(snapshot.treeDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.path.utf8),
    ['src/first.ts', 'src/second.ts'],
  );
  assert.deepEqual(
    snapshot.entries.map((entry) =>
      Buffer.from(entry.content ?? []).toString('utf8'),
    ),
    ['first marker\n', 'second marker\n'],
  );
  assert.equal(snapshot.totalScannedBlobBytes, 27);
  assert.equal(snapshot.budgetExceeded, false);
});

test('fixture tracked-object adapter rejects unsafe paths and applies deterministic limits', () => {
  assert.throws(
    () =>
      createFixtureTrackedObjectReaderPort([
        {
          kind: 'jigwright.fixture-tracked-tree.v1',
          treeOid: TREE_OID,
          files: { '../escape.ts': 'nope' },
        },
      ]),
    /fixture tracked tree/i,
  );

  const port = createFixtureTrackedObjectReaderPort([
    {
      kind: 'jigwright.fixture-tracked-tree.v1',
      treeOid: TREE_OID,
      files: {
        'src/a.ts': '12345',
        'src/b.ts': '123456789',
        'src/c.ts': '67890',
      },
    },
  ]);
  const snapshot = port.readPinnedTree({
    repositoryRoot: '/fixture/repository',
    treeOid: TREE_OID,
    limits: { maxBlobBytes: 5, maxTotalScannedBytes: 5 },
  });
  assert.deepEqual(
    snapshot.entries.map((entry) => entry.skipReason ?? null),
    [null, 'oversize', 'total-budget'],
  );
  assert.equal(snapshot.totalScannedBlobBytes, 5);
  assert.equal(snapshot.budgetExceeded, true);
});
