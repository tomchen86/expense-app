import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { createEvidenceNode } from '../src/adapters/compatibility/investigation-v2/evidence-node.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import {
  compareAndSwapTaskStrategyCurrentRef,
  createTaskStrategyCurrentRef,
  createTaskStrategyRedRevisionJournal,
  parseTaskStrategyRedRevisionJournal,
  parseTaskStrategyRedRevisionRequest,
  persistTaskStrategyRedRevisionRequest,
  readActiveTaskStrategyRedRevision,
  readTaskStrategyCurrentRef,
  readTaskStrategyRedRevisionJournal,
  readTaskStrategyRedRevisionRequest,
  taskStrategyRedRevisionId,
  taskStrategyRedRevisionSnapshotDigest,
  updateTaskStrategyRedRevisionJournal,
  type TaskStrategyRedRevisionJournal,
  type TaskStrategyRedRevisionPhase,
} from '../src/runtime/storage-journal/task-strategy-red-revision-store.ts';
import {
  createContentAddressedTaskStrategyTransaction,
  createTaskStrategyTransaction,
  prepareTaskStrategyTransaction,
  readTaskStrategyTransaction,
  readTaskStrategyTransactionByDigest,
  type TaskStrategyTransaction,
} from '../src/runtime/storage-journal/task-strategy-store.ts';

test('current ref makes RED authoring effective-null while preserving the predecessor by digest', () => {
  const fixture = createStoreFixture();
  try {
    const predecessor = createTaskStrategyTransaction(
      fixture.paths,
      transactionInput('1'),
    );
    const request = parseTaskStrategyRedRevisionRequest({
      schemaVersion: 1,
      kind: 'task-strategy-red-revision-request',
      sessionId: predecessor.sessionId,
      expectedTransactionDigest: predecessor.recordDigest,
      reason: 'Correct the reviewed behavioral expectation.',
    });
    const revisionId = taskStrategyRedRevisionId(request);
    const authoring = createTaskStrategyCurrentRef({
      sessionId: predecessor.sessionId,
      state: 'red-authoring',
      transactionDigest: null,
      predecessorTransactionDigest: predecessor.recordDigest,
      revisionId,
      taskContractDigest: predecessor.taskContractDigest,
      updatedAt: '2026-08-13T00:00:01.000Z',
    });

    assert.deepEqual(
      compareAndSwapTaskStrategyCurrentRef(fixture.paths, {
        sessionId: predecessor.sessionId,
        expectedRefDigest: null,
        next: authoring,
      }),
      authoring,
    );
    assert.equal(
      readTaskStrategyTransaction(fixture.paths, predecessor.sessionId),
      null,
    );
    assert.deepEqual(
      readTaskStrategyTransactionByDigest(
        fixture.paths,
        predecessor.sessionId,
        predecessor.recordDigest,
      ),
      predecessor,
    );

    const successor = createContentAddressedTaskStrategyTransaction(
      fixture.paths,
      transactionInput('2'),
    );
    const sealed = createTaskStrategyCurrentRef({
      sessionId: predecessor.sessionId,
      state: 'red-sealed',
      transactionDigest: successor.recordDigest,
      predecessorTransactionDigest: predecessor.recordDigest,
      revisionId,
      taskContractDigest: predecessor.taskContractDigest,
      updatedAt: '2026-08-13T00:00:02.000Z',
    });
    compareAndSwapTaskStrategyCurrentRef(fixture.paths, {
      sessionId: predecessor.sessionId,
      expectedRefDigest: authoring.refDigest,
      next: sealed,
    });

    assert.deepEqual(
      readTaskStrategyTransaction(fixture.paths, predecessor.sessionId),
      successor,
    );
    assert.deepEqual(
      readTaskStrategyCurrentRef(fixture.paths, predecessor.sessionId),
      sealed,
    );
    assert.ok(
      fs.existsSync(
        path.join(
          fixture.paths.refs,
          'task-strategies',
          `${predecessor.sessionId}.json`,
        ),
      ),
      'the legacy v1 session singleton remains intact',
    );
  } finally {
    fixture.dispose();
  }
});

test('successor transaction preparation is pure until exact persistence', () => {
  const fixture = createStoreFixture();
  try {
    const prepared = prepareTaskStrategyTransaction(transactionInput('5'));
    assert.equal(
      readTaskStrategyTransactionByDigest(
        fixture.paths,
        prepared.sessionId,
        prepared.recordDigest,
      ),
      null,
    );
    const stored = createContentAddressedTaskStrategyTransaction(
      fixture.paths,
      transactionInput('5'),
    );
    assert.deepEqual(stored, prepared);
  } finally {
    fixture.dispose();
  }
});

test('current-ref CAS is replay-safe and rejects a stale expected digest', () => {
  const fixture = createStoreFixture();
  try {
    const predecessor = createTaskStrategyTransaction(
      fixture.paths,
      transactionInput('3'),
    );
    const request = parseTaskStrategyRedRevisionRequest({
      schemaVersion: 1,
      kind: 'task-strategy-red-revision-request',
      sessionId: predecessor.sessionId,
      expectedTransactionDigest: predecessor.recordDigest,
      reason: 'Replace a mistaken assertion.',
    });
    const next = createTaskStrategyCurrentRef({
      sessionId: predecessor.sessionId,
      state: 'red-authoring',
      transactionDigest: null,
      predecessorTransactionDigest: predecessor.recordDigest,
      revisionId: taskStrategyRedRevisionId(request),
      taskContractDigest: predecessor.taskContractDigest,
      updatedAt: '2026-08-13T00:00:01.000Z',
    });
    compareAndSwapTaskStrategyCurrentRef(fixture.paths, {
      sessionId: predecessor.sessionId,
      expectedRefDigest: null,
      next,
    });
    assert.deepEqual(
      compareAndSwapTaskStrategyCurrentRef(fixture.paths, {
        sessionId: predecessor.sessionId,
        expectedRefDigest: null,
        next,
      }),
      next,
      'an exact replay succeeds even after the expected predecessor was consumed',
    );
    assert.throws(
      () =>
        compareAndSwapTaskStrategyCurrentRef(fixture.paths, {
          sessionId: predecessor.sessionId,
          expectedRefDigest: 'f'.repeat(64),
          next: createTaskStrategyCurrentRef({
            ...next,
            updatedAt: '2026-08-13T00:00:02.000Z',
          }),
        }),
      hasCode('TASK_STRATEGY_CURRENT_REF_CAS_MISMATCH'),
    );
  } finally {
    fixture.dispose();
  }
});

test('current-ref publication rejects an unavailable or non-current successor lineage', () => {
  const fixture = createStoreFixture();
  try {
    const predecessor = createTaskStrategyTransaction(
      fixture.paths,
      transactionInput('6'),
    );
    const revisionId = taskStrategyRedRevisionId(
      parseTaskStrategyRedRevisionRequest({
        schemaVersion: 1,
        kind: 'task-strategy-red-revision-request',
        sessionId: predecessor.sessionId,
        expectedTransactionDigest: predecessor.recordDigest,
        reason: 'Correct the exact test expectation.',
      }),
    );
    assert.throws(
      () =>
        compareAndSwapTaskStrategyCurrentRef(fixture.paths, {
          sessionId: predecessor.sessionId,
          expectedRefDigest: null,
          next: createTaskStrategyCurrentRef({
            sessionId: predecessor.sessionId,
            state: 'red-authoring',
            transactionDigest: null,
            predecessorTransactionDigest: 'f'.repeat(64),
            revisionId,
            taskContractDigest: predecessor.taskContractDigest,
            updatedAt: '2026-08-13T00:00:01.000Z',
          }),
        }),
      hasCode('TASK_STRATEGY_RED_REVISION_STATE_CORRUPT'),
    );

    const authoring = createTaskStrategyCurrentRef({
      sessionId: predecessor.sessionId,
      state: 'red-authoring',
      transactionDigest: null,
      predecessorTransactionDigest: predecessor.recordDigest,
      revisionId,
      taskContractDigest: predecessor.taskContractDigest,
      updatedAt: '2026-08-13T00:00:01.000Z',
    });
    compareAndSwapTaskStrategyCurrentRef(fixture.paths, {
      sessionId: predecessor.sessionId,
      expectedRefDigest: null,
      next: authoring,
    });
    const unrelated = createContentAddressedTaskStrategyTransaction(
      fixture.paths,
      transactionInput('7'),
    );
    const unrelatedRevisionId = taskStrategyRedRevisionId(
      parseTaskStrategyRedRevisionRequest({
        schemaVersion: 1,
        kind: 'task-strategy-red-revision-request',
        sessionId: predecessor.sessionId,
        expectedTransactionDigest: unrelated.recordDigest,
        reason: 'A stale unrelated revision request.',
      }),
    );
    assert.throws(
      () =>
        compareAndSwapTaskStrategyCurrentRef(fixture.paths, {
          sessionId: predecessor.sessionId,
          expectedRefDigest: authoring.refDigest,
          next: createTaskStrategyCurrentRef({
            sessionId: predecessor.sessionId,
            state: 'red-sealed',
            transactionDigest: unrelated.recordDigest,
            predecessorTransactionDigest: predecessor.recordDigest,
            revisionId: unrelatedRevisionId,
            taskContractDigest: predecessor.taskContractDigest,
            updatedAt: '2026-08-13T00:00:02.000Z',
          }),
        }),
      hasCode('TASK_STRATEGY_RED_REVISION_STATE_CORRUPT'),
    );
  } finally {
    fixture.dispose();
  }
});

test('revision request and phase journal are immutable, digest-bound, and atomically advanced', () => {
  const fixture = createStoreFixture();
  try {
    const predecessor = createTaskStrategyTransaction(
      fixture.paths,
      transactionInput('4'),
    );
    const request = parseTaskStrategyRedRevisionRequest({
      schemaVersion: 1,
      kind: 'task-strategy-red-revision-request',
      sessionId: predecessor.sessionId,
      expectedTransactionDigest: predecessor.recordDigest,
      reason: 'Correct the exact test expectation.',
    });
    const persisted = persistTaskStrategyRedRevisionRequest(
      fixture.paths,
      request,
    );
    assert.deepEqual(
      readTaskStrategyRedRevisionRequest(
        fixture.paths,
        predecessor.sessionId,
        persisted.revisionId,
      ),
      persisted,
    );

    const authoringRef = createTaskStrategyCurrentRef({
      sessionId: predecessor.sessionId,
      state: 'red-authoring',
      transactionDigest: null,
      predecessorTransactionDigest: predecessor.recordDigest,
      revisionId: persisted.revisionId,
      taskContractDigest: predecessor.taskContractDigest,
      updatedAt: '2026-08-13T00:00:01.000Z',
    });
    const beforeSession = {
      schemaVersion: 1,
      sessionId: predecessor.sessionId,
      latestCheckReportId: 'check-before',
    };
    const afterSession = {
      schemaVersion: 1,
      sessionId: predecessor.sessionId,
    };
    const prepared = createTaskStrategyRedRevisionJournal(fixture.paths, {
      revisionId: persisted.revisionId,
      sessionId: predecessor.sessionId,
      phase: 'prepared',
      request,
      requestDigest: persisted.requestDigest,
      predecessor: {
        transactionDigest: predecessor.recordDigest,
        candidateTree: predecessor.red.candidateTree,
        currentRefDigest: null,
      },
      binding: {
        changeId: predecessor.changeId,
        taskId: predecessor.taskId,
        baseline: predecessor.baseline,
        strategy: predecessor.strategy,
        taskContractDigest: predecessor.taskContractDigest,
        checkId: predecessor.red.checkId,
        runner: predecessor.red.runner,
        runnerDigest: predecessor.red.runnerDigest,
        author: predecessor.author,
      },
      restoration: {
        sourceTree: predecessor.red.candidateTree,
        implementationCandidateTree: null,
        patchRecordDigest: null,
        patchDigest: null,
      },
      sessionTransition: {
        before: beforeSession,
        beforeDigest: taskStrategyRedRevisionSnapshotDigest(beforeSession),
        after: afterSession,
        afterDigest: taskStrategyRedRevisionSnapshotDigest(afterSession),
      },
      authoringRef,
      successorTransaction: null,
      successorRef: null,
      createdAt: '2026-08-13T00:00:01.000Z',
      updatedAt: '2026-08-13T00:00:01.000Z',
    });
    assert.equal(prepared.previousJournalDigest, null);

    assert.throws(
      () =>
        updateTaskStrategyRedRevisionJournal(fixture.paths, {
          sessionId: predecessor.sessionId,
          revisionId: persisted.revisionId,
          expectedJournalDigest: prepared.journalDigest,
          next: {
            ...withoutJournalEnvelope(prepared),
            phase: 'current-authoring',
            updatedAt: '2026-08-13T00:00:02.000Z',
          },
        }),
      hasCode('TASK_STRATEGY_RED_REVISION_PHASE_INVALID'),
    );

    const restored = updateTaskStrategyRedRevisionJournal(fixture.paths, {
      sessionId: predecessor.sessionId,
      revisionId: persisted.revisionId,
      expectedJournalDigest: prepared.journalDigest,
      next: {
        ...withoutJournalEnvelope(prepared),
        phase: 'implementation-restored',
        updatedAt: '2026-08-13T00:00:02.000Z',
      },
    });
    assert.equal(restored.previousJournalDigest, prepared.journalDigest);
    assert.deepEqual(
      readTaskStrategyRedRevisionJournal(
        fixture.paths,
        predecessor.sessionId,
        persisted.revisionId,
      ),
      restored,
    );
    assert.throws(
      () =>
        updateTaskStrategyRedRevisionJournal(fixture.paths, {
          sessionId: predecessor.sessionId,
          revisionId: persisted.revisionId,
          expectedJournalDigest: prepared.journalDigest,
          next: {
            ...withoutJournalEnvelope(restored),
            phase: 'current-authoring',
            updatedAt: '2026-08-13T00:00:03.000Z',
          },
        }),
      hasCode('TASK_STRATEGY_RED_REVISION_JOURNAL_CAS_MISMATCH'),
    );
  } finally {
    fixture.dispose();
  }
});

test('active RED revision discovery recovers request-only and prepared crash windows', () => {
  const fixture = createStoreFixture();
  try {
    const predecessor = createTaskStrategyTransaction(
      fixture.paths,
      transactionInput('8'),
    );
    assert.equal(
      readActiveTaskStrategyRedRevision(fixture.paths, predecessor.sessionId),
      null,
    );

    const request = parseTaskStrategyRedRevisionRequest({
      schemaVersion: 1,
      kind: 'task-strategy-red-revision-request',
      sessionId: predecessor.sessionId,
      expectedTransactionDigest: predecessor.recordDigest,
      reason: 'Recover a request persisted before journal creation.',
    });
    persistTaskStrategyRedRevisionRequest(fixture.paths, request);
    assert.deepEqual(
      readActiveTaskStrategyRedRevision(fixture.paths, predecessor.sessionId),
      { request, journal: null },
    );

    const prepared = createPreparedRevisionJournal(
      fixture,
      predecessor,
      request,
    );
    assert.deepEqual(
      readActiveTaskStrategyRedRevision(fixture.paths, predecessor.sessionId),
      { request, journal: prepared },
    );
  } finally {
    fixture.dispose();
  }
});

test('active RED revision discovery permits completed history but rejects multiple active revisions', () => {
  const fixture = createStoreFixture();
  try {
    const predecessor = createTaskStrategyTransaction(
      fixture.paths,
      transactionInput('9'),
    );
    const completedRequest = parseTaskStrategyRedRevisionRequest({
      schemaVersion: 1,
      kind: 'task-strategy-red-revision-request',
      sessionId: predecessor.sessionId,
      expectedTransactionDigest: predecessor.recordDigest,
      reason: 'A historical revision that already completed.',
    });
    persistTaskStrategyRedRevisionRequest(fixture.paths, completedRequest);
    const prepared = createPreparedRevisionJournal(
      fixture,
      predecessor,
      completedRequest,
    );
    advanceJournalToCompleted(fixture, prepared, transactionInput('7'));

    const activeRequest = parseTaskStrategyRedRevisionRequest({
      schemaVersion: 1,
      kind: 'task-strategy-red-revision-request',
      sessionId: predecessor.sessionId,
      expectedTransactionDigest: predecessor.recordDigest,
      reason: 'The one recoverable request-only revision.',
    });
    persistTaskStrategyRedRevisionRequest(fixture.paths, activeRequest);
    assert.deepEqual(
      readActiveTaskStrategyRedRevision(fixture.paths, predecessor.sessionId),
      { request: activeRequest, journal: null },
    );

    const conflictingRequest = parseTaskStrategyRedRevisionRequest({
      schemaVersion: 1,
      kind: 'task-strategy-red-revision-request',
      sessionId: predecessor.sessionId,
      expectedTransactionDigest: predecessor.recordDigest,
      reason: 'A second concurrent active revision must fail closed.',
    });
    persistTaskStrategyRedRevisionRequest(fixture.paths, conflictingRequest);
    assert.throws(
      () =>
        readActiveTaskStrategyRedRevision(fixture.paths, predecessor.sessionId),
      hasCode('TASK_STRATEGY_RED_REVISION_STATE_CORRUPT'),
    );
  } finally {
    fixture.dispose();
  }
});

test('active RED revision discovery rejects unsafe revision inventory', () => {
  const fixture = createStoreFixture();
  try {
    const predecessor = createTaskStrategyTransaction(
      fixture.paths,
      transactionInput('6'),
    );
    const request = parseTaskStrategyRedRevisionRequest({
      schemaVersion: 1,
      kind: 'task-strategy-red-revision-request',
      sessionId: predecessor.sessionId,
      expectedTransactionDigest: predecessor.recordDigest,
      reason: 'Reject unrecognized durable revision bytes.',
    });
    const persisted = persistTaskStrategyRedRevisionRequest(
      fixture.paths,
      request,
    );
    fs.writeFileSync(
      path.join(
        fixture.paths.refs,
        'task-strategy-red-revisions',
        predecessor.sessionId,
        persisted.revisionId,
        'unexpected.json',
      ),
      '{}\n',
      { mode: 0o600 },
    );
    assert.throws(
      () =>
        readActiveTaskStrategyRedRevision(fixture.paths, predecessor.sessionId),
      hasCode('TASK_STRATEGY_RED_REVISION_STATE_CORRUPT'),
    );
  } finally {
    fixture.dispose();
  }
});

test('revision journal rejects a re-digested arbitrary session transition', () => {
  const fixture = createStoreFixture();
  try {
    const predecessor = createTaskStrategyTransaction(
      fixture.paths,
      transactionInput('5'),
    );
    const request = parseTaskStrategyRedRevisionRequest({
      schemaVersion: 1,
      kind: 'task-strategy-red-revision-request',
      sessionId: predecessor.sessionId,
      expectedTransactionDigest: predecessor.recordDigest,
      reason: 'Bind evidence clearing to the exact session snapshot.',
    });
    persistTaskStrategyRedRevisionRequest(fixture.paths, request);
    const prepared = createPreparedRevisionJournal(
      fixture,
      predecessor,
      request,
      {
        state: 'started',
        implementationReconciliationReportId: 'reconciliation-before',
        implementationReconciliationPaths: ['src/feature.ts'],
      },
    );
    const after = {
      ...prepared.sessionTransition.after,
      state: 'completed',
    };
    const tamperedBody = {
      ...withoutDigest(prepared),
      sessionTransition: {
        ...prepared.sessionTransition,
        after,
        afterDigest: digest(after),
      },
    };
    const tampered = {
      ...tamperedBody,
      journalDigest: digest(tamperedBody),
    };
    assert.throws(
      () => parseTaskStrategyRedRevisionJournal(tampered),
      hasCode('TASK_STRATEGY_RED_REVISION_STATE_CORRUPT'),
    );
  } finally {
    fixture.dispose();
  }
});

function createStoreFixture() {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-strategy-red-revision-store-'),
  );
  return {
    paths: investigationRuntimePaths(base, 'workflow-engine'),
    dispose() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

function createPreparedRevisionJournal(
  fixture: ReturnType<typeof createStoreFixture>,
  predecessor: TaskStrategyTransaction,
  request: ReturnType<typeof parseTaskStrategyRedRevisionRequest>,
  beforeExtra: Readonly<Record<string, unknown>> = {},
): TaskStrategyRedRevisionJournal {
  const persisted = persistTaskStrategyRedRevisionRequest(
    fixture.paths,
    request,
  );
  const authoringRef = createTaskStrategyCurrentRef({
    sessionId: predecessor.sessionId,
    state: 'red-authoring',
    transactionDigest: null,
    predecessorTransactionDigest: predecessor.recordDigest,
    revisionId: persisted.revisionId,
    taskContractDigest: predecessor.taskContractDigest,
    updatedAt: '2026-08-13T00:00:01.000Z',
  });
  const before: Record<string, unknown> = {
    schemaVersion: 1,
    sessionId: predecessor.sessionId,
    ...beforeExtra,
    latestCheckReportId: 'check-before',
    checkEvidenceEngineDigest: 'a'.repeat(64),
  };
  const after: Record<string, unknown> = { ...before };
  delete after.latestCheckReportId;
  delete after.checkEvidenceEngineDigest;
  delete after.implementationReconciliationReportId;
  delete after.implementationReconciliationPaths;
  return createTaskStrategyRedRevisionJournal(fixture.paths, {
    revisionId: persisted.revisionId,
    sessionId: predecessor.sessionId,
    phase: 'prepared',
    request,
    requestDigest: persisted.requestDigest,
    predecessor: {
      transactionDigest: predecessor.recordDigest,
      candidateTree: predecessor.red.candidateTree,
      currentRefDigest: null,
    },
    binding: {
      changeId: predecessor.changeId,
      taskId: predecessor.taskId,
      baseline: predecessor.baseline,
      strategy: predecessor.strategy,
      taskContractDigest: predecessor.taskContractDigest,
      checkId: predecessor.red.checkId,
      runner: predecessor.red.runner,
      runnerDigest: predecessor.red.runnerDigest,
      author: predecessor.author,
    },
    restoration: {
      sourceTree: predecessor.red.candidateTree,
      implementationCandidateTree: null,
      patchRecordDigest: null,
      patchDigest: null,
    },
    sessionTransition: {
      before,
      beforeDigest: taskStrategyRedRevisionSnapshotDigest(before),
      after,
      afterDigest: taskStrategyRedRevisionSnapshotDigest(after),
    },
    authoringRef,
    successorTransaction: null,
    successorRef: null,
    createdAt: '2026-08-13T00:00:01.000Z',
    updatedAt: '2026-08-13T00:00:01.000Z',
  });
}

function advanceJournalToCompleted(
  fixture: ReturnType<typeof createStoreFixture>,
  prepared: TaskStrategyRedRevisionJournal,
  successorInput: Omit<
    TaskStrategyTransaction,
    'schemaVersion' | 'kind' | 'recordDigest'
  >,
): TaskStrategyRedRevisionJournal {
  const successor = prepareTaskStrategyTransaction(successorInput);
  const successorRef = createTaskStrategyCurrentRef({
    sessionId: prepared.sessionId,
    state: 'red-sealed',
    transactionDigest: successor.recordDigest,
    predecessorTransactionDigest: prepared.predecessor.transactionDigest,
    revisionId: prepared.revisionId,
    taskContractDigest: prepared.binding.taskContractDigest,
    updatedAt: '2026-08-13T00:00:05.000Z',
  });
  let journal = prepared;
  const phases: readonly TaskStrategyRedRevisionPhase[] = [
    'implementation-restored',
    'current-authoring',
    'session-evidence-cleared',
    'reseal-prepared',
    'successor-persisted',
    'current-sealed',
    'completed',
  ];
  for (const [index, phase] of phases.entries()) {
    journal = updateTaskStrategyRedRevisionJournal(fixture.paths, {
      sessionId: journal.sessionId,
      revisionId: journal.revisionId,
      expectedJournalDigest: journal.journalDigest,
      next: {
        ...withoutJournalEnvelope(journal),
        phase,
        successorTransaction:
          phase === 'reseal-prepared' || journal.successorTransaction !== null
            ? successor
            : null,
        successorRef:
          phase === 'reseal-prepared' || journal.successorRef !== null
            ? successorRef
            : null,
        updatedAt: `2026-08-13T00:00:0${index + 2}.000Z`,
      },
    });
  }
  return journal;
}

function withoutDigest<T extends { journalDigest: string }>(
  value: T,
): Omit<T, 'journalDigest'> {
  const { journalDigest: _journalDigest, ...body } = value;
  return body;
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function transactionInput(
  marker: string,
): Omit<TaskStrategyTransaction, 'schemaVersion' | 'kind' | 'recordDigest'> {
  const candidateTree = marker.repeat(40);
  const evidenceNode = createEvidenceNode({
    type: 'task-strategy-red-evidence',
    nodeSchema: 'task-strategy-red-evidence.v1',
    evaluator: 'workflow-engine',
    policyDigest: 'a'.repeat(64),
    exactInputDigests: { candidateTree: 'b'.repeat(64) },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'task-strategy-red-result.v1',
    output: { marker },
    runtimeMetadata: { createdAt: '2026-08-13T00:00:00.000Z' },
  });
  return {
    sessionId: 'session-store-contract',
    changeId: 'demo-change',
    taskId: '1.1',
    baseline: { head: 'a'.repeat(40), tree: 'b'.repeat(40) },
    strategy: 'tdd-single-agent',
    phase: 'red-sealed',
    taskContractDigest: 'c'.repeat(64),
    author: { providerId: 'codex', assurance: 'self-declared' },
    red: {
      candidateTree,
      changedPaths: ['test/feature.test.mjs'],
      checkId: 'red',
      runner: 'node --test test/feature.test.mjs',
      runnerDigest: 'd'.repeat(64),
      exitCode: 1,
      failureCategory: 'assertion',
      selector: 'test/feature.test.mjs',
      testPaths: ['test/feature.test.mjs'],
      fixturePaths: [],
      files: [
        {
          path: 'test/feature.test.mjs',
          mode: '100644',
          objectId: marker.repeat(40),
        },
      ],
      stdoutDigest: 'e'.repeat(64),
      stderrDigest: 'f'.repeat(64),
      failureFingerprint: '1'.repeat(64),
      evidenceNodeId: evidenceNode.nodeId,
      evidenceResultDigest: evidenceNode.resultDigest,
      evidenceNode,
    },
    createdAt: `2026-08-13T00:00:0${marker}.000Z`,
  };
}

function withoutJournalEnvelope<
  T extends {
    schemaVersion: 1;
    kind: 'task-strategy-red-revision-journal.v1';
    journalDigest: string;
    previousJournalDigest: string | null;
  },
>(
  journal: T,
): Omit<
  T,
  'schemaVersion' | 'kind' | 'journalDigest' | 'previousJournalDigest'
> {
  const {
    schemaVersion: _schemaVersion,
    kind: _kind,
    journalDigest: _journalDigest,
    previousJournalDigest: _previousJournalDigest,
    ...state
  } = journal;
  return state;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code;
}
