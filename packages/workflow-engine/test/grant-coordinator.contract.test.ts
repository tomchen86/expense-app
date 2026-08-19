import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { VerifiedApprovalProof } from '../src/modules/authority/grant-approval.ts';
import {
  createGrantCoordinatorKernel,
  type GrantApprovalSession,
  type TrustedGrantPresentation,
} from '../src/modules/authority/grant-coordinator.ts';
import type {
  GrantRequestInput,
  StateBinding,
} from '../src/modules/authority/grant-core.ts';
import {
  assertGrantLifecycleBarrier,
  grantStorePaths,
  readGrantRecord,
} from '../src/runtime/storage-journal/grant-store.ts';
import {
  codeOwnedApprovalModuleRegistry,
  GRANT_PROOF_SSH_V1_CONFIGURATION_DIGEST,
  HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
  parseGrantPolicyV2,
} from '../src/modules/authority/grant-policy.ts';
import {
  createTransitionRegistry,
  grantTransitionPreconditionChanged,
  type TransitionDefinition,
} from '../src/modules/authority/grant-transition-registry.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import { isWorkflowError } from './fixture.ts';

const NOW = new Date('2026-08-18T04:00:00.000Z');
const CHALLENGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPERATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('only a trusted-session decision reaches the exact registered transition', async () => {
  await withRuntime(async (runtimeRoot) => {
    let state = binding('1');
    let effects = 0;
    const definition = abortDefinition({
      observe: () => state,
      execute: ({ operationId }) => {
        assert.equal(operationId, OPERATION_ID);
        effects += 1;
        state = binding('9');
      },
    });
    const coordinator = coordinatorFixture(runtimeRoot, definition, {
      openSession(presentation) {
        assertTrustedPresentation(presentation);
        return successfulSession(presentation);
      },
    });

    const challenge = await coordinator.requestGrant(request());
    assert.equal(challenge.challengeId, CHALLENGE_ID);
    const presentation = coordinator.inspectChallenge(CHALLENGE_ID);
    assertTrustedPresentation(presentation);

    const result = await coordinator.resolveChallenge(CHALLENGE_ID);
    assert.equal(result.outcome, 'completed');
    assert.equal(result.transitionId, 'investigation.abort.v1');
    assert.equal(effects, 1);
    assert.equal(
      readGrantRecord(grantStorePaths(runtimeRoot), CHALLENGE_ID).state,
      'completed',
    );
  });
});

test('SSH is selected instead of local presence and records credential assurance', async () => {
  await withRuntime(async (runtimeRoot) => {
    let state = binding('1');
    const definition = abortDefinition({
      observe: () => state,
      execute: () => {
        state = binding('9');
      },
    });
    const coordinator = coordinatorFixture(runtimeRoot, definition, {
      enableSsh: true,
      openSession(presentation) {
        assert.deepEqual(presentation.approvalMethods, [
          'human-presence',
          'ssh',
        ]);
        return {
          async collectDecision() {
            return {
              choiceId: presentation.choices[0]!.choiceId,
              approvalMethod: 'ssh',
              reasonCode: 'cannot-complete-review',
              reason: 'Use the configured interactive SSH credential.',
              sessionNonce: 'nonce-77777777777777777777777777777777',
            };
          },
          async authenticate({ approvalSubjectDigest }) {
            return [sshProof(approvalSubjectDigest)];
          },
          async close() {},
        };
      },
    });
    await coordinator.requestGrant(request());

    await coordinator.resolveChallenge(CHALLENGE_ID);
    const record = readGrantRecord(grantStorePaths(runtimeRoot), CHALLENGE_ID);
    assert.equal(record.state, 'completed');
    if (record.state !== 'completed') assert.fail('expected terminal record');
    assert.deepEqual(record.audit, {
      approvalMethod: 'ssh',
      authorityClass: 'ssh-credential',
      identity: 'fixture-maintainer',
      identityAssurance: 'policy-trusted-ssh-key',
      presenceAssurance: 'not-asserted',
      proofModules: ['grant-proof-ssh@1'],
    });
  });
});

test('state drift after fresh authentication invalidates the approval before prepare', async () => {
  await withRuntime(async (runtimeRoot) => {
    let state = binding('1');
    let effects = 0;
    const definition = abortDefinition({
      observe: () => state,
      execute: () => {
        effects += 1;
        state = binding('9');
      },
    });
    const coordinator = coordinatorFixture(runtimeRoot, definition, {
      openSession(presentation) {
        return successfulSession(presentation, () => {
          state = binding('d');
        });
      },
    });
    await coordinator.requestGrant(request());

    await assert.rejects(coordinator.resolveChallenge(CHALLENGE_ID), (error) =>
      isWorkflowError(error, 'GRANT_STATE_CHANGED'),
    );
    assert.equal(effects, 0);
    assert.equal(
      readGrantRecord(grantStorePaths(runtimeRoot), CHALLENGE_ID).state,
      'pending',
    );
  });
});

test('cancel and timeout leave the challenge pending without authentication or transition effects', async () => {
  await withRuntime(async (runtimeRoot) => {
    let state = binding('1');
    let effects = 0;
    let closed = false;
    const definition = abortDefinition({
      observe: () => state,
      execute: () => {
        effects += 1;
        state = binding('9');
      },
    });
    const cancelled = coordinatorFixture(runtimeRoot, definition, {
      openSession() {
        return {
          async collectDecision() {
            throw workflowError(
              'HUMAN_GATE_CANCELLED',
              'The human cancelled the decision.',
              ExitCode.guard,
            );
          },
          async authenticate() {
            assert.fail('cancelled decision must not authenticate');
          },
          async close() {
            closed = true;
          },
        };
      },
    });
    await cancelled.requestGrant(request());
    await assert.rejects(cancelled.resolveChallenge(CHALLENGE_ID), (error) =>
      isWorkflowError(error, 'HUMAN_GATE_CANCELLED'),
    );
    assert.equal(closed, true);
    assert.equal(effects, 0);
    assert.equal(
      readGrantRecord(grantStorePaths(runtimeRoot), CHALLENGE_ID).state,
      'pending',
    );
  });

  await withRuntime(async (runtimeRoot) => {
    let current = new Date(NOW);
    let authenticated = false;
    let effects = 0;
    const definition = abortDefinition({
      observe: () => binding('1'),
      execute: () => {
        effects += 1;
      },
    });
    const expired = coordinatorFixture(runtimeRoot, definition, {
      challengeTtlMs: 1,
      now: () => current,
      openSession(presentation) {
        return {
          async collectDecision() {
            current = new Date(NOW.getTime() + 2);
            return {
              choiceId: presentation.choices[0]!.choiceId,
              reasonCode: 'cannot-complete-review',
              reason: 'The decision took longer than the challenge lifetime.',
              approvalMethod: 'human-presence',
              sessionNonce: 'nonce-99999999999999999999999999999999',
            };
          },
          async authenticate() {
            authenticated = true;
            return [];
          },
          async close() {},
        };
      },
    });
    await expired.requestGrant(request());
    await assert.rejects(expired.resolveChallenge(CHALLENGE_ID), (error) =>
      isWorkflowError(error, 'GRANT_CHALLENGE_EXPIRED'),
    );
    assert.equal(authenticated, false);
    assert.equal(effects, 0);
    assert.equal(
      readGrantRecord(grantStorePaths(runtimeRoot), CHALLENGE_ID).state,
      'pending',
    );
  });
});

test('after durable prepare recovery repeats only the same idempotent transition', async () => {
  await withRuntime(async (runtimeRoot) => {
    let state = binding('1');
    let attempts = 0;
    let effects = 0;
    const definition = abortDefinition({
      observe: () => state,
      execute: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('simulated process crash');
        if (state.digest === binding('1').digest) {
          effects += 1;
          state = binding('9');
        }
      },
    });
    const coordinator = coordinatorFixture(runtimeRoot, definition, {
      openSession: successfulSession,
    });
    await coordinator.requestGrant(request());

    await assert.rejects(
      coordinator.resolveChallenge(CHALLENGE_ID),
      /simulated process crash/,
    );
    assert.equal(
      readGrantRecord(grantStorePaths(runtimeRoot), CHALLENGE_ID).state,
      'prepared',
    );

    const recovered = await coordinator.recoverChallenge(CHALLENGE_ID);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.outcome, 'completed');
    assert.equal(attempts, 2);
    assert.equal(effects, 1);

    const duplicate = await coordinator.recoverChallenge(CHALLENGE_ID);
    assert.equal(duplicate.recovered, true);
    assert.equal(attempts, 2);
    assert.equal(effects, 1);
  });
});

test('prepared recovery converges an idempotent transition that applied before its receipt was durable', async () => {
  await withRuntime(async (runtimeRoot) => {
    let state = binding('1');
    let attempts = 0;
    let effects = 0;
    const definition = abortDefinition({
      observe: () => state,
      execute: () => {
        attempts += 1;
        if (state.digest === binding('1').digest) {
          effects += 1;
          state = binding('9');
          throw workflowError(
            'SIMULATED_POST_EFFECT_LOCK_STALE',
            'simulated crash after transition effect',
            ExitCode.staleState,
          );
        }
      },
    });
    const coordinator = coordinatorFixture(runtimeRoot, definition, {
      openSession: successfulSession,
    });
    await coordinator.requestGrant(request());

    await assert.rejects(
      coordinator.resolveChallenge(CHALLENGE_ID),
      /simulated crash after transition effect/,
    );
    assert.equal(
      readGrantRecord(grantStorePaths(runtimeRoot), CHALLENGE_ID).state,
      'prepared',
    );

    const recovered = await coordinator.recoverChallenge(CHALLENGE_ID);
    assert.equal(recovered.outcome, 'completed');
    assert.equal(recovered.recovered, true);
    assert.equal(attempts, 2);
    assert.equal(effects, 1);
    assert.equal(
      readGrantRecord(grantStorePaths(runtimeRoot), CHALLENGE_ID).state,
      'completed',
    );
  });
});

test('prepared recovery terminalizes deterministic state drift without applying effects or retaining the lifecycle barrier', async () => {
  await withRuntime(async (runtimeRoot) => {
    let state = binding('1');
    let attempts = 0;
    let effects = 0;
    const definition = abortDefinition({
      observe: () => state,
      execute: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('simulated process crash');
        if (state.digest !== binding('1').digest) {
          throw grantTransitionPreconditionChanged(
            'FIXTURE_STATE_CHANGED',
            'The fixture state changed before its transition could execute.',
          );
        }
        effects += 1;
      },
    });
    const coordinator = coordinatorFixture(runtimeRoot, definition, {
      openSession: successfulSession,
    });
    await coordinator.requestGrant(request());

    await assert.rejects(
      coordinator.resolveChallenge(CHALLENGE_ID),
      /simulated process crash/,
    );
    assert.equal(
      readGrantRecord(grantStorePaths(runtimeRoot), CHALLENGE_ID).state,
      'prepared',
    );
    assert.throws(
      () => assertGrantLifecycleBarrier(runtimeRoot),
      (error) => isWorkflowError(error, 'GRANT_TRANSITION_RECOVERY_REQUIRED'),
    );

    state = binding('d');
    const recovered = await coordinator.recoverChallenge(CHALLENGE_ID);
    assert.deepEqual(recovered, {
      challengeId: CHALLENGE_ID,
      operationId: OPERATION_ID,
      transitionId: 'investigation.abort.v1',
      outcome: 'failed',
      poststateDigest: binding('d').digest,
      recovered: true,
    });
    assert.equal(attempts, 2);
    assert.equal(effects, 0);

    const terminal = readGrantRecord(
      grantStorePaths(runtimeRoot),
      CHALLENGE_ID,
    );
    assert.equal(terminal.state, 'failed');
    if (terminal.state !== 'failed') assert.fail('expected terminal failure');
    assert.deepEqual(terminal.outcome, {
      outcome: 'failed',
      details: {
        schemaVersion: 1,
        kind: 'grant-transition-state-drift.v1',
        failureCode: 'GRANT_STATE_CHANGED',
        transitionCompleted: false,
        transitionErrorCode: 'FIXTURE_STATE_CHANGED',
        expectedStateBinding: binding('1'),
        observedStateBinding: binding('d'),
      },
    });
    assert.deepEqual(terminal.audit, {
      approvalMethod: 'human-presence',
      authorityClass: 'local-device-owner',
      identity: null,
      identityAssurance: 'not-asserted',
      presenceAssurance: 'fresh-os-authentication',
      proofModules: ['human-gate-macos@1'],
    });
    assert.doesNotThrow(() => assertGrantLifecycleBarrier(runtimeRoot));

    assert.deepEqual(
      await coordinator.recoverChallenge(CHALLENGE_ID),
      recovered,
    );
    assert.equal(attempts, 2);
    assert.equal(effects, 0);
    await assert.rejects(coordinator.resolveChallenge(CHALLENGE_ID), (error) =>
      isWorkflowError(error, 'GRANT_CHALLENGE_UNAVAILABLE'),
    );
  });
});

test('a stale-state error without changed observed state cannot cancel a prepared transition', async () => {
  await withRuntime(async (runtimeRoot) => {
    let attempts = 0;
    const definition = abortDefinition({
      observe: () => binding('1'),
      execute: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('simulated process crash');
        throw workflowError(
          'FIXTURE_TRANSIENT_STALE',
          'The fixture emitted a stale signal without state drift.',
          ExitCode.staleState,
        );
      },
    });
    const coordinator = coordinatorFixture(runtimeRoot, definition, {
      openSession: successfulSession,
    });
    await coordinator.requestGrant(request());
    await assert.rejects(
      coordinator.resolveChallenge(CHALLENGE_ID),
      /simulated process crash/,
    );

    await assert.rejects(coordinator.recoverChallenge(CHALLENGE_ID), (error) =>
      isWorkflowError(error, 'FIXTURE_TRANSIENT_STALE'),
    );
    assert.equal(attempts, 2);
    assert.equal(
      readGrantRecord(grantStorePaths(runtimeRoot), CHALLENGE_ID).state,
      'prepared',
    );
    assert.throws(
      () => assertGrantLifecycleBarrier(runtimeRoot),
      (error) => isWorkflowError(error, 'GRANT_TRANSITION_RECOVERY_REQUIRED'),
    );
  });
});

function coordinatorFixture(
  runtimeRoot: string,
  definition: TransitionDefinition<{ terminalReason: string }>,
  options: {
    enableSsh?: boolean;
    now?: () => Date;
    challengeTtlMs?: number;
    openSession(
      presentation: TrustedGrantPresentation,
    ): GrantApprovalSession | Promise<GrantApprovalSession>;
  },
) {
  const ids = [CHALLENGE_ID, OPERATION_ID];
  return createGrantCoordinatorKernel({
    paths: grantStorePaths(runtimeRoot),
    registry: createTransitionRegistry([definition]),
    policy: parseGrantPolicyV2(
      options.enableSsh ? sshPolicyInput() : policyInput(),
      {
        registry: codeOwnedApprovalModuleRegistry(),
      },
    ),
    now: options.now ?? (() => new Date(NOW)),
    randomUUID: () => ids.shift()!,
    challengeTtlMs: options.challengeTtlMs ?? 10 * 60_000,
    openApprovalSession: options.openSession,
    async withLifecycleOperation(_challengeId, operation) {
      return operation(() => undefined);
    },
  });
}

function successfulSession(
  presentation: TrustedGrantPresentation,
  afterAuthentication: () => void = () => undefined,
): GrantApprovalSession {
  return {
    async collectDecision() {
      return {
        choiceId: presentation.choices[0]!.choiceId,
        reasonCode: 'cannot-complete-review',
        reason: 'The required reviewer input cannot be recovered.',
        approvalMethod: 'human-presence',
        sessionNonce: 'nonce-55555555555555555555555555555555',
      };
    },
    async authenticate(subject) {
      afterAuthentication();
      return [humanProof(subject.approvalSubjectDigest)];
    },
    async close() {},
  };
}

function assertTrustedPresentation(
  presentation: TrustedGrantPresentation,
): void {
  assert.equal(presentation.failureCode, 'reviewer-terms-exhausted');
  assert.deepEqual(presentation.approvalMethods, ['human-presence']);
  assert.deepEqual(presentation.choices[0], {
    choiceId: presentation.challenge.choices[0]!.choiceId,
    transitionId: 'investigation.abort.v1',
    title: 'Abort investigation',
    consequences: ['The investigation becomes terminal.'],
    allowedReasonCodes: ['cannot-complete-review'],
    reasonRequired: true,
    proposedReason:
      'The reviewer budget is exhausted and the investigation cannot continue.',
  });
}

function abortDefinition(options: {
  observe: () => StateBinding;
  execute: (context: { operationId: string }) => void;
}): TransitionDefinition<{ terminalReason: string }> {
  return {
    transitionId: 'investigation.abort.v1',
    parameterSchemaDigest: digest('2'),
    consequenceDigest: digest('3'),
    resolutionKind: 'non-retry',
    validateParameters(value) {
      assert.deepEqual(value, { terminalReason: 'reviewer-terms-exhausted' });
      return value as { terminalReason: string };
    },
    renderTrustedChoice() {
      return {
        title: 'Abort investigation',
        consequences: ['The investigation becomes terminal.'],
      };
    },
    observeState() {
      return options.observe();
    },
    async execute(context) {
      options.execute(context);
      return { outcome: 'completed', details: { terminal: true } };
    },
  };
}

function request(): GrantRequestInput {
  return {
    sourceModuleId: 'investigation',
    failureCode: 'reviewer-terms-exhausted',
    facts: { investigationId: 'investigation-1' },
    stateBinding: binding('1'),
    candidates: [
      {
        transitionId: 'investigation.abort.v1',
        parameters: { terminalReason: 'reviewer-terms-exhausted' },
        allowedReasonCodes: ['cannot-complete-review'],
        reasonRequired: true,
        proposedReason:
          'The reviewer budget is exhausted and the investigation cannot continue.',
      },
    ],
  };
}

function policyInput() {
  return {
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
  };
}

function sshPolicyInput() {
  return {
    ...policyInput(),
    profiles: {
      ...policyInput().profiles,
      ssh: { requiredClaims: ['ssh-signature'] },
    },
    approvalModules: [
      ...policyInput().approvalModules,
      {
        moduleId: 'grant-proof-ssh',
        version: '1',
        allowedClaims: ['ssh-signature'],
        configurationDigest: GRANT_PROOF_SSH_V1_CONFIGURATION_DIGEST,
      },
    ],
    optionalSsh: {
      signatureNamespace: 'expense-app.workflow.grant-proof.v1',
      trustedSigners: [
        {
          identity: 'fixture-maintainer',
          publicKey:
            'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
          fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
        },
      ],
    },
  };
}

function humanProof(subjectDigest: `sha256:${string}`): VerifiedApprovalProof {
  return {
    moduleId: 'human-gate-macos',
    version: '1',
    claims: ['fresh-local-device-owner'],
    approvalSubjectDigest: subjectDigest,
    proofDigest: digest('4'),
    verifiedAt: NOW.toISOString(),
    identity: null,
  };
}

function sshProof(subjectDigest: `sha256:${string}`): VerifiedApprovalProof {
  return {
    moduleId: 'grant-proof-ssh',
    version: '1',
    claims: ['ssh-signature'],
    approvalSubjectDigest: subjectDigest,
    proofDigest: digest('7'),
    verifiedAt: NOW.toISOString(),
    identity: 'fixture-maintainer',
  };
}

async function withRuntime(
  operation: (runtimeRoot: string) => Promise<void>,
): Promise<void> {
  const runtimeRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'grant-coordinator-'),
  );
  try {
    await operation(fs.realpathSync(runtimeRoot));
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

function binding(character: string): StateBinding {
  return { kind: 'investigation-state', digest: digest(character) };
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
