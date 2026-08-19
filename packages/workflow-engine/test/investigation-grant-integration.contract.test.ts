import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { loadAiAdapterPolicy } from '../src/runtime/provider-execution/ai-adapter-policy.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import type { VerifiedApprovalProof } from '../src/modules/authority/grant-approval.ts';
import {
  createGrantCoordinatorKernel,
  type GrantApprovalSession,
  type TrustedGrantPresentation,
} from '../src/modules/authority/grant-coordinator.ts';
import {
  createInvestigationGrantRequest,
  investigationGrantTransitionDefinitions,
} from '../src/adapters/compatibility/investigation-v2/investigation-grant-transitions.ts';
import {
  grantStorePaths,
  readGrantRecord,
} from '../src/runtime/storage-journal/grant-store.ts';
import {
  codeOwnedApprovalModuleRegistry,
  HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
  parseGrantPolicyV2,
} from '../src/modules/authority/grant-policy.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import { startInvestigationSession } from '../src/adapters/compatibility/investigation-v2/investigation-session.ts';
import {
  inspectInvestigationResolutionState,
  readHumanResolutionJournal,
  readTerminalHumanResolutionGrant,
} from '../src/runtime/storage-journal/investigation-session-store.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import { createProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  blindSurveyIntentDigest,
  blindSurveyManifestDigest,
  type BlindSurveyManifest,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperationAsync,
} from '../src/runtime/session-workspace/session-store.ts';
import { createFixtureRepository, git } from './fixture.ts';

const NOW = new Date('2026-08-18T04:00:00.000Z');
const CHALLENGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPERATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('fresh human-presence approval executes the exact investigation transition without SSH authority', async () => {
  const repository = createFixtureRepository();
  try {
    installMaintainerPolicy(repository);
    git(repository, ['checkout', '-b', 'work/demo-change']);
    const started = startFixture(repository);
    const gitState = discoverRepository(repository);
    const lifecycle = runtimePaths(
      gitState.gitCommonDirectory,
      'workflow-engine',
    );
    const investigation = investigationRuntimePaths(
      gitState.gitCommonDirectory,
      'workflow-engine',
    );
    const paths = grantStorePaths(lifecycle.root);
    const registry = createTransitionRegistry(
      investigationGrantTransitionDefinitions(repository),
    );
    const ids = [CHALLENGE_ID, OPERATION_ID];
    const coordinator = createGrantCoordinatorKernel({
      paths,
      registry,
      policy: parseGrantPolicyV2(policyInput(), {
        registry: codeOwnedApprovalModuleRegistry(),
      }),
      now: () => new Date(NOW),
      randomUUID: () => ids.shift()!,
      openApprovalSession: abortSession,
      async withLifecycleOperation(challengeId, operation) {
        return withRepositoryLifecycleOperationAsync(lifecycle, operation, {
          allowGrantChallengeId: challengeId,
          allowHumanResolutionGrantId: challengeId,
          allowHumanResolutionChangeId: 'demo-change',
        });
      },
    });

    const requested = await coordinator.requestGrant(
      createInvestigationGrantRequest(
        repository,
        started.investigationId,
        'The reviewer budget is exhausted and a human must select the resolution.',
      ),
    );
    assert.equal(requested.challengeId, CHALLENGE_ID);
    const result = await coordinator.resolveChallenge(CHALLENGE_ID);
    assert.equal(result.transitionId, 'investigation.abort.v1');
    assert.equal(result.outcome, 'completed');

    const observed = inspectInvestigationResolutionState(
      investigation,
      started.investigationId,
      'github:R_fixture',
    );
    assert.equal(observed.effectiveState, 'aborted-by-human-resolution');
    const grantRecord = readGrantRecord(paths, CHALLENGE_ID);
    const domainJournal = readHumanResolutionJournal(
      investigation,
      CHALLENGE_ID,
    );
    assert.equal(grantRecord.state, 'completed');
    assert.equal(domainJournal?.phase, 'completed');
    assert.equal(Object.hasOwn(grantRecord, 'plannedEvidenceRefs'), false);
    assert.equal(Object.hasOwn(domainJournal ?? {}, 'approvalSubject'), false);
    assert.equal(Object.hasOwn(domainJournal ?? {}, 'proofModules'), false);
    assert.equal(
      readTerminalHumanResolutionGrant(investigation, CHALLENGE_ID),
      null,
      'Grant Core must not mint a legacy SSH terminal envelope',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function abortSession(
  presentation: TrustedGrantPresentation,
): GrantApprovalSession {
  const choice = presentation.choices.find(
    ({ transitionId }) => transitionId === 'investigation.abort.v1',
  );
  assert.ok(choice);
  return {
    async collectDecision() {
      return {
        choiceId: choice.choiceId,
        approvalMethod: 'human-presence',
        reasonCode: 'workflow-cannot-continue',
        reason: 'The investigation cannot continue safely.',
        sessionNonce: 'nonce-55555555555555555555555555555555',
      };
    },
    async authenticate(subject) {
      return [humanProof(subject.approvalSubjectDigest)];
    },
    async close() {},
  };
}

function humanProof(
  approvalSubjectDigest: `sha256:${string}`,
): VerifiedApprovalProof {
  return {
    moduleId: 'human-gate-macos',
    version: '1',
    claims: ['fresh-local-device-owner'],
    approvalSubjectDigest,
    proofDigest: `sha256:${'4'.repeat(64)}`,
    verifiedAt: NOW.toISOString(),
    identity: null,
  };
}

function policyInput() {
  return {
    schemaVersion: 2,
    defaultProfile: 'local-presence',
    profiles: {
      'local-presence': { requiredClaims: ['fresh-local-device-owner'] },
    },
    approvalModules: [
      {
        moduleId: 'human-gate-macos',
        version: '1',
        allowedClaims: ['fresh-local-device-owner'],
        configurationDigest: HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
      },
    ],
    legacyVerification: { maintainerPolicyV1: 'read-only' },
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

function startFixture(repository: string) {
  const state = discoverRepository(repository);
  const providerPolicy = loadAiAdapterPolicy(repository);
  const manifest: BlindSurveyManifest = {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId: 'demo-change',
    repositoryId: 'fixture',
    baseCommit: state.head,
    baseTree: state.tree,
    normalizedIntent: {
      schemaVersion: 1,
      summary: 'Exercise Grant Core investigation resolution.',
      explicitPaths: [],
      explicitSymbols: ['GrantCoordinator'],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    architectureQuestion: 'Should the investigation continue?',
    capabilityProfile: 'repository-read-only',
  };
  const intentDigest = blindSurveyIntentDigest(manifest);
  const request = createProviderInvocationRequest({
    invocationId: 'invocation-grant-core-survey',
    nonce: 'grant-core-survey-nonce-0000000000',
    purpose: 'survey',
    providerId: 'codex',
    roleAssignment: {
      role: 'blind-surveyor',
      providerId: 'codex',
      sessionId: 'provider-session-grant-core',
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
    evaluatorVersion: 'grant-core-evaluator.v1',
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
