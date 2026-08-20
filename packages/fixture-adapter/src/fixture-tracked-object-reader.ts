import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { canonicalJson } from '@jigwright/core/canonical-json';
import {
  RepositoryPathError,
  normalizeExactRepositoryPath,
} from '@jigwright/core/repository-path';
import type {
  TrackedObjectEntryV1,
  TrackedObjectReaderPortV1,
  TrackedObjectReadLimitsV1,
  TrackedObjectReadRequestV1,
  TrackedObjectSnapshotV1,
} from '@jigwright/core/tracked-object-reader-port';

const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const FIXTURE_DEFAULT_LIMITS: TrackedObjectReadLimitsV1 = {
  maxBlobBytes: 2 * 1024 * 1024,
  maxTotalScannedBytes: 64 * 1024 * 1024,
};

export type FixtureTrackedTreeV1 = Readonly<{
  kind: 'jigwright.fixture-tracked-tree.v1';
  treeOid: string;
  files: Readonly<Record<string, string>>;
}>;

type FixtureFile = Readonly<{
  pathBytes: Buffer;
  pathUtf8: string;
  content: Buffer;
  objectId: string;
}>;

export function createFixtureTrackedObjectReaderPort(
  trees: readonly FixtureTrackedTreeV1[],
): TrackedObjectReaderPortV1 {
  const fixtures = new Map<string, readonly FixtureFile[]>();
  for (const tree of trees) {
    const normalized = parseFixtureTree(tree);
    if (fixtures.has(tree.treeOid)) throw fixtureTreeInvalid();
    fixtures.set(tree.treeOid, normalized);
  }

  return Object.freeze({
    contractVersion: 'jigwright.tracked-object-reader-port.v1' as const,
    readPinnedTree(
      request: TrackedObjectReadRequestV1,
    ): TrackedObjectSnapshotV1 {
      assertDeadline(request.operationalDeadline?.expiresAtMonotonicMillis);
      if (
        typeof request.repositoryRoot !== 'string' ||
        request.repositoryRoot.length === 0 ||
        !OBJECT_ID_PATTERN.test(request.treeOid)
      ) {
        throw fixtureTreeInvalid();
      }
      const files = fixtures.get(request.treeOid);
      if (files === undefined) throw fixtureTreeInvalid();
      const limits = assertLimits(request.limits ?? FIXTURE_DEFAULT_LIMITS);
      const selected = new Set<string>();
      const overBudget = new Set<string>();
      let totalScannedBlobBytes = 0;
      for (const file of files) {
        assertDeadline(request.operationalDeadline?.expiresAtMonotonicMillis);
        if (
          file.content.byteLength > limits.maxBlobBytes ||
          selected.has(file.objectId) ||
          overBudget.has(file.objectId)
        ) {
          continue;
        }
        if (
          totalScannedBlobBytes + file.content.byteLength <=
          limits.maxTotalScannedBytes
        ) {
          selected.add(file.objectId);
          totalScannedBlobBytes += file.content.byteLength;
        } else {
          overBudget.add(file.objectId);
        }
      }

      const entries: TrackedObjectEntryV1[] = files.map((file) => {
        const base = {
          path: {
            rawBase64: file.pathBytes.toString('base64'),
            utf8: file.pathUtf8,
          },
          objectId: file.objectId,
          objectType: 'blob',
          mode: '100644',
          byteSize: file.content.byteLength,
        } as const;
        if (file.content.byteLength > limits.maxBlobBytes) {
          return { ...base, skipReason: 'oversize' };
        }
        if (overBudget.has(file.objectId)) {
          return { ...base, skipReason: 'total-budget' };
        }
        return {
          ...base,
          content: Buffer.from(file.content),
          contentSha256: file.objectId,
        };
      });
      assertDeadline(request.operationalDeadline?.expiresAtMonotonicMillis);
      return {
        treeOid: request.treeOid,
        treeDigest: treeDigest(request.treeOid, entries),
        entries,
        totalScannedBlobBytes,
        budgetExceeded: overBudget.size > 0,
      };
    },
  });
}

function parseFixtureTree(tree: unknown): readonly FixtureFile[] {
  if (
    !isRecord(tree) ||
    !hasExactKeys(tree, ['kind', 'treeOid', 'files']) ||
    tree.kind !== 'jigwright.fixture-tracked-tree.v1' ||
    typeof tree.treeOid !== 'string' ||
    !OBJECT_ID_PATTERN.test(tree.treeOid) ||
    !isRecord(tree.files)
  ) {
    throw fixtureTreeInvalid();
  }
  const files: FixtureFile[] = [];
  for (const [filePath, content] of Object.entries(tree.files)) {
    if (typeof content !== 'string') throw fixtureTreeInvalid();
    try {
      if (normalizeExactRepositoryPath(filePath) !== filePath) {
        throw fixtureTreeInvalid();
      }
    } catch (error) {
      if (error instanceof RepositoryPathError) throw fixtureTreeInvalid();
      throw error;
    }
    const bytes = Buffer.from(content, 'utf8');
    files.push({
      pathBytes: Buffer.from(filePath, 'utf8'),
      pathUtf8: filePath,
      content: bytes,
      objectId: sha256(bytes),
    });
  }
  files.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
  return files;
}

function assertLimits(
  limits: TrackedObjectReadLimitsV1,
): TrackedObjectReadLimitsV1 {
  if (
    !Number.isInteger(limits.maxBlobBytes) ||
    limits.maxBlobBytes < 1 ||
    limits.maxBlobBytes > FIXTURE_DEFAULT_LIMITS.maxBlobBytes ||
    !Number.isInteger(limits.maxTotalScannedBytes) ||
    limits.maxTotalScannedBytes < 1 ||
    limits.maxTotalScannedBytes > FIXTURE_DEFAULT_LIMITS.maxTotalScannedBytes
  ) {
    throw fixtureTreeInvalid();
  }
  return limits;
}

function assertDeadline(expiresAt: number | undefined): void {
  if (
    expiresAt !== undefined &&
    (!Number.isFinite(expiresAt) || performance.now() >= expiresAt)
  ) {
    throw new Error('Fixture tracked tree deadline expired.');
  }
}

function treeDigest(
  treeOid: string,
  entries: readonly TrackedObjectEntryV1[],
): string {
  return sha256(
    canonicalJson({
      schema: 'investigation-tree-v1',
      treeOid,
      entries: entries.map((entry) => ({
        rawBase64: entry.path.rawBase64,
        objectId: entry.objectId,
        objectType: entry.objectType,
        mode: entry.mode,
        byteSize: entry.byteSize,
      })),
    }),
  );
}

function sha256(value: string | Uint8Array): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fixtureTreeInvalid(): Error {
  return new Error('Fixture tracked tree must use the exact safe schema.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return (
    actual.length === keys.length &&
    actual.every((entry, index) => entry === keys[index])
  );
}
