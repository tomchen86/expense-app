import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createApprovalSubject,
  createGrantChallenge,
} from '../src/grant-core.ts';
import {
  assertGrantLifecycleBarrier,
  grantStorePaths,
  persistGrantChallenge,
  prepareGrantTransition,
  readGrantRecord,
  recordGrantTransitionOutcome,
} from '../src/grant-store.ts';
import {
  createTransitionRegistry,
  type TransitionDefinition,
} from '../src/grant-transition-registry.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperation,
  withRepositoryLifecycleOperationAsync,
} from '../src/session-store.ts';
import { isWorkflowError } from './fixture.ts';

const NOW = new Date('2026-08-18T02:00:00.000Z');
const EXPIRES_AT = '2026-08-18T02:10:00.000Z';

test('a challenge remains canonical and readable after a new store instance', () => {
  withRuntime((runtimeRoot) => {
    const paths = grantStorePaths(runtimeRoot);
    const challenge = fixtureChallenge();

    assert.deepEqual(Object.keys(paths).sort(), ['records', 'root']);

    const stored = persistGrantChallenge(paths, challenge);
    assert.equal(stored.state, 'pending');
    assert.deepEqual(
      readGrantRecord(grantStorePaths(runtimeRoot), challenge.challengeId),
      stored,
    );

    const filePath = path.join(paths.records, `${challenge.challengeId}.json`);
    const tampered = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      challenge: { failureCode: string };
    };
    tampered.challenge.failureCode = 'agent-substituted-failure';
    fs.writeFileSync(filePath, `${JSON.stringify(tampered)}\n`);
    assert.throws(
      () => readGrantRecord(paths, challenge.challengeId),
      (error) => isWorkflowError(error, 'GRANT_STORE_UNSAFE'),
    );
  });
});

test('one atomic record moves from pending to prepared to terminal exactly once', () => {
  withRuntime((runtimeRoot) => {
    const paths = grantStorePaths(runtimeRoot);
    const challenge = fixtureChallenge();
    persistGrantChallenge(paths, challenge);
    const subject = createApprovalSubject(
      challenge,
      {
        choiceId: challenge.choices[0]!.choiceId,
        approvalMethod: 'human-presence',
        reasonCode: 'cannot-complete-review',
        reason: 'The investigation cannot safely continue.',
        sessionNonce: 'nonce-33333333333333333333333333333333',
      },
      { now: NOW },
    );
    const prepared = prepareGrantTransition(paths, {
      operationId: '77777777-7777-4777-8777-777777777777',
      challenge,
      subject,
      proofModules: [
        {
          moduleId: 'human-gate-macos',
          version: '1',
          claim: 'fresh-local-device-owner',
          proofDigest: digest('8'),
          identity: null,
        },
      ],
      createdAt: NOW.toISOString(),
    });

    assert.equal(prepared.state, 'prepared');
    assert.deepEqual(Object.keys(prepared).sort(), [
      'approvalSubject',
      'challenge',
      'kind',
      'operationId',
      'preparedAt',
      'proofModules',
      'recordedAt',
      'schemaVersion',
      'state',
    ]);
    assert.deepEqual(readGrantRecord(paths, challenge.challengeId), prepared);
    assert.deepEqual(
      fs.readdirSync(paths.records).filter((name) => name.endsWith('.json')),
      [`${challenge.challengeId}.json`],
    );
    assert.throws(
      () => assertGrantLifecycleBarrier(runtimeRoot),
      (error) => isWorkflowError(error, 'GRANT_TRANSITION_RECOVERY_REQUIRED'),
    );
    assert.doesNotThrow(() =>
      assertGrantLifecycleBarrier(runtimeRoot, challenge.challengeId),
    );

    const completed = recordGrantTransitionOutcome(paths, {
      challengeId: challenge.challengeId,
      operationId: prepared.operationId,
      poststateDigest: digest('9'),
      outcome: { outcome: 'completed', details: { terminal: true } },
      completedAt: '2026-08-18T02:00:02.000Z',
      audit: {
        approvalMethod: 'human-presence',
        authorityClass: 'local-device-owner',
        identity: null,
        identityAssurance: 'not-asserted',
        presenceAssurance: 'fresh-os-authentication',
        proofModules: ['human-gate-macos@1'],
      },
    });
    assert.equal(completed.state, 'completed');
    assert.deepEqual(Object.keys(completed).sort(), [
      'approvalSubject',
      'audit',
      'challenge',
      'completedAt',
      'kind',
      'operationId',
      'outcome',
      'poststateDigest',
      'preparedAt',
      'proofModules',
      'recordedAt',
      'schemaVersion',
      'state',
    ]);
    assert.deepEqual(readGrantRecord(paths, challenge.challengeId), completed);
    assert.deepEqual(
      recordGrantTransitionOutcome(paths, {
        challengeId: challenge.challengeId,
        operationId: prepared.operationId,
        poststateDigest: digest('9'),
        outcome: { outcome: 'completed', details: { terminal: true } },
        completedAt: '2026-08-18T02:00:02.000Z',
        audit: completed.audit,
      }),
      completed,
    );
    assert.doesNotThrow(() => assertGrantLifecycleBarrier(runtimeRoot));
    assert.throws(
      () =>
        prepareGrantTransition(paths, {
          operationId: '88888888-8888-4888-8888-888888888888',
          challenge,
          subject,
          proofModules: prepared.proofModules,
          createdAt: NOW.toISOString(),
        }),
      (error) => isWorkflowError(error, 'GRANT_CHALLENGE_UNAVAILABLE'),
    );
  });
});

test('a symlink cannot become a grant store root', () => {
  withRuntime((runtimeRoot) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-outside-'));
    try {
      fs.symlinkSync(outside, path.join(runtimeRoot, 'grants-v2'));
      assert.throws(
        () =>
          persistGrantChallenge(
            grantStorePaths(runtimeRoot),
            fixtureChallenge(),
          ),
        (error) => isWorkflowError(error, 'GRANT_STORE_UNSAFE'),
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

test('the repository lifecycle lock honors a prepared Grant Core record', () => {
  withRuntime((gitCommonDirectory) => {
    const runtime = runtimePaths(
      fs.realpathSync(gitCommonDirectory),
      'workflow-engine',
    );
    fs.mkdirSync(runtime.root, { recursive: true });
    const paths = grantStorePaths(runtime.root);
    const challenge = fixtureChallenge();
    persistGrantChallenge(paths, challenge);
    const subject = createApprovalSubject(
      challenge,
      {
        choiceId: challenge.choices[0]!.choiceId,
        approvalMethod: 'human-presence',
        reasonCode: 'cannot-complete-review',
        reason: 'A prepared transition must be recovered first.',
        sessionNonce: 'nonce-44444444444444444444444444444444',
      },
      { now: NOW },
    );
    prepareGrantTransition(paths, {
      operationId: '99999999-9999-4999-8999-999999999999',
      challenge,
      subject,
      proofModules: [
        {
          moduleId: 'human-gate-macos',
          version: '1',
          claim: 'fresh-local-device-owner',
          proofDigest: digest('a'),
          identity: null,
        },
      ],
      createdAt: NOW.toISOString(),
    });

    assert.throws(
      () => withRepositoryLifecycleOperation(runtime, () => undefined),
      (error) => isWorkflowError(error, 'GRANT_TRANSITION_RECOVERY_REQUIRED'),
    );
    assert.doesNotThrow(() =>
      withRepositoryLifecycleOperation(runtime, () => undefined, {
        allowGrantChallengeId: challenge.challengeId,
      }),
    );
  });
});

test('the async repository lifecycle lock remains owned across await', async () => {
  const gitCommonDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'grant-async-lock-')),
  );
  try {
    const runtime = runtimePaths(gitCommonDirectory, 'workflow-engine');
    fs.mkdirSync(runtime.root, { recursive: true });
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = withRepositoryLifecycleOperationAsync(
      runtime,
      async (assertOwned) => {
        assertOwned();
        entered();
        await releasePromise;
        assertOwned();
        return 'held';
      },
    );
    await enteredPromise;
    assert.throws(
      () => withRepositoryLifecycleOperation(runtime, () => undefined),
      (error) => isWorkflowError(error, 'REPOSITORY_LIFECYCLE_CONFLICT'),
    );
    release();
    assert.equal(await running, 'held');
    assert.doesNotThrow(() =>
      withRepositoryLifecycleOperation(runtime, () => undefined),
    );
  } finally {
    fs.rmSync(gitCommonDirectory, { recursive: true, force: true });
  }
});

function fixtureChallenge() {
  return createGrantChallenge(
    {
      sourceModuleId: 'investigation',
      failureCode: 'reviewer-terms-exhausted',
      facts: { investigationId: 'investigation-1' },
      stateBinding: {
        kind: 'investigation-state',
        digest: digest('1'),
      },
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
    },
    createTransitionRegistry([abortDefinition()]),
    {
      challengeId: '66666666-6666-4666-8666-666666666666',
      now: NOW,
      expiresAt: EXPIRES_AT,
    },
  );
}

function abortDefinition(): TransitionDefinition<{ terminalReason: string }> {
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
      return { kind: 'investigation-state', digest: digest('1') };
    },
    async execute({ parameters }) {
      return { outcome: 'completed', details: parameters };
    },
  };
}

function withRuntime(operation: (runtimeRoot: string) => void): void {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-store-'));
  try {
    operation(runtimeRoot);
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
