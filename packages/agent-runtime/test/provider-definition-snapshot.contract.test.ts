import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '@jigwright/core/canonical-json';

import {
  ProviderDefinitionSnapshotError,
  assertProviderDefinitionSnapshot,
  createProviderDefinitionSnapshot,
} from '../src/provider-definition-snapshot.ts';

const definition = {
  definitionId: 'claude-built-in-reviewed',
  definitionRevision: 1,
  providerFamily: 'claude',
  protocol: 'claude-stream-json-v1',
  platform: 'darwin',
  executableCandidates: ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
  commandProfile: 'claude-fixed-read-only-v1',
} as const;

test('provider definition snapshot is deterministic and deeply immutable', () => {
  const first = createProviderDefinitionSnapshot(definition);
  const second = createProviderDefinitionSnapshot({
    ...definition,
    executableCandidates: [...definition.executableCandidates],
  });

  assert.deepEqual(first, second);
  assert.match(first.definitionDigest, /^[0-9a-f]{64}$/u);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.kind, 'provider-definition-snapshot');
  assert.equal(first.trustTier, 'built-in-reviewed');
  assert.equal(first.enabled, true);
  assert.equal(first.shell, false);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.executableCandidates), true);
  assert.deepEqual(assertProviderDefinitionSnapshot(first), first);
});

test('provider definition snapshot refuses unknown versions and digest tampering', () => {
  const snapshot = createProviderDefinitionSnapshot(definition);

  for (const value of [
    { ...snapshot, schemaVersion: 2 },
    { ...snapshot, protocol: 'host-controlled-protocol' },
    { ...snapshot, extraAuthority: true },
  ]) {
    assert.throws(
      () => assertProviderDefinitionSnapshot(value),
      (error: unknown) =>
        error instanceof ProviderDefinitionSnapshotError &&
        error.code === 'PROVIDER_DEFINITION_SNAPSHOT_INVALID',
    );
  }
});

test('provider definition snapshot accepts only absolute unique executable candidates', () => {
  for (const executableCandidates of [
    ['claude'],
    ['/opt/homebrew/bin/claude', '/opt/homebrew/bin/claude'],
    [],
  ]) {
    assert.throws(
      () =>
        createProviderDefinitionSnapshot({
          ...definition,
          executableCandidates,
        }),
      ProviderDefinitionSnapshotError,
    );
  }
});

test('provider definition snapshot evaluates paths using its recorded platform', () => {
  assert.throws(
    () =>
      createProviderDefinitionSnapshot({
        ...definition,
        executableCandidates: ['C:\\Program Files\\Claude\\claude.exe'],
      }),
    ProviderDefinitionSnapshotError,
  );
  assert.throws(
    () =>
      createProviderDefinitionSnapshot({
        ...definition,
        platform: 'win32',
        executableCandidates: ['/opt/homebrew/bin/claude'],
      }),
    ProviderDefinitionSnapshotError,
  );

  const windows = createProviderDefinitionSnapshot({
    ...definition,
    platform: 'win32',
    executableCandidates: ['C:\\Program Files\\Claude\\claude.exe'],
  });
  assert.equal(windows.platform, 'win32');

  const platformTampered = {
    ...createProviderDefinitionSnapshot(definition),
    platform: 'win32',
  };
  const platformTamperedPayload = { ...platformTampered };
  delete (platformTamperedPayload as { definitionDigest?: string })
    .definitionDigest;
  platformTampered.definitionDigest = crypto
    .createHash('sha256')
    .update(canonicalJson(platformTamperedPayload))
    .digest('hex');
  assert.throws(
    () => assertProviderDefinitionSnapshot(platformTampered),
    ProviderDefinitionSnapshotError,
  );
});
