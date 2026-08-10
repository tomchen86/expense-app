import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import { WorkflowError } from '../src/errors.ts';
import {
  CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V2,
  CONTROL_PLANE_SIGNATURE_NAMESPACE_V2,
  canonicalControlPlaneGrantPayloadV2,
  canonicalControlPlaneIndependentReviewAttestationPayloadV2,
  classifyProtectedCandidateImpactV2,
  controlPlaneCandidateDigestV2,
  controlPlaneIndependentReviewAttestationDigest,
  controlPlaneIndependentReviewAttestationDigestV2,
  controlPlanePromotionMaterialDigest,
  createControlPlanePromotionBundleV2,
  createControlPlanePromotionMaterial,
  createControlPlaneRecoveryBundleMaterial,
  createEngineArtifact,
  createProtectedCapabilityManifest,
  protectedCapabilityClosureDigest,
  REQUIRED_PROTECTED_CAPABILITIES,
  verifyControlPlaneGrantV2,
  verifyControlPlaneIndependentReviewAttestationV2,
  type ControlPlaneGrantEnvelopeV2,
  type ControlPlaneIndependentReviewAttestationEnvelope,
  type ControlPlaneIndependentReviewAttestationEnvelopeV2,
  type ControlPlanePromotionBundleV2,
  type ControlPlanePromotionMaterial,
  type ProtectedCapabilityEntry,
} from '../src/intervention-control.ts';

const REVIEWED_AT = '2026-08-10T09:50:00.000Z';
const ISSUED_AT = '2026-08-10T09:55:00.000Z';
const NOW = new Date('2026-08-10T09:59:00.000Z');

function digest(value: string | Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function protectedEntries(
  controlPlaneContentDigest = digest('control-plane-before'),
): ProtectedCapabilityEntry[] {
  return REQUIRED_PROTECTED_CAPABILITIES.map((capability) => {
    const entrypoints =
      capability === 'control-plane.update'
        ? [
            'packages/workflow-engine/engine-a.mjs',
            'packages/workflow-engine/engine-b.mjs',
          ]
        : [`packages/workflow-engine/${capability}.ts`];
    const dependencies = [`packages/workflow-engine/shared-${capability}.ts`];
    const contentDigest =
      capability === 'control-plane.update'
        ? controlPlaneContentDigest
        : digest(`content:${capability}`);
    return {
      capability,
      entrypoints,
      dependencies,
      contentDigest,
      closureDigest: protectedCapabilityClosureDigest(
        entrypoints,
        dependencies,
        contentDigest,
      ),
    };
  });
}

function fixture() {
  const repositoryId = 'github:example/expense-app';
  const mandateBinding = {
    schemaVersion: 1 as const,
    parentTaskId: 'control-plane-task',
    mandateId: '22222222-2222-4222-8222-222222222222',
    mandateDigest: '2'.repeat(64),
    changeId: 'control-plane-change',
    externalAuditRoot: '/tmp/control-plane-external-audit',
  };
  const beforeManifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries: protectedEntries(),
  });
  const afterManifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: beforeManifest.manifestPath,
    entries: protectedEntries(digest('control-plane-after')),
  });
  const manifestBytes = (manifest: typeof beforeManifest) =>
    Buffer.from(
      `${JSON.stringify(
        Object.fromEntries(
          Object.entries(manifest).filter(([key]) => key !== 'manifestDigest'),
        ),
        null,
        2,
      )}\n`,
    );
  const engineABefore = Buffer.from(
    "#!/usr/bin/env node\nprocess.stdout.write('old-a\\n');\n",
  );
  const engineAAfter = Buffer.from(
    "#!/usr/bin/env node\nprocess.stdout.write('new-a\\n');\n",
  );
  const engineBBefore = Buffer.from(
    "#!/usr/bin/env node\nprocess.stdout.write('old-b\\n');\n",
  );
  const engineBAfter = Buffer.from(
    "#!/usr/bin/env node\nprocess.stdout.write('new-b\\n');\n",
  );
  const beforeManifestBytes = manifestBytes(beforeManifest);
  const afterManifestBytes = manifestBytes(afterManifest);
  const exactChanges = [
    {
      path: 'packages/workflow-engine/engine-a.mjs',
      beforeDigest: digest(engineABefore),
      afterDigest: digest(engineAAfter),
      beforeMode: '100755' as const,
      afterMode: '100755' as const,
    },
    {
      path: 'packages/workflow-engine/engine-b.mjs',
      beforeDigest: digest(engineBBefore),
      afterDigest: digest(engineBAfter),
      beforeMode: '100755' as const,
      afterMode: '100755' as const,
    },
    {
      path: beforeManifest.manifestPath,
      beforeDigest: digest(beforeManifestBytes),
      afterDigest: digest(afterManifestBytes),
      beforeMode: '100644' as const,
      afterMode: '100644' as const,
    },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const oldArtifact = createEngineArtifact({
    sourceChangeId: 'repository-default-built-in',
    sourceDigest: digest('old-source'),
    executableDigest: digest(engineABefore),
    protocolVersion: 3,
    canReadSessionSchemas: ['v4'],
    writesSessionSchema: 'v4',
    policySchemaVersion: 2,
    smokeReportDigest: digest('old-smoke'),
  });
  const candidateArtifact = createEngineArtifact({
    sourceChangeId: mandateBinding.changeId,
    sourceDigest: digest('candidate-source-a'),
    executableDigest: digest(engineAAfter),
    protocolVersion: 3,
    canReadSessionSchemas: ['v4'],
    writesSessionSchema: 'v4',
    policySchemaVersion: 2,
    smokeReportDigest: digest('candidate-smoke-a'),
  });
  const previousFiles = [
    {
      path: 'packages/workflow-engine/engine-a.mjs',
      mode: '100755' as const,
      contentBase64: engineABefore.toString('base64'),
      contentDigest: digest(engineABefore),
    },
    {
      path: 'packages/workflow-engine/engine-b.mjs',
      mode: '100755' as const,
      contentBase64: engineBBefore.toString('base64'),
      contentDigest: digest(engineBBefore),
    },
    {
      path: beforeManifest.manifestPath,
      mode: '100644' as const,
      contentBase64: beforeManifestBytes.toString('base64'),
      contentDigest: digest(beforeManifestBytes),
    },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const candidateFiles = [
    {
      path: 'packages/workflow-engine/engine-a.mjs',
      mode: '100755' as const,
      contentBase64: engineAAfter.toString('base64'),
      contentDigest: digest(engineAAfter),
    },
    {
      path: 'packages/workflow-engine/engine-b.mjs',
      mode: '100755' as const,
      contentBase64: engineBAfter.toString('base64'),
      contentDigest: digest(engineBAfter),
    },
    {
      path: afterManifest.manifestPath,
      mode: '100644' as const,
      contentBase64: afterManifestBytes.toString('base64'),
      contentDigest: digest(afterManifestBytes),
    },
  ].sort((left, right) => left.path.localeCompare(right.path));
  const rollbackReport = Buffer.from(
    `${canonicalJson({ kind: 'control-plane-rollback-test.v1', outcome: 'passed' })}\n`,
  );
  const recoveryBundle = createControlPlaneRecoveryBundleMaterial({
    repositoryId,
    previousClosureDigest: beforeManifest.manifestDigest,
    restartArtifact: oldArtifact,
    restartExecutableBase64: engineABefore.toString('base64'),
    restartExecutableProvenanceDigest: digest(
      'generation-1-supervisor-provenance',
    ),
    previousFiles,
    rollbackTestReportBase64: rollbackReport.toString('base64'),
    rollbackTestReportDigest: digest(rollbackReport),
  });
  const material = createControlPlanePromotionMaterial({
    mandateBinding,
    repositoryId,
    frozenCandidateBundleDigest: digest('frozen-class-c-candidate'),
    candidateDigest: controlPlaneCandidateDigestV2(exactChanges),
    beforeClosureDigest: beforeManifest.manifestDigest,
    afterClosureDigest: afterManifest.manifestDigest,
    affectedCapabilities: ['control-plane.update'],
    behaviorChangeSummary:
      'Select the reviewed engine A artifact as the repository default.',
    exactChanges,
    candidateArtifact,
    candidateExecutableBase64: engineAAfter.toString('base64'),
    candidateExecutableProvenanceDigest: digest(
      'intervention-artifact-record-a',
    ),
    candidateFiles,
    recoveryBundle,
  });
  return {
    repositoryId,
    mandateBinding,
    beforeManifest,
    afterManifest,
    exactChanges,
    engineAAfter,
    engineBAfter,
    candidateFiles,
    recoveryBundle,
    material,
  };
}

function signedReview(
  material: ControlPlanePromotionMaterial,
): ControlPlaneIndependentReviewAttestationEnvelopeV2 {
  const payload = {
    kind: 'control-plane-independent-review.v2' as const,
    repositoryId: material.repositoryId,
    frozenCandidateBundleDigest: material.frozenCandidateBundleDigest,
    candidateDigest: material.candidateDigest,
    promotionMaterialDigest: controlPlanePromotionMaterialDigest(material),
    beforeClosureDigest: material.beforeClosureDigest,
    afterClosureDigest: material.afterClosureDigest,
    recoveryBundleDigest: material.recoveryBundle.bundleDigest,
    affectedCapabilities: [...material.affectedCapabilities],
    verdict: 'approved' as const,
    reviewedAt: REVIEWED_AT,
    reviewSummary:
      'Reviewed the exact artifact, executable selection, file modes, and rollback material.',
    reviewer: 'independent-reviewer@example.test',
  };
  assert.match(
    canonicalControlPlaneIndependentReviewAttestationPayloadV2(payload),
    /promotionMaterialDigest/,
  );
  return { payload, signature: 'review-v2-signature' };
}

function promotionBundle(
  material: ControlPlanePromotionMaterial,
): ControlPlanePromotionBundleV2 {
  return createControlPlanePromotionBundleV2({
    material,
    independentReviewAttestation: signedReview(material),
  });
}

function signedGrant(
  bundle: ControlPlanePromotionBundleV2,
): ControlPlaneGrantEnvelopeV2 {
  const material = bundle.material;
  const payload = {
    kind: 'control-plane-grant.v2' as const,
    grantId: 'control-plane-v2-material-bound-grant',
    mandateBinding: material.mandateBinding,
    repositoryId: material.repositoryId,
    frozenCandidateBundleDigest: material.frozenCandidateBundleDigest,
    candidateDigest: material.candidateDigest,
    promotionMaterialDigest: bundle.promotionMaterialDigest,
    promotionBundleDigest: bundle.bundleDigest,
    exactChanges: material.exactChanges,
    beforeClosureDigest: material.beforeClosureDigest,
    afterClosureDigest: material.afterClosureDigest,
    affectedCapabilities: material.affectedCapabilities,
    behaviorChangeSummary: material.behaviorChangeSummary,
    recoveryBundle: {
      bundleDigest: material.recoveryBundle.bundleDigest,
      previousClosureDigest: material.recoveryBundle.previousClosureDigest,
      restartArtifactDigest:
        material.recoveryBundle.restartArtifact.executableDigest,
      rollbackTestReportDigest:
        material.recoveryBundle.rollbackTestReportDigest,
    },
    independentReviewAttestationDigest:
      controlPlaneIndependentReviewAttestationDigestV2(
        bundle.independentReviewAttestation,
      ),
    updaterVersion: 2 as const,
    oneShot: true as const,
    issuedAt: ISSUED_AT,
    expiresAt: '2026-08-10T10:00:00.000Z',
    humanSigner: 'grant-signer@example.test',
  };
  assert.match(canonicalControlPlaneGrantPayloadV2(payload), /bundleDigest/);
  return { payload, signature: 'grant-v2-signature' };
}

function verifier(
  _payload: string,
  signature: string,
  signer: string,
  namespace: string,
): boolean {
  return (
    (signature === 'review-v2-signature' &&
      signer === 'independent-reviewer@example.test' &&
      namespace === CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V2) ||
    (signature === 'grant-v2-signature' &&
      signer === 'grant-signer@example.test' &&
      namespace === CONTROL_PLANE_SIGNATURE_NAMESPACE_V2)
  );
}

function code(error: unknown, expected: string): boolean {
  return error instanceof WorkflowError && error.code === expected;
}

test('v2 review and grant bind exact promotion material without a signature cycle', () => {
  const value = fixture();
  const bundle = promotionBundle(value.material);
  const grant = signedGrant(bundle);

  const reviewed = verifyControlPlaneIndependentReviewAttestationV2(
    bundle.independentReviewAttestation,
    {
      material: bundle.material,
      expectedDigest: grant.payload.independentReviewAttestationDigest,
      grantHumanSigner: grant.payload.humanSigner,
      grantIssuedAt: grant.payload.issuedAt,
      verifyHumanSignature: verifier,
    },
  );
  assert.equal(
    reviewed.payload.promotionMaterialDigest,
    bundle.promotionMaterialDigest,
  );

  const verified = verifyControlPlaneGrantV2(grant, {
    now: NOW,
    beforeManifest: value.beforeManifest,
    afterManifest: value.afterManifest,
    bundle,
    consumedGrantIds: new Set(),
    verifyHumanSignature: verifier,
  });
  assert.equal(verified.payload.promotionBundleDigest, bundle.bundleDigest);

  const legacyReview: ControlPlaneIndependentReviewAttestationEnvelope = {
    payload: {
      kind: 'control-plane-independent-review.v1',
      repositoryId: value.repositoryId,
      candidateDigest: value.material.candidateDigest,
      beforeClosureDigest: value.beforeManifest.manifestDigest,
      afterClosureDigest: value.afterManifest.manifestDigest,
      recoveryBundleDigest: value.recoveryBundle.bundleDigest,
      affectedCapabilities: ['control-plane.update'],
      verdict: 'approved',
      reviewedAt: REVIEWED_AT,
      reviewSummary: 'Historical v1 review remains parseable for audit.',
      reviewer: 'legacy-reviewer@example.test',
    },
    signature: 'legacy-review-signature',
  };
  assert.match(
    controlPlaneIndependentReviewAttestationDigest(legacyReview),
    /^sha256:[0-9a-f]{64}$/,
  );
});

test('v2 review cannot be replayed after executable, artifact metadata, or mode substitution', () => {
  const value = fixture();
  const originalReview = signedReview(value.material);
  const alternateArtifact = createEngineArtifact({
    ...value.material.candidateArtifact,
    sourceDigest: digest('candidate-source-b'),
    executableDigest: digest(value.engineBAfter),
    smokeReportDigest: digest('candidate-smoke-b'),
  });
  const substituted = createControlPlanePromotionMaterial({
    ...value.material,
    candidateArtifact: alternateArtifact,
    candidateExecutableBase64: value.engineBAfter.toString('base64'),
    candidateExecutableProvenanceDigest: digest(
      'intervention-artifact-record-b',
    ),
  });

  assert.notEqual(
    controlPlanePromotionMaterialDigest(substituted),
    controlPlanePromotionMaterialDigest(value.material),
  );
  assert.throws(
    () =>
      createControlPlanePromotionBundleV2({
        material: substituted,
        independentReviewAttestation: originalReview,
      }),
    (error: unknown) => code(error, 'CONTROL_PLANE_REVIEW_MATERIAL_MISMATCH'),
  );

  const metadataOnly = createControlPlanePromotionMaterial({
    ...value.material,
    candidateArtifact: createEngineArtifact({
      ...value.material.candidateArtifact,
      protocolVersion: value.material.candidateArtifact.protocolVersion + 1,
    }),
  });
  assert.throws(
    () =>
      createControlPlanePromotionBundleV2({
        material: metadataOnly,
        independentReviewAttestation: originalReview,
      }),
    (error: unknown) => code(error, 'CONTROL_PLANE_REVIEW_MATERIAL_MISMATCH'),
  );

  const modeTamper = structuredClone(value.material);
  const manifestFile = modeTamper.candidateFiles.find(
    ({ path }) => path === value.beforeManifest.manifestPath,
  )!;
  manifestFile.mode = '100755';
  assert.throws(
    () => createControlPlanePromotionMaterial(modeTamper),
    (error: unknown) => code(error, 'CONTROL_PLANE_PROMOTION_MATERIAL_INVALID'),
  );
});

test('v2 grant cannot be replayed across separately reviewed promotion bundles', () => {
  const value = fixture();
  const originalBundle = promotionBundle(value.material);
  const originalGrant = signedGrant(originalBundle);
  const alternateArtifact = createEngineArtifact({
    ...value.material.candidateArtifact,
    sourceDigest: digest('separately-reviewed-source-b'),
    executableDigest: digest(value.engineBAfter),
    smokeReportDigest: digest('separately-reviewed-smoke-b'),
  });
  const alternateMaterial = createControlPlanePromotionMaterial({
    ...value.material,
    behaviorChangeSummary:
      'Select the separately reviewed engine B artifact as repository default.',
    candidateArtifact: alternateArtifact,
    candidateExecutableBase64: value.engineBAfter.toString('base64'),
    candidateExecutableProvenanceDigest: digest(
      'separately-reviewed-intervention-artifact-record-b',
    ),
  });
  const alternateBundle = promotionBundle(alternateMaterial);

  assert.throws(
    () =>
      verifyControlPlaneGrantV2(originalGrant, {
        now: NOW,
        beforeManifest: value.beforeManifest,
        afterManifest: value.afterManifest,
        bundle: alternateBundle,
        consumedGrantIds: new Set(),
        verifyHumanSignature: verifier,
      }),
    (error: unknown) => code(error, 'CONTROL_PLANE_PROMOTION_BUNDLE_MISMATCH'),
  );
});

test('v2 impact classification treats a protected mode-only change as Class C', () => {
  const value = fixture();
  const protectedPath = 'packages/workflow-engine/engine-b.mjs';
  const fileDigest = digest(value.engineBAfter);
  const impact = classifyProtectedCandidateImpactV2({
    beforeManifest: value.afterManifest,
    afterManifest: value.afterManifest,
    changes: [
      {
        path: protectedPath,
        beforeDigest: fileDigest,
        afterDigest: fileDigest,
        beforeMode: '100644',
        afterMode: '100755',
      },
    ],
  });

  assert.equal(impact.class, 'C');
  assert.deepEqual(impact.affectedCapabilities, ['control-plane.update']);
});

test('v2 grant rejects future issuance and an authority window over five minutes', () => {
  const value = fixture();
  const bundle = promotionBundle(value.material);
  const grant = signedGrant(bundle);
  const context = {
    beforeManifest: value.beforeManifest,
    afterManifest: value.afterManifest,
    bundle,
    consumedGrantIds: new Set<string>(),
    verifyHumanSignature: verifier,
  };

  assert.throws(
    () =>
      verifyControlPlaneGrantV2(grant, {
        ...context,
        now: new Date('2026-08-10T09:54:59.999Z'),
      }),
    (error: unknown) => code(error, 'CONTROL_PLANE_GRANT_NOT_YET_VALID'),
  );

  const overlong = structuredClone(grant);
  overlong.payload.expiresAt = '2026-08-10T10:00:00.001Z';
  assert.throws(
    () => verifyControlPlaneGrantV2(overlong, { ...context, now: NOW }),
    (error: unknown) => code(error, 'CONTROL_PLANE_GRANT_INVALID'),
  );
});
