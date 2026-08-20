import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { loadFixtureCheckRegistry } from '../src/fixture-check-registry.ts';

function createFixtureRepository(document: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-fixture-'));
  fs.mkdirSync(path.join(root, 'tooling'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'tooling/fixture-checks.json'),
    `${JSON.stringify(document)}\n`,
    'utf8',
  );
  return root;
}

test('fixture loader maps its distinct schema to node non-database checks', (t) => {
  const root = createFixtureRepository({
    kind: 'jigwright.fixture-checks.v1',
    checks: {
      'fixture-smoke': { script: 'tooling/checks/smoke.mjs' },
    },
  });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(loadFixtureCheckRegistry(root), {
    schemaVersion: 1,
    checks: {
      'fixture-smoke': {
        command: ['node', 'tooling/checks/smoke.mjs'],
        destructiveDatabase: false,
      },
    },
  });
});

test('fixture loader requires exact keys and safe relative scripts', (t) => {
  const extraRoot = createFixtureRepository({
    kind: 'jigwright.fixture-checks.v1',
    checks: {
      'fixture-smoke': {
        script: 'tooling/checks/smoke.mjs',
        destructiveDatabase: false,
      },
    },
  });
  const traversalRoot = createFixtureRepository({
    kind: 'jigwright.fixture-checks.v1',
    checks: { 'fixture-smoke': { script: '../escape.mjs' } },
  });
  const driveRelativeRoot = createFixtureRepository({
    kind: 'jigwright.fixture-checks.v1',
    checks: { 'fixture-smoke': { script: 'C:escape.mjs' } },
  });
  t.after(() => {
    fs.rmSync(extraRoot, { recursive: true, force: true });
    fs.rmSync(traversalRoot, { recursive: true, force: true });
    fs.rmSync(driveRelativeRoot, { recursive: true, force: true });
  });

  assert.throws(() => loadFixtureCheckRegistry(extraRoot), /exact schema/i);
  assert.throws(
    () => loadFixtureCheckRegistry(traversalRoot),
    /safe relative/i,
  );
  assert.throws(
    () => loadFixtureCheckRegistry(driveRelativeRoot),
    /safe relative/i,
  );
});

test('fixture loader rejects symlink, oversized, and invalid UTF-8 sources', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-fixture-'));
  const real = path.join(root, 'real.json');
  const tooling = path.join(root, 'tooling');
  const source = path.join(tooling, 'fixture-checks.json');
  fs.mkdirSync(tooling);
  fs.writeFileSync(
    real,
    '{"kind":"jigwright.fixture-checks.v1","checks":{}}\n',
  );
  fs.symlinkSync(real, source);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(() => loadFixtureCheckRegistry(root), /regular file/i);

  fs.unlinkSync(source);
  fs.writeFileSync(source, Buffer.alloc(131_073, 0x20));
  assert.throws(() => loadFixtureCheckRegistry(root), /bounded/i);

  fs.writeFileSync(source, Buffer.from([0xc3, 0x28]));
  assert.throws(() => loadFixtureCheckRegistry(root), /UTF-8/i);
});

test('fixture loader rejects hard-linked and executable sources', (t) => {
  const hardLinkRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-fixture-'),
  );
  const tooling = path.join(hardLinkRoot, 'tooling');
  const hardLinkSource = path.join(tooling, 'fixture-checks.json');
  const linked = path.join(hardLinkRoot, 'linked.json');
  fs.mkdirSync(tooling);
  fs.writeFileSync(
    linked,
    '{"kind":"jigwright.fixture-checks.v1","checks":{}}\n',
  );
  fs.linkSync(linked, hardLinkSource);

  const executableRoot = createFixtureRepository({
    kind: 'jigwright.fixture-checks.v1',
    checks: {},
  });
  const executableSource = path.join(
    executableRoot,
    'tooling/fixture-checks.json',
  );
  fs.chmodSync(executableSource, 0o755);

  t.after(() => {
    fs.rmSync(hardLinkRoot, { recursive: true, force: true });
    fs.rmSync(executableRoot, { recursive: true, force: true });
  });

  assert.throws(() => loadFixtureCheckRegistry(hardLinkRoot), /single-link/i);
  if (process.platform !== 'win32') {
    assert.throws(
      () => loadFixtureCheckRegistry(executableRoot),
      /non-executable/i,
    );
  }
});
