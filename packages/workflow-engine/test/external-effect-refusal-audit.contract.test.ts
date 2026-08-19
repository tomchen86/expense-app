import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import {
  deriveAuthorityAuditRepositoryId,
  type AuthorityAuditLedgerScope,
} from '../src/runtime/storage-journal/authority-audit-ledger.ts';
import {
  showAuthorityAuditTask,
  verifyAuthorityAuditEvents,
} from '../src/runtime/storage-journal/authority-audit-service.ts';
import {
  consumeExternalEffectGrant,
  issueExternalEffectGrant,
  markExternalEffectDispatchIssued,
  reconcileExternalEffectGrant,
  recordExternalEffectObservation,
  reserveExternalEffectGrant,
  revokeExternalEffectGrant,
  terminalizeExternalEffectGrant,
} from '../src/modules/authority/external-effect-grant.ts';
import {
  EFFECT_GRANT_ID as GRANT_ID,
  EFFECT_ISSUED_AT as ISSUED_AT,
  EFFECT_TASK_ID as TASK_ID,
  prepareExternalEffectFixture as prepareFixture,
  publishGrantRequest,
} from './external-effect-fixture.ts';
import { isWorkflowError } from './fixture.ts';

const TRANSITION_AT = new Date('2026-08-04T01:00:20.000Z');

test('trusted external-effect transition refusals preserve codes and append one durable error per exact retry', () => {
  const scenarios = [
    {
      code: 'EXTERNAL_EFFECT_STATE_CONFLICT',
      operation: 'external-effect.observation',
      reject(fixture: ReturnType<typeof prepareFixture>) {
        const transaction = reserve(fixture);
        recordExternalEffectObservation(
          fixture.repository,
          GRANT_ID,
          transaction,
          observation(fixture),
          transitionOptions(fixture),
        );
      },
    },
    {
      code: 'EXTERNAL_EFFECT_STATE_CONFLICT',
      operation: 'external-effect.consume',
      reject(fixture: ReturnType<typeof prepareFixture>) {
        consumeExternalEffectGrant(
          fixture.repository,
          GRANT_ID,
          reserve(fixture),
          transitionOptions(fixture),
        );
      },
    },
    {
      code: 'EXTERNAL_EFFECT_STATE_CONFLICT',
      operation: 'external-effect.terminalize',
      reject(fixture: ReturnType<typeof prepareFixture>) {
        const transaction = reserve(fixture);
        markExternalEffectDispatchIssued(
          fixture.repository,
          GRANT_ID,
          transaction,
          transitionOptions(fixture),
        );
        recordExternalEffectObservation(
          fixture.repository,
          GRANT_ID,
          transaction,
          observation(fixture),
          transitionOptions(fixture),
        );
        terminalizeExternalEffectGrant(
          fixture.repository,
          GRANT_ID,
          transaction,
          'failed',
          'Executor reported failure after an observation was durable.',
          transitionOptions(fixture),
        );
      },
    },
    {
      code: 'EXTERNAL_EFFECT_RECONCILIATION_NOT_REQUIRED',
      operation: 'external-effect.reconcile',
      reject(fixture: ReturnType<typeof prepareFixture>) {
        reconcileExternalEffectGrant(
          fixture.repository,
          GRANT_ID,
          {
            outcome: 'failed',
            evidenceDigest: digest('independent failure evidence'),
            externalReceiptId: null,
            poststateDigest: null,
            observedAt: TRANSITION_AT.toISOString(),
            reason: 'No unknown dispatch exists to reconcile.',
          },
          transitionOptions(fixture),
        );
      },
    },
    {
      code: 'EXTERNAL_EFFECT_RECONCILIATION_REQUIRED',
      operation: 'external-effect.revoke',
      reject(fixture: ReturnType<typeof prepareFixture>) {
        const transaction = reserve(fixture);
        markExternalEffectDispatchIssued(
          fixture.repository,
          GRANT_ID,
          transaction,
          transitionOptions(fixture),
        );
        revokeExternalEffectGrant(fixture.repository, GRANT_ID, {
          ...transitionOptions(fixture),
          reason: 'Do not silently revoke an already-dispatched effect.',
        });
      },
    },
  ] as const;

  for (const scenario of scenarios) {
    const fixture = prepareFixture();
    try {
      issueExternalEffectGrant(
        fixture.repository,
        publishGrantRequest(fixture),
        {
          grantId: GRANT_ID,
          now: ISSUED_AT,
          signer: fixture.signer,
        },
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.throws(
          () => scenario.reject(fixture),
          (error) => isWorkflowError(error, scenario.code),
        );
      }
      const errors = showAuthorityAuditTask(auditScope(fixture), TASK_ID)
        .events.map(({ event }) => event)
        .filter(
          (event) =>
            event.eventType === 'error' &&
            event.command?.name === scenario.operation,
        );
      assert.equal(errors.length, 1, scenario.operation);
      assert.equal(errors[0]?.result, 'failed');
      assert.equal(errors[0]?.errorCode, scenario.code);
    } finally {
      fixture.dispose();
    }
  }
});

test('external-effect refusal audit recovers a ledger-first crash without replaying the effect', () => {
  const fixture = prepareFixture();
  try {
    issueExternalEffectGrant(fixture.repository, publishGrantRequest(fixture), {
      grantId: GRANT_ID,
      now: ISSUED_AT,
      signer: fixture.signer,
    });
    const transaction = reserve(fixture);
    markExternalEffectDispatchIssued(
      fixture.repository,
      GRANT_ID,
      transaction,
      transitionOptions(fixture),
    );
    assert.throws(
      () =>
        revokeExternalEffectGrant(fixture.repository, GRANT_ID, {
          ...transitionOptions(fixture),
          reason: 'Do not silently revoke an already-dispatched effect.',
          testAuditServiceHooks: {
            testAfterLedgerAppend() {
              throw new Error('simulated-refusal-audit-crash');
            },
          },
        }),
      // The refusal survives a failed attempt to record it: the caller still
      // learns reconciliation is required, with the audit crash as the cause.
      (error) => {
        assert.equal(
          isWorkflowError(error, 'EXTERNAL_EFFECT_RECONCILIATION_REQUIRED'),
          true,
        );
        assert.match(
          String((error as Error & { cause?: unknown }).cause),
          /simulated-refusal-audit-crash/,
        );
        return true;
      },
    );
    assert.equal(verifyAuthorityAuditEvents(auditScope(fixture)).ok, false);
    assert.throws(
      () =>
        revokeExternalEffectGrant(fixture.repository, GRANT_ID, {
          ...transitionOptions(fixture),
          reason: 'Do not silently revoke an already-dispatched effect.',
        }),
      (error) =>
        isWorkflowError(error, 'EXTERNAL_EFFECT_RECONCILIATION_REQUIRED'),
    );
    assert.equal(verifyAuthorityAuditEvents(auditScope(fixture)).ok, true);
    const errors = showAuthorityAuditTask(auditScope(fixture), TASK_ID)
      .events.map(({ event }) => event)
      .filter(
        (event) =>
          event.eventType === 'error' &&
          event.command?.name === 'external-effect.revoke',
      );
    assert.equal(errors.length, 1);
  } finally {
    fixture.dispose();
  }
});

function reserve(fixture: ReturnType<typeof prepareFixture>): string {
  return reserveExternalEffectGrant(fixture.repository, GRANT_ID, {
    now: new Date('2026-08-04T01:00:10.000Z'),
    signer: fixture.signer,
  }).transactionId!;
}

function transitionOptions(fixture: ReturnType<typeof prepareFixture>) {
  return { now: TRANSITION_AT, signer: fixture.signer };
}

function observation(fixture: ReturnType<typeof prepareFixture>) {
  const request = publishGrantRequest(fixture);
  return {
    externalReceiptId: 'remote-receipt-123',
    artifactDigest: request.artifactDigest,
    prestateDigest: request.prestateDigest,
    poststateDigest: digest('remote poststate'),
    observedAt: TRANSITION_AT.toISOString(),
  };
}

function auditScope(fixture: {
  externalAuditRoot: string;
  repository: string;
}): AuthorityAuditLedgerScope {
  return {
    externalAuditRoot: fixture.externalAuditRoot,
    repositoryRoot: fs.realpathSync(fixture.repository),
    repositoryId: deriveAuthorityAuditRepositoryId('github:R_fixture'),
  };
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
