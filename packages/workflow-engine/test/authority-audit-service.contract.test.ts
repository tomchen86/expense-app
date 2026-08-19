import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  appendAuthorityAuditRecord,
  deriveAuthorityAuditRepositoryId,
  type AuthorityAuditLedgerScope,
} from '../src/runtime/storage-journal/authority-audit-ledger.ts';
import {
  recordAuthorityAuditEvent,
  showAuthorityAuditTask,
  verifyAuthorityAuditEvents,
  type AuthorityAuditEventInput,
} from '../src/runtime/storage-journal/authority-audit-service.ts';
import { isWorkflowError } from './fixture.ts';

function fixture(): {
  root: string;
  scope: AuthorityAuditLedgerScope;
  cleanup: () => void;
} {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'authority-audit-service-')),
  );
  fs.chmodSync(root, 0o700);
  const repositoryRoot = path.join(root, 'repository');
  const externalAuditRoot = path.join(root, 'audit');
  fs.mkdirSync(repositoryRoot, { mode: 0o700 });
  fs.mkdirSync(externalAuditRoot, { mode: 0o700 });
  return {
    root,
    scope: {
      repositoryRoot,
      externalAuditRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(
        'github:example/authority-audit-service',
      ),
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function digest(marker: string): `sha256:${string}` {
  return `sha256:${marker.padEnd(64, marker[0] ?? '0').slice(0, 64)}`;
}

function input(
  marker: string,
  overrides: Partial<AuthorityAuditEventInput> = {},
): AuthorityAuditEventInput {
  return {
    eventType: 'command',
    occurredAt: '2026-08-03T12:00:00.000Z',
    idempotencyKey: digest(marker),
    actor: { kind: 'engine', identity: 'workflow-engine' },
    taskId: 'unified-plan',
    changeId: 'engine-v2',
    workflowId: 'workflow-engine-v2',
    grantDigest: null,
    candidateBundleDigest: null,
    prestateDigest: digest('a'),
    poststateDigest: digest('b'),
    command: { name: 'job.retry', argvDigest: digest('c') },
    providerInvocation: null,
    externalEffect: null,
    result: 'succeeded',
    outcomeDigest: digest('d'),
    errorCode: null,
    ...overrides,
  };
}

test('event objects make the external hash chain task-queryable and fully verifiable', () => {
  const value = fixture();
  try {
    const command = recordAuthorityAuditEvent(
      value.scope,
      input('1', { eventType: 'command' }),
    );
    const provider = recordAuthorityAuditEvent(
      value.scope,
      input('2', {
        eventType: 'provider-invocation',
        command: null,
        providerInvocation: {
          providerId: 'claude',
          invocationId: 'invocation-1',
          requestDigest: digest('e'),
        },
      }),
    );
    recordAuthorityAuditEvent(
      value.scope,
      input('3', { taskId: 'another-task' }),
    );

    assert.equal(fs.statSync(command.eventPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(provider.eventPath).mode & 0o777, 0o600);
    const verified = verifyAuthorityAuditEvents(value.scope);
    assert.equal(verified.ok, true);
    assert.equal(verified.recordCount, 3);
    assert.equal(verified.projectedEventCount, 3);
    assert.equal(verified.legacyUnprojectedCount, 0);
    assert.deepEqual(
      showAuthorityAuditTask(value.scope, 'unified-plan').events.map(
        ({ event }) => event.eventType,
      ),
      ['command', 'provider-invocation'],
    );
  } finally {
    value.cleanup();
  }
});

test('event publication recovers both ledger-first and prepared-object crash windows', () => {
  const value = fixture();
  try {
    const ledgerFirst = input('4');
    assert.throws(
      () =>
        recordAuthorityAuditEvent(value.scope, ledgerFirst, {
          testAfterLedgerAppend() {
            throw new Error('simulated-ledger-first-crash');
          },
        }),
      /simulated-ledger-first-crash/,
    );
    assert.deepEqual(
      {
        ok: verifyAuthorityAuditEvents(value.scope).ok,
        legacy: verifyAuthorityAuditEvents(value.scope).legacyUnprojectedCount,
      },
      { ok: false, legacy: 1 },
    );
    const recoveredLedgerFirst = recordAuthorityAuditEvent(
      value.scope,
      ledgerFirst,
    );
    assert.equal(recoveredLedgerFirst.ledger.record.sequence, 1);

    const prepared = input('5');
    assert.throws(
      () =>
        recordAuthorityAuditEvent(value.scope, prepared, {
          testAfterEventPreparation() {
            throw new Error('simulated-prepared-object-crash');
          },
        }),
      /simulated-prepared-object-crash/,
    );
    const recoveredPrepared = recordAuthorityAuditEvent(value.scope, prepared);
    assert.equal(recoveredPrepared.ledger.record.sequence, 2);
    const verified = verifyAuthorityAuditEvents(value.scope);
    assert.equal(verified.ok, true);
    assert.equal(verified.projectedEventCount, 2);
  } finally {
    value.cleanup();
  }
});

test('verification distinguishes historical unprojected records and fails closed on event tampering', () => {
  const value = fixture();
  try {
    appendAuthorityAuditRecord(value.scope, {
      eventType: 'recovery',
      occurredAt: '2026-08-03T12:00:00.000Z',
      idempotencyKey: digest('6'),
      grantDigest: null,
      candidateBundleDigest: null,
      prestateDigest: null,
      poststateDigest: null,
      result: 'recorded',
      resultDigest: digest('f'),
    });
    const historical = verifyAuthorityAuditEvents(value.scope);
    assert.equal(historical.ok, false);
    assert.equal(historical.legacyUnprojectedCount, 1);

    const projected = recordAuthorityAuditEvent(value.scope, input('7'));
    fs.appendFileSync(projected.eventPath, ' ');
    assert.throws(
      () => verifyAuthorityAuditEvents(value.scope),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_EVENT_UNSAFE'),
    );

    fs.writeFileSync(
      projected.eventPath,
      `${fs.readFileSync(projected.eventPath, 'utf8').trimEnd()}\n`,
      {
        mode: 0o600,
      },
    );
    fs.writeFileSync(
      path.join(path.dirname(projected.eventPath), 'unbound.json'),
      '{}\n',
      { mode: 0o600 },
    );
    assert.throws(
      () => verifyAuthorityAuditEvents(value.scope),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_EVENT_UNSAFE'),
    );
  } finally {
    value.cleanup();
  }
});

test('strict bounded schema rejects secrets-by-extension and inconsistent failure records', () => {
  const value = fixture();
  try {
    assert.throws(
      () =>
        recordAuthorityAuditEvent(value.scope, {
          ...input('8'),
          environment: { API_KEY: 'secret' },
        } as unknown as AuthorityAuditEventInput),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_EVENT_INVALID'),
    );
    assert.throws(
      () =>
        recordAuthorityAuditEvent(value.scope, {
          ...input('9'),
          result: 'failed',
          errorCode: null,
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_AUDIT_EVENT_INVALID'),
    );
  } finally {
    value.cleanup();
  }
});
