import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import type { ObservedCheckFailure } from '../src/check-runner.ts';
import {
  createTaskStrategyGreenFailureRecord,
  type TaskStrategyGreenFailureRecord,
  type TaskStrategyPatchHead,
} from '../src/task-strategy-correction-store.ts';
import {
  deriveTaskStrategyCorrectionState,
  listTaskStrategyCorrectionRounds,
  publishTaskStrategyCorrectionRoundImport,
  publishTaskStrategyCorrectionRoundResult,
  readTaskStrategyCorrectionRound,
  reserveTaskStrategyCorrectionRound,
} from '../src/task-strategy-correction-round-store.ts';
import {
  createTaskStrategyCorrectionSubject,
  createTaskStrategyImplementationSubject,
} from '../src/modules/provider-orchestration/task-strategy-provider-contract.ts';
import type { InvestigationRuntimePaths } from '../src/paths.ts';

const SESSION_ID = 'session-correction-round-store';
const RED_TRANSACTION_DIGEST = digest('red-transaction');
const RED_SOURCE_TREE = 'a'.repeat(40);
const POLICY = Object.freeze({
  maxRepairAttempts: 2,
  maxSameFailureFingerprint: 2,
});

test('provider correction rounds are contiguous immutable source-scoped attempts', () => {
  const fixture = createRuntimeFixture();
  try {
    const initialHead = patchHead('initial');
    const initialFailure = createFailure(
      fixture.paths,
      '1'.repeat(40),
      initialHead,
      'failure-one',
    );

    assert.deepEqual(
      deriveTaskStrategyCorrectionState(fixture.paths, initialFailure, POLICY),
      {
        state: 'correction-required',
        round: 1,
        nextAction: 'reserve',
      },
    );

    const invalidSurplusAuthority = {
      ...reservationInput(initialFailure, 1),
      authority: {
        ...reservationInput(initialFailure, 1).authority,
        providerResult: providerResultIdentity(1, 'surplus'),
      },
    } as unknown as Parameters<typeof reserveTaskStrategyCorrectionRound>[1];
    assert.throws(
      () =>
        reserveTaskStrategyCorrectionRound(
          fixture.paths,
          invalidSurplusAuthority,
        ),
      hasCode('TASK_STRATEGY_CORRECTION_ROUND_STATE_INVALID'),
    );

    const first = reserveTaskStrategyCorrectionRound(
      fixture.paths,
      reservationInput(initialFailure, 1),
    );
    const replayed = reserveTaskStrategyCorrectionRound(fixture.paths, {
      ...reservationInput(initialFailure, 1),
      createdAt: '2026-08-13T00:05:00.000Z',
    });
    assert.equal(replayed.reservationDigest, first.reservationDigest);
    assert.equal(
      replayed.correctionSubjectDigest,
      first.correctionSubjectDigest,
    );
    assert.equal(
      first.correctionSubjectDigest,
      createCorrectionSubject(initialFailure, 1).subjectDigest,
    );
    assert.equal('generation' in first, false);
    assert.equal('expiresAt' in first, false);
    assert.equal('maxAgeMs' in first, false);
    assert.deepEqual(first.predecessorFailure, {
      recordDigest: initialFailure.recordDigest,
      subjectDigest: initialFailure.subjectDigest,
      candidateTree: initialFailure.candidateTree,
      failureFingerprint: initialFailure.failingCheck.failureFingerprint,
      currentRedTransactionDigest: initialFailure.currentRedTransactionDigest,
      currentPatchHead: initialFailure.currentPatchHead,
    });
    assert.throws(
      () =>
        reserveTaskStrategyCorrectionRound(fixture.paths, {
          ...reservationInput(initialFailure, 1),
          correctionSubjectDigest: digest('different-provider-subject'),
        }),
      hasCode('TASK_STRATEGY_CORRECTION_ROUND_RESERVATION_CONFLICT'),
    );
    assert.deepEqual(
      deriveTaskStrategyCorrectionState(fixture.paths, initialFailure, POLICY),
      {
        state: 'correction-required',
        round: 1,
        nextAction: 'publish-result',
        correctionSubjectDigest: first.correctionSubjectDigest,
      },
    );

    assert.throws(
      () =>
        reserveTaskStrategyCorrectionRound(
          fixture.paths,
          reservationInput(initialFailure, 2),
        ),
      hasCode('TASK_STRATEGY_CORRECTION_ROUND_SEQUENCE_INVALID'),
    );
    assert.throws(
      () =>
        publishTaskStrategyCorrectionRoundImport(fixture.paths, {
          sessionId: SESSION_ID,
          currentRedTransactionDigest: RED_TRANSACTION_DIGEST,
          round: 1,
          correctionSubjectDigest: first.correctionSubjectDigest,
          authority: providerResultAuthority(first, 'first'),
          importReceipt: importIdentity('first', '2'.repeat(40)),
          currentPatchHead: correctedHead('first'),
          importedAt: '2026-08-13T00:02:00.000Z',
        }),
      hasCode('TASK_STRATEGY_CORRECTION_ROUND_SEQUENCE_INVALID'),
    );
    assert.throws(
      () =>
        publishTaskStrategyCorrectionRoundResult(fixture.paths, {
          ...resultInput(first, 'first', '2'.repeat(40)),
          authority: sealedLocalAuthority(),
        }),
      hasCode('TASK_STRATEGY_CORRECTION_ROUND_STATE_INVALID'),
    );

    const firstResult = publishTaskStrategyCorrectionRoundResult(
      fixture.paths,
      resultInput(first, 'first', '2'.repeat(40)),
    );
    const replayedResult = publishTaskStrategyCorrectionRoundResult(
      fixture.paths,
      {
        ...resultInput(first, 'first', '2'.repeat(40)),
        createdAt: '2026-08-13T00:06:00.000Z',
      },
    );
    assert.equal(replayedResult.resultDigest, firstResult.resultDigest);
    assert.equal(
      firstResult.patchResult.sourceTree,
      initialFailure.candidateTree,
    );
    assert.equal(firstResult.patchResult.targetCandidateTree, '2'.repeat(40));
    assert.equal(firstResult.authority.kind, 'provider');
    if (
      firstResult.authority.kind !== 'provider' ||
      first.authority.kind !== 'provider'
    ) {
      throw new Error('provider fixture must retain provider authority');
    }
    assert.equal(
      firstResult.authority.providerResult.invocationId,
      first.authority.providerRequest.invocationId,
    );
    assert.equal(
      firstResult.authority.providerResult.requestDigest,
      first.authority.providerRequest.requestDigest,
    );
    assert.throws(
      () =>
        publishTaskStrategyCorrectionRoundResult(
          fixture.paths,
          resultInput(first, 'different', '3'.repeat(40)),
        ),
      hasCode('TASK_STRATEGY_CORRECTION_ROUND_RESULT_CONFLICT'),
    );
    assert.deepEqual(
      deriveTaskStrategyCorrectionState(fixture.paths, initialFailure, POLICY),
      {
        state: 'correction-required',
        round: 1,
        nextAction: 'publish-import-receipt',
        correctionSubjectDigest: first.correctionSubjectDigest,
      },
    );

    const firstImport = publishTaskStrategyCorrectionRoundImport(
      fixture.paths,
      {
        sessionId: SESSION_ID,
        currentRedTransactionDigest: RED_TRANSACTION_DIGEST,
        round: 1,
        correctionSubjectDigest: first.correctionSubjectDigest,
        authority: firstResult.authority,
        importReceipt: importIdentity('first', '2'.repeat(40)),
        currentPatchHead: correctedHead('first'),
        importedAt: '2026-08-13T00:02:00.000Z',
      },
    );
    assert.equal(firstImport.patchResult.targetCandidateTree, '2'.repeat(40));
    assert.equal(
      firstImport.importReceipt.receiptDigest,
      firstImport.currentPatchHead.receiptDigest,
    );
    assert.equal(
      firstImport.importReceipt.patchRecordDigest,
      firstImport.currentPatchHead.recordDigest,
    );
    assert.equal(
      firstImport.importReceipt.patchDigest,
      firstImport.currentPatchHead.patchDigest,
    );

    const secondFailure = createFailure(
      fixture.paths,
      firstImport.patchResult.targetCandidateTree,
      firstImport.currentPatchHead,
      'failure-two',
    );
    assert.deepEqual(
      deriveTaskStrategyCorrectionState(fixture.paths, secondFailure, POLICY),
      {
        state: 'correction-required',
        round: 2,
        nextAction: 'reserve',
      },
    );

    const second = reserveTaskStrategyCorrectionRound(
      fixture.paths,
      reservationInput(secondFailure, 2),
    );
    const secondResult = publishTaskStrategyCorrectionRoundResult(
      fixture.paths,
      resultInput(second, 'second', '3'.repeat(40)),
    );
    const secondImport = publishTaskStrategyCorrectionRoundImport(
      fixture.paths,
      {
        sessionId: SESSION_ID,
        currentRedTransactionDigest: RED_TRANSACTION_DIGEST,
        round: 2,
        correctionSubjectDigest: second.correctionSubjectDigest,
        authority: secondResult.authority,
        importReceipt: importIdentity('second', '3'.repeat(40)),
        currentPatchHead: correctedHead('second'),
        importedAt: '2026-08-13T00:04:00.000Z',
      },
    );
    assert.equal(
      secondResult.patchResult.sourceTree,
      secondFailure.candidateTree,
    );
    assert.notEqual(
      secondResult.patchResult.targetCandidateTree,
      firstResult.patchResult.targetCandidateTree,
    );

    const exhaustedFailure = createFailure(
      fixture.paths,
      secondImport.patchResult.targetCandidateTree,
      secondImport.currentPatchHead,
      'failure-three',
    );
    assert.deepEqual(
      deriveTaskStrategyCorrectionState(
        fixture.paths,
        exhaustedFailure,
        POLICY,
      ),
      {
        state: 'correction-exhausted',
        completedRounds: 2,
        reason: 'max-repair-attempts',
        failureRecordDigest: exhaustedFailure.recordDigest,
      },
    );
    assert.throws(
      () =>
        reserveTaskStrategyCorrectionRound(
          fixture.paths,
          reservationInput(exhaustedFailure, 3),
        ),
      hasCode('TASK_STRATEGY_CORRECTION_ROUND_EXHAUSTED'),
    );

    const rounds = listTaskStrategyCorrectionRounds(
      fixture.paths,
      SESSION_ID,
      RED_TRANSACTION_DIGEST,
    );
    assert.equal(rounds.length, 2);
    assert.deepEqual(
      rounds.map(({ reservation }) => reservation.round),
      [1, 2],
    );
    assert.equal(rounds[0]?.result?.resultDigest, firstResult.resultDigest);
    assert.equal(
      rounds[1]?.importRecord?.importDigest,
      secondImport.importDigest,
    );
    assert.deepEqual(
      readTaskStrategyCorrectionRound(
        fixture.paths,
        SESSION_ID,
        RED_TRANSACTION_DIGEST,
        2,
      ),
      rounds[1],
    );
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('sealed-local correction preserves the exact RED author without provider artifacts', () => {
  const fixture = createRuntimeFixture();
  try {
    const failure = createFailure(
      fixture.paths,
      '7'.repeat(40),
      patchHead('local-initial'),
      'local-failure',
    );
    const reservation = reserveTaskStrategyCorrectionRound(fixture.paths, {
      ...reservationInput(failure, 1),
      correctionSubjectDigest: createCorrectionSubject(
        failure,
        1,
        'tdd-single-agent',
      ).subjectDigest,
      authority: sealedLocalAuthority(),
    });
    assert.deepEqual(reservation.authority, sealedLocalAuthority());

    assert.throws(
      () =>
        publishTaskStrategyCorrectionRoundResult(fixture.paths, {
          ...localResultInput(reservation, 'local', '8'.repeat(40)),
          authority: {
            kind: 'provider',
            providerRequest: providerRequestIdentity(1),
            providerReservation: providerReservationIdentity(1),
            providerAttempt: providerAttemptIdentity(1),
            providerResult: providerResultIdentity(1, 'local-cross-kind'),
          },
        }),
      hasCode('TASK_STRATEGY_CORRECTION_ROUND_STATE_INVALID'),
    );

    const result = publishTaskStrategyCorrectionRoundResult(
      fixture.paths,
      localResultInput(reservation, 'local', '8'.repeat(40)),
    );
    assert.deepEqual(result.authority, sealedLocalAuthority());
    assert.equal(result.patchResult.sourceTree, failure.candidateTree);
    assert.equal(result.patchResult.targetCandidateTree, '8'.repeat(40));

    const imported = publishTaskStrategyCorrectionRoundImport(fixture.paths, {
      sessionId: SESSION_ID,
      currentRedTransactionDigest: RED_TRANSACTION_DIGEST,
      round: 1,
      correctionSubjectDigest: reservation.correctionSubjectDigest,
      authority: result.authority,
      importReceipt: importIdentity('local', '8'.repeat(40)),
      currentPatchHead: correctedHead('local'),
      importedAt: '2026-08-13T00:02:00.000Z',
    });
    assert.deepEqual(imported.authority, result.authority);
    assert.equal('providerRequest' in imported.authority, false);
    assert.equal('providerResult' in imported.authority, false);
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('same-fingerprint policy exhausts independently of wall-clock metadata', () => {
  const fixture = createRuntimeFixture();
  try {
    const policy = {
      maxRepairAttempts: 2,
      maxSameFailureFingerprint: 1,
    };
    const initialFailure = createFailure(
      fixture.paths,
      '4'.repeat(40),
      patchHead('same-initial'),
      'same-fingerprint',
    );
    const first = reserveTaskStrategyCorrectionRound(fixture.paths, {
      ...reservationInput(initialFailure, 1),
      policy,
    });
    publishTaskStrategyCorrectionRoundResult(
      fixture.paths,
      resultInput(first, 'same', '5'.repeat(40)),
    );
    const imported = publishTaskStrategyCorrectionRoundImport(fixture.paths, {
      sessionId: SESSION_ID,
      currentRedTransactionDigest: RED_TRANSACTION_DIGEST,
      round: 1,
      correctionSubjectDigest: first.correctionSubjectDigest,
      authority: providerResultAuthority(first, 'same'),
      importReceipt: importIdentity('same', '5'.repeat(40)),
      currentPatchHead: correctedHead('same'),
      importedAt: '2026-08-13T00:02:00.000Z',
    });
    const repeated = createFailure(
      fixture.paths,
      imported.patchResult.targetCandidateTree,
      imported.currentPatchHead,
      'same-fingerprint',
      '2026-08-20T00:00:00.000Z',
    );

    assert.deepEqual(
      deriveTaskStrategyCorrectionState(fixture.paths, repeated, policy),
      {
        state: 'correction-exhausted',
        completedRounds: 1,
        reason: 'same-failure-fingerprint',
        failureRecordDigest: repeated.recordDigest,
      },
    );
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

test('round listing fails closed on non-contiguous or foreign artifacts', () => {
  const fixture = createRuntimeFixture();
  try {
    const failure = createFailure(
      fixture.paths,
      '6'.repeat(40),
      patchHead('invalid'),
      'failure',
    );
    reserveTaskStrategyCorrectionRound(
      fixture.paths,
      reservationInput(failure, 1),
    );
    const roundDirectory = path.join(
      fixture.paths.refs,
      'task-strategy-correction-rounds',
      SESSION_ID,
      RED_TRANSACTION_DIGEST,
      '0001',
    );
    fs.writeFileSync(path.join(roundDirectory, 'foreign.json'), '{}\n', {
      mode: 0o600,
    });
    assert.throws(
      () =>
        listTaskStrategyCorrectionRounds(
          fixture.paths,
          SESSION_ID,
          RED_TRANSACTION_DIGEST,
        ),
      hasCode('TASK_STRATEGY_CORRECTION_ROUND_STATE_INVALID'),
    );
  } finally {
    fs.rmSync(fixture.base, { recursive: true, force: true });
  }
});

function reservationInput(
  predecessorFailure: TaskStrategyGreenFailureRecord,
  round: number,
) {
  const correctionSubject = createCorrectionSubject(predecessorFailure, round);
  return {
    sessionId: SESSION_ID,
    round,
    policy: POLICY,
    predecessorFailure,
    correctionSubjectDigest: correctionSubject.subjectDigest,
    redSourceTree: RED_SOURCE_TREE,
    authority: {
      kind: 'provider' as const,
      providerRequest: providerRequestIdentity(round),
      providerReservation: providerReservationIdentity(round),
    },
    createdAt: `2026-08-13T00:00:0${round}.000Z`,
  };
}

function createCorrectionSubject(
  predecessorFailure: TaskStrategyGreenFailureRecord,
  round: number,
  strategy: 'cross-agent-tdd' | 'tdd-single-agent' = 'cross-agent-tdd',
) {
  return createTaskStrategyCorrectionSubject({
    subject: createTaskStrategyImplementationSubject({
      sessionId: SESSION_ID,
      changeId: 'correction-round-store',
      taskId: '1.1',
      strategy,
      transactionDigest: RED_TRANSACTION_DIGEST,
      taskContractDigest: digest('task-contract'),
      sourceTree: RED_SOURCE_TREE,
      failureFingerprint: digest('sealed-red-failure'),
      redEvidenceNodeId: digest('red-evidence-node'),
      redEvidenceResultDigest: digest('red-evidence-result'),
      testPaths: ['test/behavior.test.ts'],
      fixturePaths: [],
      frozenFiles: [
        {
          path: 'test/behavior.test.ts',
          objectId: digest('frozen-test-object'),
          mode: '100644',
        },
      ],
    }),
    round,
    greenFailureRecord: predecessorFailure,
  });
}

function resultInput(
  reservation: ReturnType<typeof reserveTaskStrategyCorrectionRound>,
  label: string,
  targetCandidateTree: string,
) {
  return {
    sessionId: reservation.sessionId,
    currentRedTransactionDigest:
      reservation.predecessorFailure.currentRedTransactionDigest,
    round: reservation.round,
    correctionSubjectDigest: reservation.correctionSubjectDigest,
    authority: providerResultAuthority(reservation, label),
    patchResult: {
      sourceTree: reservation.predecessorFailure.candidateTree,
      targetCandidateTree,
      patchRecordDigest: digest(`patch-record-${label}`),
      patchDigest: digest(`patch-${label}`),
    },
    createdAt: '2026-08-13T00:01:00.000Z',
  };
}

function localResultInput(
  reservation: ReturnType<typeof reserveTaskStrategyCorrectionRound>,
  label: string,
  targetCandidateTree: string,
) {
  if (reservation.authority.kind !== 'sealed-local') {
    throw new Error('sealed-local fixture requires local authority');
  }
  return {
    sessionId: reservation.sessionId,
    currentRedTransactionDigest:
      reservation.predecessorFailure.currentRedTransactionDigest,
    round: reservation.round,
    correctionSubjectDigest: reservation.correctionSubjectDigest,
    authority: reservation.authority,
    patchResult: {
      sourceTree: reservation.predecessorFailure.candidateTree,
      targetCandidateTree,
      patchRecordDigest: digest(`patch-record-${label}`),
      patchDigest: digest(`patch-${label}`),
    },
    createdAt: '2026-08-13T00:01:00.000Z',
  };
}

function providerRequestIdentity(round: number) {
  return {
    ownerInvestigationId: 'investigation-correction-round-store',
    invocationId: `invocation-correction-round-${round}`,
    requestDigest: digest(`request-${round}`),
  };
}

function providerReservationIdentity(round: number) {
  return {
    reservationDigest: digest(`provider-reservation-${round}`),
    authorizationNodeId: digest(`provider-authorization-${round}`),
    reservationNodeId: digest(`provider-reservation-node-${round}`),
  };
}

function providerResultIdentity(round: number, label: string) {
  const request = providerRequestIdentity(round);
  return {
    bindingDigest: digest(`provider-result-binding-${label}`),
    invocationId: request.invocationId,
    requestDigest: request.requestDigest,
    outputDigest: digest(`provider-output-${label}`),
    providerResultNodeId: digest(`provider-result-node-${label}`),
    providerResultDigest: digest(`provider-result-${label}`),
  };
}

function providerAttemptIdentity(round: number) {
  const request = providerRequestIdentity(round);
  return {
    attempt: 1,
    attemptReservationDigest:
      providerReservationIdentity(round).reservationDigest,
    invocationId: request.invocationId,
    requestDigest: request.requestDigest,
  };
}

function providerResultAuthority(
  reservation: ReturnType<typeof reserveTaskStrategyCorrectionRound>,
  label: string,
) {
  if (reservation.authority.kind !== 'provider') {
    throw new Error('provider fixture requires provider reservation authority');
  }
  return {
    kind: 'provider' as const,
    providerRequest: reservation.authority.providerRequest,
    providerReservation: reservation.authority.providerReservation,
    providerAttempt: {
      attempt: 1,
      attemptReservationDigest:
        reservation.authority.providerReservation.reservationDigest,
      invocationId: reservation.authority.providerRequest.invocationId,
      requestDigest: reservation.authority.providerRequest.requestDigest,
    },
    providerResult: {
      bindingDigest: digest(`provider-result-binding-${label}`),
      invocationId: reservation.authority.providerRequest.invocationId,
      requestDigest: reservation.authority.providerRequest.requestDigest,
      outputDigest: digest(`provider-output-${label}`),
      providerResultNodeId: digest(`provider-result-node-${label}`),
      providerResultDigest: digest(`provider-result-${label}`),
    },
  };
}

function sealedLocalAuthority() {
  return {
    kind: 'sealed-local' as const,
    author: {
      providerId: 'codex' as const,
      assurance: 'runtime-hint' as const,
    },
  };
}

function importIdentity(label: string, candidateTree: string) {
  return {
    patchRecordDigest: digest(`patch-record-${label}`),
    patchDigest: digest(`patch-${label}`),
    receiptDigest: digest(`patch-receipt-${label}`),
    candidateTree,
  };
}

function patchHead(label: string): TaskStrategyPatchHead {
  return {
    bindingDigest: digest(`patch-binding-${label}`),
    recordDigest: digest(`patch-record-${label}`),
    patchDigest: digest(`patch-${label}`),
    receiptDigest: digest(`patch-receipt-${label}`),
  };
}

function correctedHead(label: string): TaskStrategyPatchHead {
  return patchHead(label);
}

function createFailure(
  paths: InvestigationRuntimePaths,
  candidateTree: string,
  currentPatchHead: TaskStrategyPatchHead,
  fingerprintSeed: string,
  createdAt = '2026-08-13T00:00:00.000Z',
): TaskStrategyGreenFailureRecord {
  const failureWithoutFingerprint = {
    checkId: 'test',
    outcome: 'failed' as const,
    exitCode: 1,
    runner: 'node',
    runnerDigest: digest('runner'),
    stdoutDigest: digest(fingerprintSeed),
    stderrDigest: digest(''),
    stdoutExcerpt: fingerprintSeed,
    stderrExcerpt: '',
    stdoutTruncated: false,
    stderrTruncated: false,
  };
  const failingCheck: ObservedCheckFailure = {
    ...failureWithoutFingerprint,
    failureFingerprint: digest(canonicalJson(failureWithoutFingerprint)),
  };
  return createTaskStrategyGreenFailureRecord(paths, {
    sessionId: SESSION_ID,
    currentRedTransactionDigest: RED_TRANSACTION_DIGEST,
    currentPatchHead,
    candidateTree,
    checkDefinitions: [
      {
        checkId: 'test',
        definition: {
          command: ['node', 'scripts/test.mjs'],
          destructiveDatabase: false,
        },
        runner: 'node',
        runnerDigest: failingCheck.runnerDigest,
      },
    ],
    passedChecks: [],
    failingCheck,
    createdAt,
  });
}

function createRuntimeFixture(): {
  base: string;
  paths: InvestigationRuntimePaths;
} {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'task-correction-round-store-')),
  );
  const root = path.join(base, 'workflow-engine', 'investigations');
  return {
    base,
    paths: {
      base,
      root,
      objects: path.join(root, 'objects', 'sha256'),
      refs: path.join(root, 'refs'),
      sessions: path.join(root, 'sessions'),
      invocations: path.join(root, 'invocations'),
      locks: path.join(root, 'locks'),
    },
  };
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hasCode(expected: string): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code: string }).code === expected;
}
