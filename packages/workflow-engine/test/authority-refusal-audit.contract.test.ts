import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { deriveAuthorityAuditRepositoryId } from '../src/authority-audit-ledger.ts';
import {
  authorityRefusalDigest,
  recordAuthorityRefusal,
  withAuthorityRefusalAudit,
  type AuthorityRefusalAuditBinding,
} from '../src/authority-refusal-audit.ts';
import { verifyAuthorityAuditEvents } from '../src/authority-audit-service.ts';
import { ExitCode, workflowError } from '../src/errors.ts';

function fixture(): {
  root: string;
  binding: AuthorityRefusalAuditBinding;
  cleanup: () => void;
} {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'authority-refusal-audit-')),
  );
  fs.chmodSync(root, 0o700);
  const repositoryRoot = path.join(root, 'repository');
  const externalAuditRoot = path.join(root, 'audit');
  fs.mkdirSync(repositoryRoot, { mode: 0o700 });
  fs.mkdirSync(externalAuditRoot, { mode: 0o700 });
  const bindingDigest = authorityRefusalDigest({
    mandateId: 'mandate-1',
    taskId: 'task-1',
  });
  return {
    root,
    binding: {
      scope: {
        repositoryRoot,
        externalAuditRoot,
        repositoryId: deriveAuthorityAuditRepositoryId(
          'github:example/authority-refusal-audit',
        ),
      },
      family: 'task-mandate',
      operation: 'task-mandate.operation',
      subjectId: 'mandate-1',
      actor: { kind: 'engine', identity: 'workflow-engine' },
      taskId: 'task-1',
      changeId: 'change-1',
      workflowId: 'mandate-1',
      grantDigest: digest('grant'),
      bindingDigest,
      refusalIdentity: {
        mandateId: 'mandate-1',
        effectKind: 'managed-commit',
      },
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function digest(seed: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(seed).digest('hex')}`;
}

test('trusted authority refusals retain the stable error code and exact durable retry identity', () => {
  const value = fixture();
  try {
    const refusal = workflowError(
      'TASK_MANDATE_EFFECT_NOT_ALLOWED',
      'The active Task Mandate does not authorize this effect.',
      ExitCode.guard,
    );

    assert.throws(
      () =>
        withAuthorityRefusalAudit(
          value.binding,
          {
            now: new Date('2026-08-04T01:02:03.000Z'),
            serviceHooks: {
              testAfterLedgerAppend() {
                throw new Error('simulated-audit-projection-crash');
              },
            },
          },
          () => {
            throw refusal;
          },
        ),
      /simulated-audit-projection-crash/,
    );

    const recovered = recordAuthorityRefusal(value.binding, refusal, {
      now: new Date('2026-08-04T09:10:11.000Z'),
    });
    const duplicate = recordAuthorityRefusal(value.binding, refusal, {
      now: new Date('2026-08-05T09:10:11.000Z'),
    });

    assert.deepEqual(duplicate, recovered);
    assert.equal(recovered.ledger.record.sequence, 1);
    assert.equal(recovered.event.occurredAt, '2026-08-04T01:02:03.000Z');
    assert.equal(recovered.event.eventType, 'error');
    assert.equal(recovered.event.result, 'failed');
    assert.equal(recovered.event.errorCode, refusal.code);
    assert.equal(recovered.event.prestateDigest, value.binding.bindingDigest);
    assert.equal(verifyAuthorityAuditEvents(value.binding.scope).ok, true);
  } finally {
    value.cleanup();
  }
});

test('non-workflow and audit-infrastructure failures are never recast as authority refusals', () => {
  const value = fixture();
  try {
    assert.throws(
      () =>
        withAuthorityRefusalAudit(value.binding, {}, () => {
          throw new TypeError('malformed-unbound-input');
        }),
      /malformed-unbound-input/,
    );
    assert.throws(
      () =>
        withAuthorityRefusalAudit(value.binding, {}, () => {
          throw workflowError(
            'AUTHORITY_AUDIT_SCOPE_INVALID',
            'Audit scope is not trusted.',
            ExitCode.verification,
          );
        }),
      (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'AUTHORITY_AUDIT_SCOPE_INVALID',
    );
    assert.equal(
      fs.existsSync(path.join(value.binding.scope.externalAuditRoot, 'v1')),
      false,
    );
  } finally {
    value.cleanup();
  }
});
