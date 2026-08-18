import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertWorkflowTestShardWrappers,
  assertWorkflowTestScratchSafety,
  createFullGateCoverageExpectation,
  digestWorkflowTestManifest,
  digestWorkflowTestFileSet,
  expectedPhysicalFiles,
  loadWorkflowTestShardManifest,
  validateWorkflowTestShardManifest,
  workflowTestImportClosures,
  workflowTestShardWrapperPaths,
  type WorkflowTestShardManifest,
} from '../../../scripts/workflow-test-inventory.ts';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

test('the tracked shard manifest owns every physical workflow test exactly once', () => {
  const manifest = loadWorkflowTestShardManifest(repositoryRoot);
  const physicalFiles = expectedPhysicalFiles(manifest);
  const units = manifest.shards.flatMap((shard) => shard.units);

  assert.equal(manifest.kind, 'workflow-test-shard-manifest.v1');
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.algorithm.name, 'longest-processing-time');
  assert.equal(manifest.algorithm.version, 1);
  assert.equal(
    manifest.sourceTelemetryDigest,
    'sha256:131eae67d081623752dfb1f52b9ecd9356e26b70213b3bfc3c43cc5a8b862c2b',
  );
  assert.equal(manifest.shards.length, 8);
  assert.equal(physicalFiles.length, 254);
  assert.equal(units.length, 252);
  assert.deepEqual(
    workflowTestShardWrapperPaths(manifest),
    Array.from(
      { length: 8 },
      (_, index) =>
        `packages/workflow-engine/test/shards/shard-${String(index + 1).padStart(2, '0')}.ts`,
    ),
  );

  const contracts = units.find(
    (unit) =>
      unit.entrypoint === 'packages/workflow-engine/test/contracts.test.ts',
  );
  const session = units.find(
    (unit) =>
      unit.entrypoint ===
      'packages/workflow-engine/test/session.integration.test.ts',
  );
  const runner = units.find(
    (unit) =>
      unit.entrypoint ===
      'packages/workflow-engine/test/runner.integration.test.ts',
  );
  assert.deepEqual(contracts?.ownedPhysicalFiles, [
    'packages/workflow-engine/test/contracts.test.ts',
  ]);
  assert.deepEqual(session?.ownedPhysicalFiles, [
    'packages/workflow-engine/test/session.integration.test.ts',
  ]);
  assert.deepEqual(runner?.ownedPhysicalFiles, [
    'packages/workflow-engine/test/runner-closure.integration.test.ts',
    'packages/workflow-engine/test/runner-package-security.integration.test.ts',
    'packages/workflow-engine/test/runner.integration.test.ts',
  ]);

  const coverage = createFullGateCoverageExpectation(manifest);
  assert.equal(coverage.inventoryDigest, manifest.inventoryDigest);
  assert.deepEqual(coverage.expectedFiles, physicalFiles);
  assert.equal(
    coverage.expectedFileSetDigest,
    digestWorkflowTestFileSet(physicalFiles),
  );
});

test('manifest validation rejects duplicate, missing, and unknown ownership', () => {
  const manifest = loadWorkflowTestShardManifest(repositoryRoot);
  const firstFile = manifest.shards[0]!.units[0]!.ownedPhysicalFiles[0]!;

  const duplicate = cloneManifest(manifest);
  duplicate.shards[1]!.units[0]!.ownedPhysicalFiles.push(firstFile);
  duplicate.shards[1]!.units[0]!.ownedPhysicalFiles.sort();
  assert.throws(
    () => validateWorkflowTestShardManifest(duplicate, { repositoryRoot }),
    /duplicate physical test ownership/i,
  );

  const missing = cloneManifest(manifest);
  const runner = missing.shards
    .flatMap((shard) => shard.units)
    .find(
      (unit) =>
        unit.entrypoint ===
        'packages/workflow-engine/test/runner.integration.test.ts',
    )!;
  runner.ownedPhysicalFiles.shift();
  missing.physicalFileCount -= 1;
  missing.inventoryDigest = digestWorkflowTestManifest(missing);
  assert.throws(
    () => validateWorkflowTestShardManifest(missing, { repositoryRoot }),
    /missing physical workflow tests/i,
  );

  const unknown = cloneManifest(manifest);
  unknown.shards[0]!.units[0]!.ownedPhysicalFiles.push(
    'packages/workflow-engine/test/not-tracked.test.ts',
  );
  unknown.shards[0]!.units[0]!.ownedPhysicalFiles.sort();
  unknown.physicalFileCount += 1;
  unknown.inventoryDigest = digestWorkflowTestManifest(unknown);
  assert.throws(
    () => validateWorkflowTestShardManifest(unknown, { repositoryRoot }),
    /unknown physical workflow tests/i,
  );

  const nonLpt = cloneManifest(manifest);
  const left = nonLpt.shards[0]!.units.shift()!;
  const right = nonLpt.shards[1]!.units.shift()!;
  nonLpt.shards[0]!.units.push(right);
  nonLpt.shards[1]!.units.push(left);
  for (const shard of nonLpt.shards.slice(0, 2)) {
    shard.units.sort((a, b) => a.legacyOrdinal - b.legacyOrdinal);
    shard.estimatedDurationMs =
      Math.round(
        shard.units.reduce(
          (total, unit) => total + unit.estimatedDurationMs,
          0,
        ) * 1_000,
      ) / 1_000;
  }
  nonLpt.inventoryDigest = digestWorkflowTestManifest(nonLpt);
  assert.throws(
    () => validateWorkflowTestShardManifest(nonLpt),
    /deterministic LPT/i,
  );
});

test('static wrapper drift fails closed', () => {
  const manifest = loadWorkflowTestShardManifest(repositoryRoot);
  const fixture = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'workflow-test-wrappers-'),
  );
  try {
    for (const wrapper of workflowTestShardWrapperPaths(manifest)) {
      const target = path.join(fixture, wrapper);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(repositoryRoot, wrapper), target);
    }
    fs.appendFileSync(
      path.join(fixture, manifest.shards[0]!.wrapper),
      "import '../unknown.test.ts';\n",
    );
    assert.throws(
      () => assertWorkflowTestShardWrappers(fixture, manifest),
      /wrapper drifted/i,
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('canonical file-set digests are order independent and fail closed on aliases', () => {
  const first = 'packages/workflow-engine/test/a.test.ts';
  const second = 'packages/workflow-engine/test/b.test.ts';
  assert.equal(
    digestWorkflowTestFileSet([first, second]),
    digestWorkflowTestFileSet([second, first]),
  );
  assert.throws(
    () => digestWorkflowTestFileSet([first, first]),
    /duplicate workflow test file/i,
  );
  assert.throws(
    () => digestWorkflowTestFileSet(['packages/workflow-engine/test/../x']),
    /canonical repository-relative path/i,
  );
});

test('test import cycles and checkout-relative scratch roots fail before sharding', () => {
  assert.throws(
    () =>
      workflowTestImportClosures({
        'packages/workflow-engine/test/a.test.ts': "import './b.test.ts';\n",
        'packages/workflow-engine/test/b.test.ts': "import './a.test.ts';\n",
      }),
    /workflow test import cycle/i,
  );
  assert.throws(
    () =>
      assertWorkflowTestScratchSafety(
        'packages/workflow-engine/test/a.test.ts',
        "fs.mkdtempSync(path.join(process.cwd(), '.scratch-'));\n",
      ),
    /checkout-relative scratch/i,
  );
  assert.doesNotThrow(() =>
    assertWorkflowTestScratchSafety(
      'packages/workflow-engine/test/a.test.ts',
      "fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-'));\n",
    ),
  );
});

test('a direct root loads its legacy family while a wrapper imports only its body', () => {
  const fixture = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), 'workflow-test-root-mode-'),
  );
  try {
    fs.writeFileSync(
      path.join(fixture, 'family.test.mjs'),
      "import test from 'node:test';\ntest('legacy family', () => {});\n",
    );
    fs.writeFileSync(
      path.join(fixture, 'legacy-family.mjs'),
      "import './family.test.mjs';\n",
    );
    fs.writeFileSync(
      path.join(fixture, 'root.test.mjs'),
      [
        "import test from 'node:test';",
        "if (import.meta.main) await import('./legacy-family.mjs');",
        "test('root body', () => {});",
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(fixture, 'shard.mjs'),
      "import './root.test.mjs';\n",
    );

    const childEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => key !== 'NODE_TEST_CONTEXT' && key !== 'NODE_TEST_WORKER_ID',
      ),
    );
    const direct = execFileSync(
      process.execPath,
      ['--test', path.join(fixture, 'root.test.mjs')],
      { env: childEnvironment },
    ).toString();
    const wrapped = execFileSync(
      process.execPath,
      ['--test', path.join(fixture, 'shard.mjs')],
      { env: childEnvironment },
    ).toString();
    assert.match(direct, /legacy family/);
    assert.match(direct, /root body/);
    assert.doesNotMatch(wrapped, /legacy family/);
    assert.match(wrapped, /root body/);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

function cloneManifest(manifest: WorkflowTestShardManifest): MutableManifest {
  return structuredClone(manifest) as MutableManifest;
}

type MutableManifest = {
  -readonly [Key in keyof WorkflowTestShardManifest]: Key extends 'shards'
    ? Array<{
        -readonly [
          ShardKey in keyof WorkflowTestShardManifest['shards'][number]
        ]: ShardKey extends 'units'
          ? Array<{
              -readonly [
                UnitKey in keyof WorkflowTestShardManifest['shards'][number]['units'][number]
              ]: WorkflowTestShardManifest['shards'][number]['units'][number][UnitKey] extends readonly string[]
                ? string[]
                : WorkflowTestShardManifest['shards'][number]['units'][number][UnitKey];
            }>
          : WorkflowTestShardManifest['shards'][number][ShardKey];
      }>
    : WorkflowTestShardManifest[Key];
};
