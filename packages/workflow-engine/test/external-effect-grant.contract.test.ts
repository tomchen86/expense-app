import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  deriveAuthorityAuditRepositoryId,
  type AuthorityAuditLedgerScope,
} from '../src/authority-audit-ledger.ts';
import {
  showAuthorityAuditTask,
  verifyAuthorityAuditEvents,
} from '../src/authority-audit-service.ts';
import {
  canonicalExternalEffectGrantEnvelope,
  canonicalExternalEffectGrantPayload,
  EXTERNAL_EFFECT_SIGNATURE_NAMESPACE,
  externalEffectStorePaths,
  inspectExternalEffectGrant,
  issueExternalEffectGrant,
  parseExternalEffectGrantEnvelope,
  reserveExternalEffectGrant,
  revokeExternalEffectGrant,
  type ExternalEffectKind,
} from '../src/modules/authority/external-effect-grant.ts';
import {
  EFFECT_GRANT_ID as GRANT_ID,
  EFFECT_ISSUED_AT as ISSUED_AT,
  EFFECT_MANDATE_ID as MANDATE_ID,
  EFFECT_TASK_ID as TASK_ID,
  prepareExternalEffectFixture as prepareFixture,
  publishGrantRequest,
} from './external-effect-fixture.ts';
import { isWorkflowError } from './fixture.ts';
import { revokeTaskMandate } from '../src/modules/authority/task-mandate.ts';

test('a human issues one domain-separated five-minute grant bound to the exact mandate and effect', () => {
  const fixture = prepareFixture();
  try {
    const request = publishGrantRequest(fixture);
    const result = issueExternalEffectGrant(fixture.repository, request, {
      onAuditRecord: fixture.audit,
      grantId: GRANT_ID,
      now: ISSUED_AT,
      signer: fixture.signer,
    });

    assert.equal(fixture.humanPresence, 2);
    assert.equal(result.envelope.payload.kind, 'external-effect-grant.v1');
    assert.equal(result.envelope.payload.uses, 1);
    assert.equal(
      result.envelope.payload.externalAuditRoot,
      fixture.externalAuditRoot,
    );
    assert.equal(result.envelope.payload.mandateId, MANDATE_ID);
    assert.equal(result.envelope.payload.taskId, TASK_ID);
    assert.equal(
      result.envelope.payload.mandateDigest,
      fixture.binding.mandateDigest,
    );
    assert.equal(result.envelope.payload.effectKind, 'publish-git-ref');
    assert.deepEqual(result.envelope.payload.target, request.target);
    assert.equal(
      result.envelope.payload.artifactDigest,
      request.artifactDigest,
    );
    assert.equal(
      result.envelope.payload.prestateDigest,
      request.prestateDigest,
    );
    assert.deepEqual(
      result.envelope.payload.rollbackPlan,
      request.rollbackPlan,
    );
    assert.equal(
      result.envelope.payload.idempotencyKey,
      request.idempotencyKey,
    );
    assert.equal(result.envelope.payload.expiresAt, '2026-08-04T01:05:00.000Z');
    assert.equal(
      fixture.signedByDomain
        .get(EXTERNAL_EFFECT_SIGNATURE_NAMESPACE)
        ?.has(canonicalExternalEffectGrantPayload(result.envelope.payload)),
      true,
    );
    assert.deepEqual(
      parseExternalEffectGrantEnvelope(
        canonicalExternalEffectGrantEnvelope(result.envelope),
      ),
      result.envelope,
    );

    const inspection = inspectExternalEffectGrant(
      fixture.repository,
      GRANT_ID,
      { now: ISSUED_AT, signer: fixture.signer },
    );
    assert.equal(inspection.state, 'available');
    assert.equal(inspection.grantDigest, result.grantDigest);
    assert.equal(fixture.events[0]?.eventType, 'grant-issued');
    assert.equal(fixture.events[0]?.taskId, TASK_ID);
    assert.equal(fixture.events[0]?.mandateId, MANDATE_ID);
    assert.equal(fixture.events[0]?.grantDigest, result.grantDigest);

    const paths = externalEffectStorePaths(
      path.join(fixture.repository, '.git'),
    );
    for (const directory of [
      paths.root,
      paths.pending,
      paths.available,
      paths.transactions,
      paths.terminal,
      paths.idempotency,
    ]) {
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    }
    assert.equal(fs.statSync(result.recordPath).mode & 0o777, 0o600);
    assert.equal(
      fs.readFileSync(result.recordPath, 'utf8'),
      `${canonicalJson(JSON.parse(fs.readFileSync(result.recordPath, 'utf8')))}\n`,
    );
  } finally {
    fixture.dispose();
  }
});

test('issuance fails closed without an active mandate and after human revocation', () => {
  for (const state of ['missing', 'revoked'] as const) {
    const fixture = prepareFixture();
    try {
      if (state === 'missing') {
        fs.unlinkSync(
          path.join(
            fixture.repository,
            '.git/workflow-engine/task-mandates/active',
            `${TASK_ID}.json`,
          ),
        );
      } else {
        revokeTaskMandate(fixture.repository, TASK_ID, {
          now: new Date('2026-08-04T01:00:01.000Z'),
          reason: 'Cancel all remaining task authority.',
          signer: fixture.signer,
        });
      }
      assert.throws(
        () =>
          issueExternalEffectGrant(
            fixture.repository,
            publishGrantRequest(fixture),
            {
              onAuditRecord: fixture.audit,
              grantId: GRANT_ID,
              now: new Date('2026-08-04T01:00:02.000Z'),
              signer: fixture.signer,
            },
          ),
        (error) =>
          isWorkflowError(
            error,
            state === 'missing'
              ? 'TASK_MANDATE_NOT_FOUND'
              : 'TASK_MANDATE_REVOKED',
          ),
      );
    } finally {
      fixture.dispose();
    }
  }
});

test('ledger-first audit crash publishes no grant and exact retry recovers the projection', () => {
  const failedAudit = prepareFixture();
  try {
    assert.throws(
      () =>
        issueExternalEffectGrant(
          failedAudit.repository,
          publishGrantRequest(failedAudit),
          {
            testAuditServiceHooks: {
              testAfterLedgerAppend() {
                throw new Error('simulated-ledger-first-crash');
              },
            },
            grantId: GRANT_ID,
            now: ISSUED_AT,
            signer: failedAudit.signer,
          },
        ),
      /simulated-ledger-first-crash/,
    );
    const paths = externalEffectStorePaths(
      path.join(failedAudit.repository, '.git'),
    );
    assert.deepEqual(fs.readdirSync(paths.available), []);
    assert.deepEqual(fs.readdirSync(paths.idempotency), []);
    assert.deepEqual(fs.readdirSync(paths.pending), [`${GRANT_ID}.json`]);

    const interrupted = verifyAuthorityAuditEvents(auditScope(failedAudit));
    assert.equal(interrupted.ok, false);
    assert.equal(interrupted.legacyUnprojectedCount, 1);

    const recovered = issueExternalEffectGrant(
      failedAudit.repository,
      publishGrantRequest(failedAudit),
      {
        onAuditRecord: failedAudit.audit,
        grantId: GRANT_ID,
        now: new Date('2026-08-04T01:00:01.000Z'),
        signer: failedAudit.signer,
      },
    );
    assert.equal(recovered.grantId, GRANT_ID);
    assert.deepEqual(fs.readdirSync(paths.pending), []);
    assert.deepEqual(fs.readdirSync(paths.available), [`${GRANT_ID}.json`]);
    assert.equal(verifyAuthorityAuditEvents(auditScope(failedAudit)).ok, true);
  } finally {
    failedAudit.dispose();
  }
});

test('one durable idempotency key cannot identify two grants', () => {
  const duplicate = prepareFixture();
  try {
    const request = publishGrantRequest(duplicate);
    issueExternalEffectGrant(duplicate.repository, request, {
      onAuditRecord: duplicate.audit,
      grantId: GRANT_ID,
      now: ISSUED_AT,
      signer: duplicate.signer,
    });
    assert.throws(
      () =>
        issueExternalEffectGrant(duplicate.repository, request, {
          onAuditRecord: duplicate.audit,
          grantId: '66666666-6666-4666-8666-666666666666',
          now: new Date('2026-08-04T01:00:01.000Z'),
          signer: duplicate.signer,
        }),
      (error) => isWorkflowError(error, 'EXTERNAL_EFFECT_IDEMPOTENCY_CONFLICT'),
    );
  } finally {
    duplicate.dispose();
  }
});

test('production authority audit service records task-correlated external-effect details', () => {
  const fixture = prepareFixture();
  const correlated: string[] = [];
  try {
    const issued = issueExternalEffectGrant(
      fixture.repository,
      publishGrantRequest(fixture),
      {
        onAuditRecord(event) {
          correlated.push(
            `${event.changeId}:${event.taskId}:${event.mandateId}`,
          );
        },
        grantId: GRANT_ID,
        now: ISSUED_AT,
        signer: fixture.signer,
      },
    );
    const verified = verifyAuthorityAuditEvents(auditScope(fixture));
    assert.equal(verified.ok, true);
    assert.equal(verified.legacyUnprojectedCount, 0);
    const recorded = showAuthorityAuditTask(auditScope(fixture), TASK_ID)
      .events.map(({ event }) => event)
      .find(
        (event) =>
          event.command?.name === 'external-effect.grant-issued' &&
          event.grantDigest === issued.grantDigest,
      );
    assert.ok(recorded);
    assert.deepEqual(recorded.actor, {
      kind: 'engine',
      identity: 'workflow-engine',
    });
    assert.equal(recorded.taskId, TASK_ID);
    assert.equal(recorded.changeId, 'demo-change');
    assert.equal(recorded.workflowId, 'demo-change');
    assert.equal(recorded.externalEffect?.kind, 'publish-git-ref');
    assert.equal(recorded.result, 'recorded');
    assert.equal(recorded.errorCode, null);
    assert.deepEqual(correlated, [`demo-change:${TASK_ID}:${MANDATE_ID}`]);
  } finally {
    fixture.dispose();
  }
});

test('issuance rejects stale mandate identity, excessive TTL, and an untrusted signer', () => {
  const fixture = prepareFixture();
  try {
    const request = publishGrantRequest(fixture);
    assert.throws(
      () =>
        issueExternalEffectGrant(
          fixture.repository,
          {
            ...request,
            mandateBinding: {
              ...request.mandateBinding,
              mandateDigest: '0'.repeat(64),
            },
          },
          {
            onAuditRecord: fixture.audit,
            grantId: GRANT_ID,
            now: ISSUED_AT,
            signer: fixture.signer,
          },
        ),
      (error) => isWorkflowError(error, 'EXTERNAL_EFFECT_MANDATE_MISMATCH'),
    );
    assert.throws(
      () =>
        issueExternalEffectGrant(
          fixture.repository,
          { ...request, ttlSeconds: 301 },
          {
            onAuditRecord: fixture.audit,
            grantId: GRANT_ID,
            now: ISSUED_AT,
            signer: fixture.signer,
          },
        ),
      (error) => isWorkflowError(error, 'EXTERNAL_EFFECT_GRANT_INVALID'),
    );
    const untrusted = fixture.signerWithIdentity('untrusted-maintainer');
    assert.throws(
      () =>
        issueExternalEffectGrant(fixture.repository, request, {
          onAuditRecord: fixture.audit,
          grantId: GRANT_ID,
          now: ISSUED_AT,
          signer: untrusted,
        }),
      (error) => isWorkflowError(error, 'EXTERNAL_EFFECT_SIGNER_UNTRUSTED'),
    );
  } finally {
    fixture.dispose();
  }
});

test('issuance fails closed for every effect kind without a production executor', () => {
  const unsupportedKinds: ExternalEffectKind[] = [
    'force-push-git-ref',
    'deploy-production',
    'delete-remote-resource',
    'send-external-message',
    'database-write',
    'provider-budget-expansion',
    'secret-scope-expansion',
  ];
  for (const effectKind of unsupportedKinds) {
    const fixture = prepareFixture();
    try {
      const publish = publishGrantRequest(fixture);
      const request = {
        ...publish,
        effectKind,
        target:
          effectKind === 'force-push-git-ref'
            ? publish.target
            : {
                kind: 'external-resource' as const,
                service: 'unsupported-fixture-service',
                resource: effectKind,
              },
        rollbackPlan: null,
        idempotencyKey: `unsupported:${effectKind}`,
      };
      assert.throws(
        () =>
          issueExternalEffectGrant(fixture.repository, request, {
            onAuditRecord: fixture.audit,
            grantId: GRANT_ID,
            now: ISSUED_AT,
            signer: fixture.signer,
          }),
        (error) =>
          isWorkflowError(error, 'EXTERNAL_EFFECT_EXECUTOR_UNAVAILABLE'),
      );
      assert.equal(fixture.humanPresence, 1);
      assert.deepEqual(fixture.events, []);
      const paths = externalEffectStorePaths(
        path.join(fixture.repository, '.git'),
      );
      assert.equal(fs.existsSync(paths.root), false);
    } finally {
      fixture.dispose();
    }
  }
});

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

test('generic revoke is human, audited, terminal, and idempotent without dispatch', () => {
  for (const reserve of [false, true]) {
    const fixture = prepareFixture();
    try {
      issueExternalEffectGrant(
        fixture.repository,
        publishGrantRequest(fixture),
        {
          onAuditRecord: fixture.audit,
          grantId: GRANT_ID,
          now: ISSUED_AT,
          signer: fixture.signer,
        },
      );
      if (reserve) {
        const reserved = reserveExternalEffectGrant(
          fixture.repository,
          GRANT_ID,
          {
            onAuditRecord: fixture.audit,
            now: new Date('2026-08-04T01:00:10.000Z'),
            signer: fixture.signer,
          },
        );
        assert.notEqual(reserved.transactionToken, null);
        assert.equal(
          inspectExternalEffectGrant(fixture.repository, GRANT_ID, {
            signer: fixture.signer,
          }).transactionToken,
          null,
        );
      }
      const revoked = revokeExternalEffectGrant(fixture.repository, GRANT_ID, {
        onAuditRecord: fixture.audit,
        now: new Date('2026-08-04T01:00:20.000Z'),
        reason: 'Maintainer cancelled this publish.',
        signer: fixture.signer,
      });
      const replay = revokeExternalEffectGrant(fixture.repository, GRANT_ID, {
        onAuditRecord: fixture.audit,
        now: new Date('2026-08-04T01:00:30.000Z'),
        reason: 'Maintainer cancelled this publish.',
        signer: fixture.signer,
      });
      assert.equal(revoked.state, 'revoked');
      assert.deepEqual(replay, revoked);
      assert.equal(
        fixture.events.filter(({ eventType }) => eventType === 'grant-revoked')
          .length,
        1,
      );
      assert.equal(
        inspectExternalEffectGrant(fixture.repository, GRANT_ID, {
          signer: fixture.signer,
        }).state,
        'revoked',
      );
    } finally {
      fixture.dispose();
    }
  }
});
