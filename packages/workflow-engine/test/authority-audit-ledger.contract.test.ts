import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  appendAuthorityAuditRecord,
  authorityAuditLedgerPaths,
  scanAuthorityAuditLedger,
  type AuthorityAuditAppendInput,
  type AuthorityAuditLedgerScope,
} from '../src/runtime/storage-journal/authority-audit-ledger.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { isWorkflowError } from './fixture.ts';

function digest(seed: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(seed).digest('hex')}`;
}

function createScope(): {
  root: string;
  scope: AuthorityAuditLedgerScope;
} {
  const root = fs.mkdtempSync('/private/tmp/authority-audit-ledger-');
  const repositoryRoot = path.join(root, 'repository');
  fs.mkdirSync(repositoryRoot, { mode: 0o700 });
  return {
    root,
    scope: {
      externalAuditRoot: path.join(root, 'external-audit'),
      repositoryRoot,
      repositoryId: digest('repository'),
    },
  };
}

function input(
  seed: string,
  overrides: Partial<AuthorityAuditAppendInput> = {},
): AuthorityAuditAppendInput {
  return {
    eventType: 'cas',
    occurredAt: '2026-08-03T01:02:03.000Z',
    idempotencyKey: digest(`idempotency:${seed}`),
    grantDigest: digest(`grant:${seed}`),
    candidateBundleDigest: digest(`candidate:${seed}`),
    prestateDigest: digest(`prestate:${seed}`),
    poststateDigest: digest(`poststate:${seed}`),
    result: 'succeeded',
    resultDigest: digest(`result:${seed}`),
    ...overrides,
  };
}

test('audit scope requires an absolute repository-external root and injection-safe repository identity', () => {
  const { root, scope } = createScope();
  try {
    assert.throws(
      () =>
        appendAuthorityAuditRecord(
          { ...scope, externalAuditRoot: 'relative/audit' },
          input('relative'),
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_SCOPE_INVALID'),
    );
    assert.throws(
      () =>
        appendAuthorityAuditRecord(
          {
            ...scope,
            externalAuditRoot: path.join(scope.repositoryRoot, '.audit'),
          },
          input('internal'),
        ),
      (error) =>
        isWorkflowError(error, 'AUTHORITY_AUDIT_EXTERNAL_ROOT_REQUIRED'),
    );
    assert.throws(
      () =>
        appendAuthorityAuditRecord(
          { ...scope, repositoryId: '../../escaped' } as never,
          input('injection'),
        ),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_SCOPE_INVALID'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('append publishes canonical private records with a contiguous content-addressed hash chain', () => {
  const { root, scope } = createScope();
  try {
    const first = appendAuthorityAuditRecord(
      scope,
      input('first', { eventType: 'grant-consume' }),
    );
    const second = appendAuthorityAuditRecord(
      scope,
      input('second', {
        eventType: 'recovery',
        occurredAt: '2026-08-03T01:02:04.000Z',
        poststateDigest: null,
        result: 'failed',
      }),
    );

    assert.equal(first.record.sequence, 1);
    assert.equal(first.record.eventType, 'grant-consume');
    assert.equal(first.record.previousRecordDigest, null);
    assert.equal(second.record.sequence, 2);
    assert.equal(second.record.eventType, 'recovery');
    assert.equal(second.record.previousRecordDigest, first.recordDigest);
    assert.equal(first.record.repositoryId, scope.repositoryId);
    assert.match(first.recordDigest, /^sha256:[0-9a-f]{64}$/);

    const paths = authorityAuditLedgerPaths(scope);
    for (const directory of [
      paths.externalAuditRoot,
      paths.repositories,
      paths.repository,
      paths.records,
      paths.locks,
    ]) {
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    }
    const recordFiles = fs.readdirSync(paths.records).sort();
    assert.equal(recordFiles.length, 2);
    for (const recordFile of recordFiles) {
      assert.match(recordFile, /^[0-9]{16}-[0-9a-f]{64}\.json$/);
      assert.equal(
        fs.statSync(path.join(paths.records, recordFile)).mode & 0o777,
        0o600,
      );
    }
    assert.equal(
      fs.readFileSync(path.join(paths.records, recordFiles[0]!), 'utf8'),
      `${canonicalJson(first.record)}\n`,
    );

    const scan = scanAuthorityAuditLedger(scope);
    assert.equal(scan.recordCount, 2);
    assert.equal(scan.headSequence, 2);
    assert.equal(scan.headRecordDigest, second.recordDigest);
    assert.deepEqual(scan.records, [first, second]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a durable orphan is recovered and duplicate idempotency returns the exact record', () => {
  const { root, scope } = createScope();
  try {
    const request = input('crash');
    let concurrentError: unknown;
    assert.throws(
      () =>
        appendAuthorityAuditRecord(scope, request, {
          testAfterRecordPreparation: () => {
            try {
              appendAuthorityAuditRecord(scope, input('concurrent'));
            } catch (error) {
              concurrentError = error;
            }
            throw new Error('simulated crash');
          },
        }),
      /simulated crash/,
    );
    assert.equal(
      isWorkflowError(concurrentError, 'AUTHORITY_AUDIT_LOCK_BUSY'),
      true,
    );

    const recovered = appendAuthorityAuditRecord(scope, request);
    const duplicate = appendAuthorityAuditRecord(scope, request);
    assert.deepEqual(duplicate, recovered);
    assert.equal(recovered.record.sequence, 1);

    const paths = authorityAuditLedgerPaths(scope);
    assert.equal(fs.readdirSync(paths.records).length, 1);
    assert.throws(
      () =>
        appendAuthorityAuditRecord(scope, {
          ...request,
          resultDigest: digest('different-result'),
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_IDEMPOTENCY_CONFLICT'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('strict schema rejects unknown or unbounded payload fields', () => {
  const { root, scope } = createScope();
  try {
    assert.throws(
      () =>
        appendAuthorityAuditRecord(scope, {
          ...input('secret'),
          environment: { SECRET_TOKEN: 'must-not-be-persisted' },
        } as never),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_RECORD_INVALID'),
    );
    assert.throws(
      () =>
        appendAuthorityAuditRecord(scope, {
          ...input('event'),
          eventType: 'arbitrary-unbounded-event',
        } as never),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_RECORD_INVALID'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('scan fails closed on noncanonical bytes, sequence gaps, tampering, and unsafe permissions', () => {
  const noncanonical = createScope();
  const gap = createScope();
  const permissions = createScope();
  try {
    const noncanonicalEntry = appendAuthorityAuditRecord(
      noncanonical.scope,
      input('noncanonical'),
    );
    const noncanonicalPaths = authorityAuditLedgerPaths(noncanonical.scope);
    const noncanonicalFile = path.join(
      noncanonicalPaths.records,
      fs.readdirSync(noncanonicalPaths.records)[0]!,
    );
    fs.writeFileSync(
      noncanonicalFile,
      `${JSON.stringify(noncanonicalEntry.record, null, 2)}\n`,
    );
    assert.throws(
      () => scanAuthorityAuditLedger(noncanonical.scope),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_LEDGER_INVALID'),
    );

    appendAuthorityAuditRecord(gap.scope, input('gap-1'));
    appendAuthorityAuditRecord(
      gap.scope,
      input('gap-2', { occurredAt: '2026-08-03T01:02:04.000Z' }),
    );
    appendAuthorityAuditRecord(
      gap.scope,
      input('gap-3', { occurredAt: '2026-08-03T01:02:05.000Z' }),
    );
    const gapPaths = authorityAuditLedgerPaths(gap.scope);
    fs.unlinkSync(
      path.join(gapPaths.records, fs.readdirSync(gapPaths.records).sort()[1]!),
    );
    assert.throws(
      () => scanAuthorityAuditLedger(gap.scope),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_LEDGER_INVALID'),
    );

    appendAuthorityAuditRecord(permissions.scope, input('permissions'));
    const permissionPaths = authorityAuditLedgerPaths(permissions.scope);
    fs.chmodSync(
      path.join(
        permissionPaths.records,
        fs.readdirSync(permissionPaths.records)[0]!,
      ),
      0o644,
    );
    assert.throws(
      () => scanAuthorityAuditLedger(permissions.scope),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_FILESYSTEM_UNSAFE'),
    );
  } finally {
    fs.rmSync(noncanonical.root, { recursive: true, force: true });
    fs.rmSync(gap.root, { recursive: true, force: true });
    fs.rmSync(permissions.root, { recursive: true, force: true });
  }
});
