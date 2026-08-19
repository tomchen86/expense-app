import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import {
  createApprovalSubject,
  createGrantChallenge,
  approvalSubjectDigest,
} from '../src/modules/authority/grant-core.ts';
import {
  createProductionWorkflowGrantCoordinator,
  requestInvestigationV3Grant,
} from '../src/grant-production.ts';
import { HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST } from '../src/modules/authority/grant-policy.ts';
import {
  grantStorePaths,
  prepareGrantTransition,
  readGrantRecord,
} from '../src/runtime/storage-journal/grant-store.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import {
  INVESTIGATION_V3_ATTEMPTED_TRANSITIONS,
  INVESTIGATION_V3_KNOWN_FAILURE_CODES,
  createInvestigationV3Blocker,
  createInvestigationV3BlockerFromError,
} from '../src/modules/investigation/manifest/investigation-manifest.ts';
import {
  createInvestigationV3GrantRequest,
  investigationV3CentralFailureCode,
  investigationV3GrantTransitionDefinitions,
} from '../src/modules/investigation/seal/investigation-v3-grant.ts';
import { writeInvestigationV3ShadowObservation } from '../src/runtime/storage-journal/investigation-shadow-store.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import { runtimePaths } from '../src/runtime/session-workspace/session-store.ts';
import { git } from './fixture.ts';

const PROPOSED_REASON =
  'The v3 transition failed and a human must choose the bounded continuation.';

test('central adapter covers every v3 transition and non-exhaustive failure code', () => {
  const codes = [
    ...INVESTIGATION_V3_KNOWN_FAILURE_CODES,
    'FUTURE_ENGINE_FAILURE',
  ];
  for (const attemptedTransition of INVESTIGATION_V3_ATTEMPTED_TRANSITIONS) {
    for (const failureCode of codes) {
      const blocker = createInvestigationV3Blocker({
        attemptedTransition,
        candidate: { attemptedTransition, failureCode },
        failureCode,
        message: `Failure ${failureCode}`,
      });
      const request = createInvestigationV3GrantRequest({
        failure: failureContext(blocker),
        proposedReason: PROPOSED_REASON,
      });
      assert.equal(request.sourceModuleId, 'investigation.v3');
      assert.equal(
        request.failureCode,
        investigationV3CentralFailureCode(failureCode),
      );
      assert.equal(request.stateBinding.kind, 'investigation.v3.failure');
      assert.deepEqual(request.facts, {
        schemaVersion: 1,
        workflowKind: 'investigation-v3',
        repositoryId: 'fixture',
        changeId: 'demo-change',
        investigationId: 'investigation-demo',
        sessionRevision: 3,
        sessionSnapshotDigest: 'c'.repeat(64),
        blocker,
      });
      assert.equal(request.candidates.length, 1);
      assert.equal(
        request.candidates[0]!.transitionId,
        'investigation.v3.stop-transition.v3',
      );
      assert.equal(
        (request.candidates[0]!.parameters as { schemaVersion?: unknown })
          .schemaVersion,
        3,
      );
      assert.equal(request.candidates[0]!.proposedReason, PROPOSED_REASON);
      assert.equal('title' in request.candidates[0]!, false);
      assert.equal('consequences' in request.candidates[0]!, false);
      assert.equal('execute' in request.candidates[0]!, false);
    }
  }
  assert.equal(
    investigationV3CentralFailureCode('FUTURE_ENGINE_FAILURE'),
    'investigation.v3.future-engine-failure',
  );
});

test('a future engine failure survives the real v3 emitter path into central mapping', () => {
  const blocker = createInvestigationV3BlockerFromError({
    attemptedTransition: 'authority-validation',
    candidate: { revision: 4 },
    error: workflowError(
      'FUTURE_ENGINE_FAILURE',
      'A future engine failure must retain its stable identity.',
      ExitCode.guard,
    ),
  });

  assert.equal(blocker.failureCode, 'FUTURE_ENGINE_FAILURE');
  const request = createInvestigationV3GrantRequest({
    failure: failureContext(blocker),
    proposedReason: PROPOSED_REASON,
  });
  assert.equal(request.failureCode, 'investigation.v3.future-engine-failure');
});

test('central registry owns the safe stop transition without relabelling assurance', async () => {
  const blocker = createInvestigationV3Blocker({
    attemptedTransition: 'publication',
    candidate: { manifestDigest: 'a'.repeat(64) },
    failureCode: 'REVIEW_TARGET_STALE',
    message: 'The publication target changed.',
  });
  const request = createInvestigationV3GrantRequest({
    failure: failureContext(blocker),
    proposedReason: PROPOSED_REASON,
  });
  const registry = createTransitionRegistry(
    investigationV3GrantTransitionDefinitions('/repo'),
  );
  const challenge = createGrantChallenge(request, registry, {
    challengeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    now: new Date('2026-08-18T05:00:00.000Z'),
    expiresAt: '2026-08-18T05:10:00.000Z',
  });
  const choice = challenge.choices[0]!;
  assert.deepEqual(registry.renderTrustedChoice(choice), {
    title: 'Stop this Investigation v3 transition',
    consequences: [
      'Preserves the failed assurance and keeps the current authority unchanged.',
    ],
  });
  assert.equal(
    registry.resolve(choice.transitionId).resolutionKind,
    'non-retry',
  );
});

test('the source-bound transition keeps the durable v2 definition registered for recovery', () => {
  const registry = createTransitionRegistry(
    investigationV3GrantTransitionDefinitions('/repo'),
  );
  assert.equal(
    registry.resolve('investigation.v3.stop-transition.v2').resolutionKind,
    'non-retry',
  );
  assert.equal(
    registry.resolve('investigation.v3.stop-transition.v3').resolutionKind,
    'non-retry',
  );
});

test('v3 adapter remains central and introduces no local grant substrate', () => {
  const source = fs.readFileSync(
    new URL(
      '../src/modules/investigation/seal/investigation-v3-grant.ts',
      import.meta.url,
    ),
    'utf8',
  );
  for (const forbidden of [
    'grant-store',
    'human-gate-macos',
    'grant-proof-ssh',
    'writeFile',
    'callback',
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

test('an engine-produced v3 blocker becomes a durable central challenge and state drift is re-observed', async () => {
  const repository = createGrantFixtureRepository();
  try {
    const git = discoverRepository(repository);
    const investigationRuntime = investigationRuntimePaths(
      git.gitCommonDirectory,
      'workflow-engine',
    );
    const lifecycleRuntime = runtimePaths(
      git.gitCommonDirectory,
      'workflow-engine',
    );
    const blocker = createInvestigationV3Blocker({
      attemptedTransition: 'authority-validation',
      candidate: { revision: 3 },
      failureCode: 'FUTURE_ENGINE_FAILURE',
      message: 'A future engine failure remains centrally consumable.',
    });
    const shadowPath = writeInvestigationV3ShadowObservation({
      runtime: investigationRuntime,
      repositoryId: 'fixture',
      changeId: 'demo-change',
      investigationId: 'investigation-demo',
      sessionRevision: 3,
      sessionSnapshotDigest: 'c'.repeat(64),
      result: { outcome: 'blocked', blocker },
    });

    const requested = await requestInvestigationV3Grant(
      repository,
      'investigation-demo',
      PROPOSED_REASON,
    );
    const stored = readGrantRecord(
      grantStorePaths(lifecycleRuntime.root),
      requested.challengeId,
    );
    assert.equal(stored.state, 'pending');
    assert.equal(stored.challenge.sourceModuleId, 'investigation.v3');
    assert.deepEqual(stored.challenge.facts, {
      schemaVersion: 1,
      workflowKind: 'investigation-v3',
      repositoryId: 'fixture',
      changeId: 'demo-change',
      investigationId: 'investigation-demo',
      sessionRevision: 3,
      sessionSnapshotDigest: 'c'.repeat(64),
      blocker,
    });
    const shadowBytes = fs.readFileSync(shadowPath, 'utf8');
    assert.equal(shadowBytes.includes(requested.challengeId), false);
    assert.equal(shadowBytes.includes('grantChallenge'), false);

    const registry = createTransitionRegistry(
      investigationV3GrantTransitionDefinitions(repository),
    );
    const choice = stored.challenge.choices[0]!;
    const definition = registry.resolve(choice.transitionId);
    assert.deepEqual(
      await definition.observeState(choice.parameters),
      stored.challenge.stateBinding,
    );
    const approvalSubject = createApprovalSubject(
      stored.challenge,
      {
        choiceId: choice.choiceId,
        approvalMethod: 'human-presence',
        reasonCode: 'preserve-current-authority',
        reason: 'Keep the current authority and stop this failed transition.',
        sessionNonce: 'nonce-55555555555555555555555555555555',
      },
      { now: new Date(stored.challenge.issuedAt) },
    );
    const transitionContext = {
      parameters: choice.parameters,
      approvalSubject,
      approvalSubjectDigest: approvalSubjectDigest(approvalSubject),
      challengeId: stored.challenge.challengeId,
      operationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      recovered: false,
      assertLifecycleOwned() {},
    };
    const outcome = await definition.execute(transitionContext);
    assert.deepEqual(outcome, {
      outcome: 'completed',
      details: {
        continuation: 'stop-transition',
        failureIdentity: blocker.failureIdentity,
        failurePreserved: true,
        authorityAdvanced: false,
      },
    });
    assert.equal(canonicalJson(outcome).includes('verified'), false);
    const storePaths = grantStorePaths(lifecycleRuntime.root);
    prepareGrantTransition(storePaths, {
      operationId: transitionContext.operationId,
      challenge: stored.challenge,
      subject: approvalSubject,
      proofModules: [
        {
          moduleId: 'human-gate-macos',
          version: '1',
          claim: 'fresh-local-device-owner',
          proofDigest: `sha256:${'4'.repeat(64)}`,
          identity: null,
        },
      ],
      createdAt: stored.challenge.issuedAt,
    });

    const changedBlocker = createInvestigationV3Blocker({
      attemptedTransition: 'authority-validation',
      candidate: { revision: 4 },
      failureCode: 'FUTURE_ENGINE_FAILURE',
      message: 'The engine failure changed after challenge creation.',
    });
    writeInvestigationV3ShadowObservation({
      runtime: investigationRuntime,
      repositoryId: 'fixture',
      changeId: 'demo-change',
      investigationId: 'investigation-demo',
      sessionRevision: 4,
      sessionSnapshotDigest: 'd'.repeat(64),
      result: { outcome: 'blocked', blocker: changedBlocker },
    });
    assert.notDeepEqual(
      await definition.observeState(choice.parameters),
      stored.challenge.stateBinding,
    );
    await assert.rejects(
      definition.execute({ ...transitionContext, recovered: true }),
      (error) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'INVESTIGATION_V3_GRANT_STATE_CHANGED',
    );
    const recovered = await createProductionWorkflowGrantCoordinator(
      repository,
    ).recoverChallenge(stored.challenge.challengeId);
    assert.equal(recovered.outcome, 'failed');
    const terminal = readGrantRecord(storePaths, stored.challenge.challengeId);
    assert.equal(terminal.state, 'failed');
    if (terminal.state !== 'failed') assert.fail('expected terminal failure');
    assert.equal(
      (terminal.outcome.details as { failureCode?: unknown }).failureCode,
      'GRANT_STATE_CHANGED',
    );
    assert.equal(
      readGrantRecord(storePaths, stored.challenge.challengeId).state,
      'failed',
      'stale recovery must record a terminal failure without completing the transition',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function failureContext(
  blocker: ReturnType<typeof createInvestigationV3Blocker>,
) {
  return {
    repositoryId: 'fixture',
    changeId: 'demo-change',
    investigationId: 'investigation-demo',
    sessionRevision: 3,
    sessionSnapshotDigest: 'c'.repeat(64),
    blocker,
  };
}

function installGrantPolicy(repository: string): void {
  fs.writeFileSync(
    path.join(repository, 'workflow/grant-policy.json'),
    `${canonicalJson({
      schemaVersion: 2,
      defaultProfile: 'local-presence',
      profiles: {
        'local-presence': {
          requiredClaims: ['fresh-local-device-owner'],
        },
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
    })}\n`,
  );
}

function createGrantFixtureRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-v3-grant-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'v3-grant@example.test']);
  git(repository, ['config', 'user.name', 'V3 Grant Test']);
  fs.mkdirSync(path.join(repository, 'workflow'), { recursive: true });
  fs.writeFileSync(
    path.join(repository, 'workflow/config.json'),
    `${canonicalJson({
      schemaVersion: 1,
      repositoryName: 'fixture',
      changeRoot: 'openspec/changes',
      runtimeDirectory: 'workflow-engine',
      protectedBranches: ['main', 'master'],
      branchTemplate: 'work/{changeId}',
      taskAuthorization: {
        pathRoleRegistry: 'workflow/path-roles.json',
        mandateRequiredRoles: ['control-plane'],
      },
    })}\n`,
  );
  installGrantPolicy(repository);
  git(repository, [
    'add',
    '--',
    'workflow/config.json',
    'workflow/grant-policy.json',
  ]);
  git(repository, ['commit', '-m', 'Create v3 Grant fixture']);
  return repository;
}
