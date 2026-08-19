import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  deriveAuthorityAuditRepositoryId,
  type AuthorityAuditLedgerScope,
} from '../src/authority-audit-ledger.ts';
import {
  showAuthorityAuditTask,
  verifyAuthorityAuditEvents,
} from '../src/authority-audit-service.ts';
import {
  externalEffectStorePaths,
  inspectExternalEffectGrant,
  issueExternalEffectGrant,
  markExternalEffectDispatchIssued,
  reconcileExternalEffectGrant,
  reserveExternalEffectGrant,
  terminalizeExternalEffectGrant,
  type ExternalEffectReconciliationOutcome,
  type Sha256Digest,
} from '../src/modules/authority/external-effect-grant.ts';
import { executePublishGrant } from '../src/publish-executor.ts';
import { revokeTaskMandate } from '../src/modules/authority/task-mandate.ts';
import {
  EFFECT_GRANT_ID as GRANT_ID,
  EFFECT_ISSUED_AT as ISSUED_AT,
  EFFECT_TASK_ID as TASK_ID,
  prepareExternalEffectFixture as prepareFixture,
  publishGrantRequest,
} from './external-effect-fixture.ts';
import { isWorkflowError } from './fixture.ts';

const DISPATCHED_AT = new Date('2026-08-04T01:00:20.000Z');
const MANUAL_AT = new Date('2026-08-04T01:00:30.000Z');
const RESOLVED_AT = new Date('2026-08-04T01:01:00.000Z');

test('human reconciliation durably resolves unknown success without replaying the effect', () => {
  const fixture = prepareFixture();
  try {
    enterManualReconciliation(fixture);
    const before = inspectExternalEffectGrant(fixture.repository, GRANT_ID, {
      signer: fixture.signer,
    });
    assert.equal(before.state, 'manual-reconciliation');
    assert.equal(before.reconciliation, null);

    // Completion of an already-issued external effect remains possible after
    // the parent mandate is revoked; authority and audit scope come from the
    // exact signed grant rather than from new effect authority.
    revokeTaskMandate(fixture.repository, TASK_ID, {
      now: new Date('2026-08-04T01:00:40.000Z'),
      reason: 'No new effect authority remains.',
      signer: fixture.signer,
    });
    const request = reconciliationRequest('succeeded', {
      externalReceiptId: 'remote-receipt-123',
      poststateDigest: digest('observed remote success'),
    });
    const resolved = reconcileExternalEffectGrant(
      fixture.repository,
      GRANT_ID,
      request,
      {
        now: RESOLVED_AT,
        onAuditRecord: fixture.audit,
        signer: fixture.signer,
      },
    );
    const replay = reconcileExternalEffectGrant(
      fixture.repository,
      GRANT_ID,
      request,
      {
        now: new Date('2026-08-04T01:01:10.000Z'),
        onAuditRecord: fixture.audit,
        signer: fixture.signer,
      },
    );

    assert.equal(resolved.state, 'reconciled-succeeded');
    assert.deepEqual(replay, resolved);
    assert.equal(resolved.transactionToken, null);
    assert.equal(resolved.reconciliation?.outcome, 'succeeded');
    assert.equal(
      resolved.reconciliation?.evidenceDigest,
      request.evidenceDigest,
    );
    assert.equal(
      resolved.reconciliation?.poststateDigest,
      request.poststateDigest,
    );
    assert.equal(resolved.reconciliation?.resolver, fixture.signer.identity());
    assert.equal(
      fixture.events.filter(
        ({ eventType }) => eventType === 'reconciliation-resolved',
      ).length,
      1,
    );

    let dispatches = 0;
    const executorReplay = executePublishGrant(fixture.repository, GRANT_ID, {
      onAuditRecord: fixture.audit,
      now: new Date('2026-08-04T01:01:20.000Z'),
      runner: {
        dispatch() {
          dispatches += 1;
          return { state: 'unknown', reason: 'must never replay' };
        },
      },
      signer: fixture.signer,
    });
    assert.equal(executorReplay.state, 'reconciled-succeeded');
    assert.equal(dispatches, 0);

    const audit = showAuthorityAuditTask(auditScope(fixture), TASK_ID)
      .events.map(({ event }) => event)
      .find(
        (event) =>
          event.command?.name === 'external-effect.reconciliation-resolved',
      );
    assert.ok(audit);
    assert.deepEqual(audit.actor, {
      kind: 'human',
      identity: fixture.signer.identity(),
    });
    assert.equal(audit.taskId, TASK_ID);
    assert.equal(audit.changeId, fixture.binding.changeId);
    assert.equal(audit.poststateDigest, request.poststateDigest);
  } finally {
    fixture.dispose();
  }
});

test('manual reconciliation records rolled-back and failed outcomes with exact evidence', () => {
  for (const outcome of ['rolled-back', 'failed'] as const) {
    const fixture = prepareFixture();
    try {
      enterManualReconciliation(fixture);
      const request = reconciliationRequest(outcome, {
        externalReceiptId:
          outcome === 'rolled-back' ? 'rollback-receipt-123' : null,
        poststateDigest:
          outcome === 'rolled-back'
            ? publishGrantRequest(fixture).prestateDigest
            : null,
      });
      const resolved = reconcileExternalEffectGrant(
        fixture.repository,
        GRANT_ID,
        request,
        {
          now: RESOLVED_AT,
          onAuditRecord: fixture.audit,
          signer: fixture.signer,
        },
      );
      assert.equal(resolved.state, `reconciled-${outcome}`);
      assert.equal(resolved.reconciliation?.outcome, outcome);
      assert.equal(
        resolved.reconciliation?.evidenceDigest,
        request.evidenceDigest,
      );
      assert.equal(
        inspectExternalEffectGrant(fixture.repository, GRANT_ID, {
          signer: fixture.signer,
        }).state,
        `reconciled-${outcome}`,
      );
    } finally {
      fixture.dispose();
    }
  }
});

test('reconciliation is manual-only, exact, conflict-safe, and fail-closed', () => {
  const available = prepareFixture();
  try {
    issue(available);
    assert.throws(
      () =>
        reconcileExternalEffectGrant(
          available.repository,
          GRANT_ID,
          reconciliationRequest('failed'),
          {
            now: RESOLVED_AT,
            onAuditRecord: available.audit,
            signer: available.signer,
          },
        ),
      (error) =>
        isWorkflowError(error, 'EXTERNAL_EFFECT_RECONCILIATION_NOT_REQUIRED'),
    );
  } finally {
    available.dispose();
  }

  const conflict = prepareFixture();
  try {
    enterManualReconciliation(conflict);
    const request = reconciliationRequest('failed');
    reconcileExternalEffectGrant(conflict.repository, GRANT_ID, request, {
      now: RESOLVED_AT,
      onAuditRecord: conflict.audit,
      signer: conflict.signer,
    });
    assert.throws(
      () =>
        reconcileExternalEffectGrant(
          conflict.repository,
          GRANT_ID,
          { ...request, evidenceDigest: digest('different evidence') },
          {
            now: new Date('2026-08-04T01:01:10.000Z'),
            onAuditRecord: conflict.audit,
            signer: conflict.signer,
          },
        ),
      (error) =>
        isWorkflowError(error, 'EXTERNAL_EFFECT_RECONCILIATION_CONFLICT'),
    );
    assert.throws(
      () =>
        reconcileExternalEffectGrant(
          conflict.repository,
          GRANT_ID,
          reconciliationRequest('rolled-back', {
            poststateDigest: digest('not the signed prestate'),
          }),
          {
            now: new Date('2026-08-04T01:01:20.000Z'),
            onAuditRecord: conflict.audit,
            signer: conflict.signer,
          },
        ),
      (error) =>
        isWorkflowError(error, 'EXTERNAL_EFFECT_RECONCILIATION_INVALID'),
    );
  } finally {
    conflict.dispose();
  }
});

test('ledger-first reconciliation crash is recovered by an exact retry', () => {
  const fixture = prepareFixture();
  try {
    enterManualReconciliation(fixture);
    const request = reconciliationRequest('failed');
    assert.throws(
      () =>
        reconcileExternalEffectGrant(fixture.repository, GRANT_ID, request, {
          now: RESOLVED_AT,
          onAuditRecord: fixture.audit,
          signer: fixture.signer,
          testAuditServiceHooks: {
            testAfterLedgerAppend() {
              throw new Error('simulated-reconciliation-audit-crash');
            },
          },
        }),
      /simulated-reconciliation-audit-crash/,
    );
    const paths = externalEffectStorePaths(
      path.join(fixture.repository, '.git'),
    );
    assert.equal(
      fs.existsSync(
        path.join(paths.terminal, `${GRANT_ID}.reconciliation.json`),
      ),
      false,
    );
    assert.equal(verifyAuthorityAuditEvents(auditScope(fixture)).ok, false);

    const recovered = reconcileExternalEffectGrant(
      fixture.repository,
      GRANT_ID,
      request,
      {
        now: RESOLVED_AT,
        onAuditRecord: fixture.audit,
        signer: fixture.signer,
      },
    );
    assert.equal(recovered.state, 'reconciled-failed');
    assert.equal(verifyAuthorityAuditEvents(auditScope(fixture)).ok, true);
  } finally {
    fixture.dispose();
  }
});

function enterManualReconciliation(
  fixture: ReturnType<typeof prepareFixture>,
): void {
  issue(fixture);
  const reserved = reserveExternalEffectGrant(fixture.repository, GRANT_ID, {
    now: new Date('2026-08-04T01:00:10.000Z'),
    onAuditRecord: fixture.audit,
    signer: fixture.signer,
  });
  assert.ok(reserved.transactionId);
  markExternalEffectDispatchIssued(
    fixture.repository,
    GRANT_ID,
    reserved.transactionId,
    {
      now: DISPATCHED_AT,
      onAuditRecord: fixture.audit,
      signer: fixture.signer,
    },
  );
  terminalizeExternalEffectGrant(
    fixture.repository,
    GRANT_ID,
    reserved.transactionId,
    'manual-reconciliation',
    'Dispatch boundary is unknown.',
    {
      now: MANUAL_AT,
      onAuditRecord: fixture.audit,
      signer: fixture.signer,
    },
  );
}

function issue(fixture: ReturnType<typeof prepareFixture>): void {
  issueExternalEffectGrant(fixture.repository, publishGrantRequest(fixture), {
    now: ISSUED_AT,
    onAuditRecord: fixture.audit,
    grantId: GRANT_ID,
    signer: fixture.signer,
  });
}

function reconciliationRequest(
  outcome: ExternalEffectReconciliationOutcome,
  overrides: {
    externalReceiptId?: string | null;
    poststateDigest?: Sha256Digest | null;
  } = {},
) {
  return {
    outcome,
    evidenceDigest: digest(`operator evidence for ${outcome}`),
    externalReceiptId: overrides.externalReceiptId ?? null,
    poststateDigest: overrides.poststateDigest ?? null,
    observedAt: '2026-08-04T01:00:50.000Z',
    reason: `Human verified ${outcome}.`,
  };
}

function digest(value: string): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
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
