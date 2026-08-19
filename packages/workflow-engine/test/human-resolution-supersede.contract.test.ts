import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { loadAiAdapterPolicy } from '../src/ai-adapter-policy.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { discoverRepository } from '../src/git.ts';
import {
  executeHumanResolutionGrant,
  inspectHumanResolutionGrants,
  revokeHumanResolutionGrant,
  startInvestigationSession,
} from '../src/investigation-session.ts';
import {
  assertHumanResolutionDecision,
  inspectInvestigationResolutionState,
  type HumanResolutionDecision,
} from '../src/investigation-session-store.ts';
import {
  canonicalHumanResolutionGrantEnvelope,
  issueHumanResolutionGrant,
  verifyHumanResolutionGrantEnvelope,
  verifyLegacyHumanResolutionGrantEnvelopeReadOnly,
  type HumanResolutionGrantEnvelope,
} from '../src/modules/authority/maintainer-grant.ts';
import type { MaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import type { MaintainerSignerProvider } from '../src/maintainer-signer.ts';
import { investigationRuntimePaths } from '../src/paths.ts';
import { createProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  blindSurveyIntentDigest,
  blindSurveyManifestDigest,
  type BlindSurveyManifest,
} from '../src/provider-invocation-store.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';
import { issueLegacyHumanResolutionGrantFixture } from './legacy-human-resolution-grant-fixture.ts';

const EXECUTION_FAILURE_REASONS = [
  'provider-timeout',
  'provider-process-failure',
  'schema-invalid',
  'rate-limit',
  'network-error',
  'worker-crash',
  'retry-policy-change',
  'validator-repair',
  'execution-limit-change',
  'provider-adapter-upgrade',
  'environment-drift',
] as const;

test('supersede admission requires a canonical semantic or product reason', () => {
  assert.deepEqual(
    assertHumanResolutionDecision(supersedeDecision('workflow-replaced')),
    supersedeDecision('workflow-replaced'),
  );

  for (const reason of EXECUTION_FAILURE_REASONS) {
    assert.throws(
      () => assertHumanResolutionDecision(supersedeDecision(reason)),
      (error) =>
        isWorkflowError(error, 'SUPERSEDE_EXECUTION_FAILURE_FORBIDDEN'),
      reason,
    );
  }
  assert.throws(
    () =>
      assertHumanResolutionDecision({
        kind: 'supersede',
        parameters: { successorInvestigationId: null },
      }),
    (error) => isWorkflowError(error, 'HUMAN_RESOLUTION_INVALID'),
  );
});

test('production legacy human-resolution issuance is historical read-only', () => {
  let signerTouched = false;
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {
      signerTouched = true;
    },
    identity() {
      signerTouched = true;
      return 'fixture-maintainer';
    },
    sign() {
      signerTouched = true;
      return 'unreachable';
    },
    verify() {
      signerTouched = true;
    },
  };

  assert.throws(
    () =>
      issueHumanResolutionGrant(
        '/path/that/must/not/be-read',
        {
          investigationId: 'investigation-read-only-fixture',
          decision: { kind: 'abort', parameters: {} },
          consequences: {
            continuity: 'broken',
            assurance: 'degraded',
            claimsWaived: [],
          },
          rationale: 'Legacy issuance must remain disabled.',
        },
        { signer },
      ),
    (error) => isWorkflowError(error, 'LEGACY_GRANT_V1_NEW_SIGNING_DISABLED'),
  );
  assert.equal(signerTouched, false);
});

test('legacy human-resolution evidence verifies read-only but cannot start a live transition', () => {
  const repository = createFixtureRepository();
  try {
    installMaintainerPolicy(repository);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const started = startSupersedeFixture(repository);
    const signer = fixtureSigner();
    const now = new Date('2026-08-03T12:00:00.000Z');
    const issued = issueLegacyHumanResolutionGrantFixture(
      repository,
      supersedeRequest(started.investigationId, 'workflow-replaced'),
      {
        now,
        grantId: 'e4111111-1111-4111-8111-111111111111',
        signer,
      },
    );
    assert.doesNotThrow(() =>
      verifyHumanResolutionGrantEnvelope(
        repository,
        issued.envelope,
        {} as MaintainerPolicy,
        signer,
      ),
    );
    assert.throws(
      () => executeHumanResolutionGrant(repository, issued.grantId),
      (error) =>
        isWorkflowError(error, 'LEGACY_GRANT_V1_LIVE_TRANSITION_DISABLED'),
    );
    assert.equal(
      inspectInvestigationResolutionState(
        runtimePaths(repository),
        started.investigationId,
        'github:R_fixture',
      ).effectiveState,
      started.state,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('legacy signed supersede without a reason is verification-only', () => {
  const signer = fixtureSigner();
  const current = grantEnvelope(supersedeDecision('workflow-replaced'));
  const legacy = structuredClone(current);
  (legacy.payload as unknown as { decision: unknown }).decision = {
    kind: 'supersede',
    parameters: { successorInvestigationId: null },
  };

  assert.throws(
    () =>
      verifyHumanResolutionGrantEnvelope(
        '/fixture',
        legacy,
        {} as MaintainerPolicy,
        signer,
      ),
    (error) => isWorkflowError(error, 'HUMAN_RESOLUTION_INVALID'),
  );
  assert.deepEqual(
    verifyLegacyHumanResolutionGrantEnvelopeReadOnly(
      '/fixture',
      legacy,
      {} as MaintainerPolicy,
      signer,
    ),
    {
      grantId: legacy.payload.grantId,
      mode: 'historical-read-only',
      signatureValid: true,
    },
  );
  assert.equal(
    signer.verifiedNamespaces.at(-1),
    'expense-app.workflow.human-resolution-grant.v1',
  );
});

test('human-resolution revocation requires current human presence and preserves an exact signed tombstone', () => {
  const repository = createFixtureRepository();
  try {
    installMaintainerPolicy(repository);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const started = startSupersedeFixture(repository);
    const signer = fixtureSigner();
    const issued = issueLegacyHumanResolutionGrantFixture(
      repository,
      supersedeRequest(started.investigationId, 'workflow-replaced'),
      {
        now: new Date('2026-08-03T12:00:00.000Z'),
        grantId: 'e6111111-1111-4111-8111-111111111111',
        signer,
      },
    );
    const unattended = fixtureSigner();
    unattended.assertHumanPresent = () => {
      throw new Error('no controlling terminal');
    };
    assert.throws(() =>
      revokeHumanResolutionGrant(repository, issued.grantId, {
        reason: 'Retire the unused root-human decision',
        now: new Date('2026-08-03T12:01:00.000Z'),
        signer: unattended,
        verifier: signer,
      }),
    );
    assert.equal(
      inspectHumanResolutionGrants(repository, issued.grantId)[0]?.state,
      'available',
    );

    const revoked = revokeHumanResolutionGrant(repository, issued.grantId, {
      reason: 'Retire the unused root-human decision',
      now: new Date('2026-08-03T12:02:00.000Z'),
      signer,
      verifier: signer,
    });
    assert.equal(revoked.state, 'revoked');
    assert.deepEqual(
      revokeHumanResolutionGrant(repository, issued.grantId, {
        reason: 'Retire the unused root-human decision',
        now: new Date('2026-08-03T12:03:00.000Z'),
        signer,
        verifier: signer,
      }),
      revoked,
    );
    assert.throws(
      () =>
        revokeHumanResolutionGrant(repository, issued.grantId, {
          reason: 'A different reason must not overwrite the tombstone',
          signer,
          verifier: signer,
        }),
      (error) => isWorkflowError(error, 'HUMAN_REVOCATION_CONFLICT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function supersedeDecision(reason: string): HumanResolutionDecision {
  return {
    kind: 'supersede',
    parameters: {
      successorInvestigationId: null,
      reason,
    },
  } as unknown as HumanResolutionDecision;
}

function supersedeRequest(investigationId: string, reason: string) {
  return {
    investigationId,
    decision: supersedeDecision(reason),
    consequences: {
      continuity: 'broken' as const,
      assurance: 'degraded' as const,
      claimsWaived: [],
    },
    rationale: 'Replace the workflow because the original goal has no value.',
  };
}

function installMaintainerPolicy(repository: string): void {
  const origin = 'https://github.com/example/fixture.git';
  git(repository, ['remote', 'add', 'origin', origin]);
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${canonicalJson({
      schemaVersion: 1,
      repository: { id: 'github:R_fixture', origin },
      phase: 'bootstrap',
      auditTagPrefix: 'refs/tags/workflow-grant/',
      signatureNamespace: 'expense-app.workflow.maintainer-grant.v1',
      maxTtlMinutes: 30,
      maxUses: 1,
      bootstrapEligiblePaths: ['packages/workflow-engine/src/**'],
      sealedImmutablePaths: [],
      requiredChecks: ['fixture'],
      trustedSigners: [
        {
          identity: 'fixture-maintainer',
          publicKey:
            'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
          fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
        },
      ],
    })}\n`,
  );
  git(repository, ['add', '--', 'workflow/maintainer-policy.json']);
  git(repository, ['commit', '-m', 'Add maintainer policy']);
}

function startSupersedeFixture(repository: string) {
  const state = discoverRepository(repository);
  const providerPolicy = loadAiAdapterPolicy(repository);
  const normalizedIntent = {
    schemaVersion: 1 as const,
    summary: 'Exercise supersede reason enforcement.',
    explicitPaths: [] as string[],
    explicitSymbols: ['HumanResolutionDecision'],
    explicitConfigKeys: [] as string[],
    renamePairs: [] as Array<{ from: string; to: string }>,
  };
  const manifest: BlindSurveyManifest = {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId: 'demo-change',
    repositoryId: 'fixture',
    baseCommit: state.head,
    baseTree: state.tree,
    normalizedIntent,
    architectureQuestion: 'Which workflow should replace this one?',
    capabilityProfile: 'repository-read-only',
  };
  const intentDigest = blindSurveyIntentDigest(manifest);
  const invocationId = 'invocation-supersede-reason-survey';
  const request = createProviderInvocationRequest({
    invocationId,
    nonce: 'supersede-reason-survey-nonce-0000',
    purpose: 'survey',
    providerId: 'claude',
    roleAssignment: {
      role: 'blind-surveyor',
      providerId: 'claude',
      sessionId: 'provider-session-supersede-reason',
      targetDigest: intentDigest,
      requiredIndependence: 'provider-independent',
      achievedIndependence: 'provider-independent',
    },
    capabilityProfile: 'repository-read-only',
    repositoryId: manifest.repositoryId,
    baseCommit: manifest.baseCommit,
    baseTree: manifest.baseTree,
    targetDigest: intentDigest,
    inputManifestDigest: blindSurveyManifestDigest(manifest),
    authorizationNodeId: '1'.repeat(64),
    writeAllowedPaths: [],
    outputSchema: BLIND_SURVEY_OUTPUT_SCHEMA,
    evaluatorVersion: 'supersede-reason-evaluator.v1',
    policyDigest: providerPolicy.digest,
    limits: {
      timeoutMs: providerPolicy.policy.limits.timeoutMs,
      aggregateOutputBytes: providerPolicy.policy.limits.aggregateOutputBytes,
    },
  });
  return startInvestigationSession(repository, {
    changeId: 'demo-change',
    blindManifest: manifest,
    blindRequest: request,
  });
}

function runtimePaths(repository: string) {
  const state = discoverRepository(repository);
  return investigationRuntimePaths(state.gitCommonDirectory, 'workflow-engine');
}

function fixtureSigner(): MaintainerSignerProvider & {
  signedPayloads: string[];
  verifiedNamespaces: string[];
} {
  const signedPayloads: string[] = [];
  const verifiedNamespaces: string[] = [];
  return {
    signedPayloads,
    verifiedNamespaces,
    assertHumanPresent() {},
    identity: () => 'fixture-maintainer',
    sign(payload) {
      signedPayloads.push(payload);
      return [
        '-----BEGIN SSH SIGNATURE-----',
        'AAAA',
        '-----END SSH SIGNATURE-----',
        '',
      ].join('\n');
    },
    verify(_payload, _signature, _identity, namespace) {
      assert.ok(namespace);
      verifiedNamespaces.push(namespace);
    },
  };
}

function grantEnvelope(decision: HumanResolutionDecision) {
  return {
    payload: {
      version: 1 as const,
      grantId: 'e5111111-1111-4111-8111-111111111111',
      repositoryId: 'github:R_fixture',
      repositoryOrigin: 'https://github.com/example/fixture.git',
      trustBaseCommit: '1'.repeat(40),
      policyBlob: '2'.repeat(40),
      target: {
        workflowKind: 'investigation' as const,
        changeId: 'demo-change',
        workflowId: '11111111-1111-4111-8111-111111111111',
      },
      expected: {
        reasonCode: 'HUMAN_ROOT_DECISION_REQUESTED',
        blockedTransition: 'workflow-state',
        stateDigest: '3'.repeat(64),
        currentRefDigest: '4'.repeat(64),
      },
      decision,
      consequences: {
        continuity: 'broken' as const,
        assurance: 'degraded' as const,
        claimsWaived: [],
      },
      rationale: 'Historical signed supersede fixture.',
      issuedAt: '2026-08-03T12:00:00.000Z',
      expiresAt: '2026-08-03T12:30:00.000Z',
      maxUses: 1 as const,
      signer: 'fixture-maintainer',
    },
    signature: [
      '-----BEGIN SSH SIGNATURE-----',
      'AAAA',
      '-----END SSH SIGNATURE-----',
      '',
    ].join('\n'),
  } satisfies HumanResolutionGrantEnvelope;
}
