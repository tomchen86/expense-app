import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { deriveAuthorityAuditRepositoryId } from '../src/authority-audit-ledger.ts';
import { verifyAuthorityAuditEvents } from '../src/authority-audit-service.ts';
import {
  canonicalExecutionBudgetGrantRequest,
  canonicalExecutionBudgetGrantEnvelope,
  consumeExecutionBudgetGrant,
  createExecutionBudgetGrantEnvelope,
  createExecutionBudgetGrantRequest,
  inspectExecutionBudgetGrant,
  parseExecutionBudgetGrantRequest,
  revokeExecutionBudgetGrant,
  storeExecutionBudgetGrant,
  type ExecutionBudgetGrantAuditContext,
} from '../src/modules/authority/execution-governance.ts';
import type { TaskMandateBinding } from '../src/modules/authority/task-mandate.ts';
import { isWorkflowError } from './fixture.ts';

const NOW = new Date('2026-08-04T03:00:00.000Z');
const GRANT_ID = '22222222-2222-4222-8222-222222222222';

function withFixture(
  operation: (fixture: {
    storeRoot: string;
    audit: ExecutionBudgetGrantAuditContext;
    binding: TaskMandateBinding;
  }) => void,
): void {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'execution-grant-mandate-audit-')),
  );
  const repositoryRoot = path.join(root, 'repository');
  const storeRoot = path.join(root, 'store');
  const externalAuditRoot = path.join(root, 'external-audit');
  fs.mkdirSync(repositoryRoot, { mode: 0o700 });
  fs.mkdirSync(storeRoot, { mode: 0o700 });
  fs.mkdirSync(externalAuditRoot, { mode: 0o700 });
  const binding: TaskMandateBinding = {
    schemaVersion: 1,
    mandateTaskId: 'task-plan-review',
    mandateId: '11111111-1111-4111-8111-111111111111',
    mandateDigest: 'a'.repeat(64),
    changeId: 'change-a',
    externalAuditRoot,
  };
  try {
    operation({
      storeRoot,
      binding,
      audit: {
        repositoryRoot,
        repositoryIdentity: 'github:R_execution_grant_fixture',
      },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function request(binding: TaskMandateBinding) {
  return createExecutionBudgetGrantRequest({
    requestId: '33333333-3333-4333-8333-333333333333',
    workflowId: 'workflow-a',
    epoch: 4,
    jobId: 'job-plan-review-004',
    mandateBinding: binding,
    requestedChanges: [
      { path: '/limits/timeoutMs', from: 300_000, to: 600_000 },
    ],
    rationale: 'The exact bound Attempt requires one larger timeout.',
    expiresAfterAttempts: 2,
    createdAt: NOW,
  });
}

function envelope(binding: TaskMandateBinding) {
  const grantRequest = request(binding);
  return {
    grantRequest,
    envelope: createExecutionBudgetGrantEnvelope(grantRequest, {
      grantId: GRANT_ID,
      issuedAt: NOW,
      issuer: 'fixture-maintainer',
      maxUses: 2,
      signature: 'fixture-signature',
    }),
  };
}

test('execution-budget issue, consume, and revoke are mandate-bound and externally audited', () => {
  withFixture(({ storeRoot, audit, binding }) => {
    const issued = envelope(binding);
    storeExecutionBudgetGrant(storeRoot, issued.envelope, {
      request: issued.grantRequest,
      mandateBinding: binding,
      audit,
      verify() {},
    });
    const grantDigest = `sha256:${cryptoDigest(
      canonicalExecutionBudgetGrantEnvelope(issued.envelope),
    )}`;

    const first = consumeExecutionBudgetGrant(storeRoot, {
      grantId: GRANT_ID,
      workflowId: 'workflow-a',
      epoch: 4,
      jobId: 'job-plan-review-004',
      attemptId: 'attempt-002',
      mandateBinding: binding,
      requestDigest: issued.envelope.payload.requestDigest,
      requestedChanges: issued.grantRequest.requestedChanges,
      now: new Date('2026-08-04T03:01:00.000Z'),
      audit,
    });
    assert.equal(first.mandateBinding.mandateTaskId, binding.mandateTaskId);

    const revoked = revokeExecutionBudgetGrant(storeRoot, {
      grantId: GRANT_ID,
      mandateBinding: binding,
      reason: 'The remaining replacement authority is no longer needed.',
      now: new Date('2026-08-04T03:02:00.000Z'),
      audit,
    });
    assert.equal(revoked.state, 'revoked');
    assert.deepEqual(
      revokeExecutionBudgetGrant(storeRoot, {
        grantId: GRANT_ID,
        mandateBinding: binding,
        reason: 'A replay cannot replace the durable revocation reason.',
        now: new Date('2026-08-04T03:03:00.000Z'),
        audit,
      }),
      revoked,
    );

    const verified = verifyAuthorityAuditEvents({
      repositoryRoot: audit.repositoryRoot,
      externalAuditRoot: binding.externalAuditRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(audit.repositoryIdentity),
    });
    assert.equal(verified.ok, true);
    assert.deepEqual(
      verified.events.map(({ event }) => ({
        eventType: event.eventType,
        taskId: event.taskId,
        changeId: event.changeId,
        workflowId: event.workflowId,
        grantDigest: event.grantDigest,
      })),
      [
        {
          eventType: 'escalation-request',
          taskId: binding.mandateTaskId,
          changeId: binding.changeId,
          workflowId: 'workflow-a',
          grantDigest,
        },
        {
          eventType: 'grant-consume',
          taskId: binding.mandateTaskId,
          changeId: binding.changeId,
          workflowId: 'workflow-a',
          grantDigest,
        },
        {
          eventType: 'revoke',
          taskId: binding.mandateTaskId,
          changeId: binding.changeId,
          workflowId: 'workflow-a',
          grantDigest,
        },
      ],
    );
  });
});

test('cross-task or cross-audit-root grants fail before consumption', () => {
  withFixture(({ storeRoot, audit, binding }) => {
    const issued = envelope(binding);
    storeExecutionBudgetGrant(storeRoot, issued.envelope, {
      request: issued.grantRequest,
      mandateBinding: binding,
      audit,
      verify() {},
    });
    for (const wrongBinding of [
      { ...binding, mandateTaskId: 'other-task' },
      {
        ...binding,
        externalAuditRoot: path.join(
          path.dirname(binding.externalAuditRoot),
          'other-audit',
        ),
      },
    ]) {
      assert.throws(
        () =>
          consumeExecutionBudgetGrant(storeRoot, {
            grantId: GRANT_ID,
            workflowId: 'workflow-a',
            epoch: 4,
            jobId: 'job-plan-review-004',
            attemptId: `attempt-${wrongBinding.mandateTaskId}`,
            mandateBinding: wrongBinding,
            requestDigest: issued.envelope.payload.requestDigest,
            requestedChanges: issued.grantRequest.requestedChanges,
            now: new Date('2026-08-04T03:01:00.000Z'),
            audit,
          }),
        (error) =>
          isWorkflowError(error, 'EXECUTION_BUDGET_GRANT_MANDATE_MISMATCH'),
      );
    }
    assert.deepEqual(inspectExecutionBudgetGrant(storeRoot, GRANT_ID), {
      state: 'active',
      remainingUses: 2,
      receipts: [],
    });
    const verified = verifyAuthorityAuditEvents({
      repositoryRoot: audit.repositoryRoot,
      externalAuditRoot: binding.externalAuditRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(audit.repositoryIdentity),
    });
    assert.deepEqual(
      verified.events
        .filter(({ event }) => event.eventType === 'error')
        .map(({ event }) => event.errorCode),
      [
        'EXECUTION_BUDGET_GRANT_MANDATE_MISMATCH',
        'EXECUTION_BUDGET_GRANT_MANDATE_MISMATCH',
      ],
    );
    assert.equal(
      fs.existsSync(
        path.join(path.dirname(binding.externalAuditRoot), 'other-audit'),
      ),
      false,
    );
  });
});

test('fully consumed grant refusal is audited from its verified stored envelope', () => {
  withFixture(({ storeRoot, audit, binding }) => {
    const issued = envelope(binding);
    storeExecutionBudgetGrant(storeRoot, issued.envelope, {
      request: issued.grantRequest,
      mandateBinding: binding,
      audit,
      verify() {},
    });
    consumeExecutionBudgetGrant(storeRoot, {
      grantId: GRANT_ID,
      workflowId: 'workflow-a',
      epoch: 4,
      jobId: 'job-plan-review-004',
      attemptId: 'attempt-fully-consume',
      mandateBinding: binding,
      requestDigest: issued.envelope.payload.requestDigest,
      requestedChanges: issued.grantRequest.requestedChanges,
      now: new Date('2026-08-04T03:01:00.000Z'),
      audit,
    });
    consumeExecutionBudgetGrant(storeRoot, {
      grantId: GRANT_ID,
      workflowId: 'workflow-a',
      epoch: 4,
      jobId: 'job-plan-review-004',
      attemptId: 'attempt-fully-consume-2',
      mandateBinding: binding,
      requestDigest: issued.envelope.payload.requestDigest,
      requestedChanges: issued.grantRequest.requestedChanges,
      now: new Date('2026-08-04T03:02:00.000Z'),
      audit,
    });

    assert.throws(
      () =>
        revokeExecutionBudgetGrant(storeRoot, {
          grantId: GRANT_ID,
          mandateBinding: binding,
          reason: 'No authority remains to revoke.',
          now: new Date('2026-08-04T03:03:00.000Z'),
          audit,
        }),
      (error) =>
        isWorkflowError(error, 'EXECUTION_BUDGET_GRANT_ALREADY_CONSUMED'),
    );

    const verified = verifyAuthorityAuditEvents({
      repositoryRoot: audit.repositoryRoot,
      externalAuditRoot: binding.externalAuditRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(audit.repositoryIdentity),
    });
    assert.equal(verified.events.at(-1)?.event.eventType, 'error');
    assert.equal(
      verified.events.at(-1)?.event.errorCode,
      'EXECUTION_BUDGET_GRANT_ALREADY_CONSUMED',
    );
  });
});

test('audit failure leaves no available grant and exact retry recovers publication', () => {
  withFixture(({ storeRoot, audit, binding }) => {
    const issued = envelope(binding);
    assert.throws(
      () =>
        storeExecutionBudgetGrant(storeRoot, issued.envelope, {
          request: issued.grantRequest,
          mandateBinding: binding,
          audit: {
            ...audit,
            serviceHooks: {
              testAfterLedgerAppend() {
                throw new Error('simulated audit publication crash');
              },
            },
          },
          verify() {},
        }),
      /simulated audit publication crash/,
    );
    assert.throws(
      () => inspectExecutionBudgetGrant(storeRoot, GRANT_ID),
      (error) => isWorkflowError(error, 'EXECUTION_BUDGET_GRANT_NOT_FOUND'),
    );

    storeExecutionBudgetGrant(storeRoot, issued.envelope, {
      request: issued.grantRequest,
      mandateBinding: binding,
      audit,
      verify() {},
    });
    assert.equal(
      inspectExecutionBudgetGrant(storeRoot, GRANT_ID).state,
      'active',
    );
  });
});

test('legacy unbound requests remain readable but cannot issue new authority', () => {
  withFixture(({ storeRoot, audit, binding }) => {
    const legacy = parseExecutionBudgetGrantRequest(
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'execution-budget-grant-request',
        requestId: '33333333-3333-4333-8333-333333333333',
        workflowId: 'workflow-a',
        epoch: 4,
        jobId: 'job-plan-review-004',
        requestedChanges: [
          { path: '/limits/timeoutMs', from: 300_000, to: 600_000 },
        ],
        rationale: 'Legacy persisted request without mandate binding.',
        expiresAfterAttempts: 1,
        createdAt: NOW.toISOString(),
      })}\n`,
    );
    assert.equal(
      canonicalExecutionBudgetGrantRequest(legacy).includes('mandateBinding'),
      false,
    );
    const legacyEnvelope = createExecutionBudgetGrantEnvelope(legacy, {
      grantId: GRANT_ID,
      issuedAt: NOW,
      issuer: 'fixture-maintainer',
      maxUses: 1,
      signature: 'fixture-signature',
    });
    assert.throws(
      () =>
        storeExecutionBudgetGrant(storeRoot, legacyEnvelope, {
          request: legacy,
          mandateBinding: binding,
          audit,
          verify() {},
        }),
      (error) =>
        isWorkflowError(error, 'EXECUTION_BUDGET_GRANT_LEGACY_READ_ONLY'),
    );
  });
});

function cryptoDigest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
