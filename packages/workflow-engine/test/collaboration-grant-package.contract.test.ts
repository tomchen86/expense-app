import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  COLLABORATION_GRANT_AUTHORIZED_EFFECT,
  COLLABORATION_GRANT_POLICY_DIGEST,
  COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE,
  COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  canonicalCollaborationGrantPayload,
  verifyCollaborationGrantCapability,
  type CollaborationGrantEnvelope,
  type CollaborationGrantPayload,
} from '../src/modules/authority/collaboration-grant.ts';
import type { MaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';

const NOW = new Date('2026-08-20T00:01:00.000Z');
const SIGNATURE = [
  '-----BEGIN SSH SIGNATURE-----',
  'fixture',
  '-----END SSH SIGNATURE-----',
  '',
].join('\n');

const POLICY: MaintainerPolicy = {
  schemaVersion: 1,
  repository: {
    id: 'github:R_grants_package_fixture',
    origin: 'https://github.com/example/grants-package-fixture.git',
  },
  phase: 'bootstrap',
  auditTagPrefix: 'refs/tags/workflow-grant/',
  signatureNamespace: 'expense-app.workflow.maintainer-grant.v1',
  maxTtlMinutes: 30,
  maxUses: 1,
  bootstrapEligiblePaths: ['packages/workflow-engine/src/**'],
  sealedImmutablePaths: ['workflow/maintainer-policy.json'],
  requiredChecks: ['fixture'],
  trustedSigners: [
    {
      identity: 'fixture-maintainer',
      publicKey: 'fixture-public-key',
      fingerprint: 'SHA256:fixture',
    },
  ],
};

test('the production collaboration validator emits typed capabilities for historical V1 and current V2 namespaces', () => {
  const namespaces: string[] = [];
  const verifier = {
    verify(
      payload: string,
      signature: string,
      identity: string,
      namespace: string,
    ) {
      assert.equal(signature, SIGNATURE);
      assert.equal(identity, 'fixture-maintainer');
      assert.equal(payload.endsWith('\n'), true);
      namespaces.push(namespace);
    },
  };

  for (const version of [1, 2] as const) {
    const envelope = collaborationEnvelope(version);
    const capability = verifyCollaborationGrantCapability(envelope, POLICY, {
      now: NOW,
      expected: {
        repositoryId: envelope.payload.repositoryId,
        repositoryOrigin: envelope.payload.repositoryOrigin,
        policyBlob: envelope.payload.policyBlob,
        collaborationPolicyDigest: envelope.payload.collaborationPolicyDigest,
        changeId: envelope.payload.changeId,
        taskId: envelope.payload.taskId,
        baselineCommit: envelope.payload.baselineCommit,
        baselineTree: envelope.payload.baselineTree,
        targetDigest: envelope.payload.targetDigest,
        lifecyclePhase: envelope.payload.lifecyclePhase,
        rolePair: envelope.payload.rolePair,
        availableActor: envelope.payload.availableActor,
        degradedForm: envelope.payload.degradedForm,
        reason: envelope.payload.reason,
      },
      verifier,
    });
    const expectedNamespace =
      version === 1
        ? COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE
        : COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE;
    assert.equal(capability.envelope.payload.version, version);
    assert.equal(
      capability.verification.receipt.signatureNamespace,
      expectedNamespace,
    );
    assert.equal(
      capability.verification.receipt.authorizedEffect,
      COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    );
    assert.equal(
      capability.verification.receipt.signedPayloadDigest,
      sha256(canonicalCollaborationGrantPayload(envelope.payload)),
    );
    assert.equal(Object.isFrozen(capability), true);
  }

  assert.deepEqual(namespaces, [
    COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE,
    COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  ]);
});

function collaborationEnvelope(version: 1 | 2): CollaborationGrantEnvelope {
  const common = {
    grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    repositoryId: POLICY.repository.id,
    repositoryOrigin: POLICY.repository.origin,
    policyBlob: 'a'.repeat(40),
    collaborationPolicyDigest: COLLABORATION_GRANT_POLICY_DIGEST,
    changeId: 'package-grant-fixture',
    taskId: null,
    baselineCommit: 'b'.repeat(40),
    baselineTree: 'c'.repeat(40),
    targetDigest: 'd'.repeat(64),
    lifecyclePhase: 'plan-review' as const,
    rolePair: {
      authorRole: 'plan-author' as const,
      conflictingRole: 'plan-reviewer' as const,
    },
    availableActor: {
      kind: 'provider' as const,
      providerId: 'codex' as const,
      assurance: 'runtime-hint' as const,
    },
    degradedForm: 'same-provider-fresh-session' as const,
    authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    reason: 'Use an exact fresh provider session.',
    issuedAt: '2026-08-20T00:00:00.000Z',
    expiresAt: '2026-08-20T00:30:00.000Z',
    maxUses: 1 as const,
    signer: 'fixture-maintainer',
  };
  const payload: CollaborationGrantPayload =
    version === 1
      ? { version: 1, ...common }
      : {
          version: 2,
          signatureNamespace: COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
          ...common,
        };
  return { payload, signature: SIGNATURE };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
