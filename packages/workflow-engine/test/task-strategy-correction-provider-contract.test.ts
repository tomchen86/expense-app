import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import type {
  CheckEvidence,
  ObservedCheckFailure,
} from '../src/check-runner.ts';
import { prepareTaskStrategyGreenFailureRecord } from '../src/task-strategy-correction-store.ts';
import {
  assertTaskStrategyImplementationManifest,
  assertTaskStrategyImplementationSubject,
  createTaskStrategyCorrectionSubject,
  createTaskStrategyImplementationManifest,
  createTaskStrategyImplementationSubject,
} from '../src/task-strategy-provider-contract.ts';

const SESSION_ID =
  'session-20260813000000000-00000000-0000-4000-8000-000000000001';
const BASE_COMMIT = 'a'.repeat(40);
const BASE_TREE = 'b'.repeat(40);
const RED_TREE = 'c'.repeat(40);

test('legacy initial implementation subjects and manifests keep their exact byte schema', () => {
  const subject = initialSubject();
  const manifest = initialManifest(subject);

  assert.deepEqual(Object.keys(subject).sort(), [
    'changeId',
    'failureFingerprint',
    'fixturePaths',
    'frozenFiles',
    'kind',
    'redEvidenceNodeId',
    'redEvidenceResultDigest',
    'schemaVersion',
    'sessionId',
    'sourceTree',
    'strategy',
    'subjectDigest',
    'taskContractDigest',
    'taskId',
    'testPaths',
    'transactionDigest',
  ]);
  assert.deepEqual(Object.keys(manifest).sort(), [
    'baseCommit',
    'baseTree',
    'behaviorContractRefs',
    'capabilityProfile',
    'implementationPathScopes',
    'kind',
    'repositoryId',
    'schemaVersion',
    'subject',
  ]);
  assert.equal('correction' in subject, false);
  assert.equal('greenFailureRecord' in manifest, false);
  assert.deepEqual(assertTaskStrategyImplementationSubject(subject), subject);
  assert.deepEqual(
    assertTaskStrategyImplementationManifest(manifest),
    manifest,
  );
});

test('a correction subject and manifest bind one exact bounded GREEN failure', () => {
  const initial = initialSubject();
  const failure = greenFailureRecord('candidate-one');
  const subject = createTaskStrategyCorrectionSubject({
    subject: initial,
    round: 1,
    greenFailureRecord: failure,
  });
  const manifest = createTaskStrategyImplementationManifest({
    ...manifestInput(subject),
    greenFailureRecord: failure,
  });

  assert.equal(subject.sourceTree, failure.candidateTree);
  assert.equal(subject.failureFingerprint, initial.failureFingerprint);
  assert.deepEqual(subject.correction, {
    round: 1,
    greenFailureRecordDigest: failure.recordDigest,
    greenFailureSubjectDigest: failure.subjectDigest,
    candidateTree: failure.candidateTree,
    failingCheckFingerprint: failure.failingCheck.failureFingerprint,
    currentPatchHead: failure.currentPatchHead,
  });
  assert.deepEqual(manifest.greenFailureRecord, failure);
  assert.deepEqual(assertTaskStrategyImplementationSubject(subject), subject);
  assert.deepEqual(
    assertTaskStrategyImplementationManifest(manifest),
    manifest,
  );
});

test('correction manifests fail closed on missing, surplus, or mismatched failure evidence', () => {
  const initial = initialSubject();
  const firstFailure = greenFailureRecord('candidate-one');
  const secondFailure = greenFailureRecord('candidate-two');
  const correction = createTaskStrategyCorrectionSubject({
    subject: initial,
    round: 1,
    greenFailureRecord: firstFailure,
  });

  assert.throws(() =>
    assertTaskStrategyImplementationManifest({
      ...initialManifest(initial),
      greenFailureRecord: firstFailure,
    }),
  );
  assert.throws(() =>
    assertTaskStrategyImplementationManifest({
      ...initialManifest(correction),
    }),
  );
  assert.throws(() =>
    assertTaskStrategyImplementationManifest({
      ...initialManifest(correction),
      greenFailureRecord: secondFailure,
    }),
  );

  const invalidRoundBody = {
    ...withoutSubjectDigest(correction),
    correction: {
      ...correction.correction!,
      round: 0,
    },
  };
  assert.throws(() =>
    assertTaskStrategyImplementationSubject({
      ...invalidRoundBody,
      subjectDigest: digest(canonicalJson(invalidRoundBody)),
    }),
  );

  const wrongSourceTreeBody = {
    ...withoutSubjectDigest(correction),
    sourceTree: RED_TREE,
  };
  assert.throws(() =>
    assertTaskStrategyImplementationSubject({
      ...wrongSourceTreeBody,
      subjectDigest: digest(canonicalJson(wrongSourceTreeBody)),
    }),
  );
});

function initialSubject() {
  return createTaskStrategyImplementationSubject({
    sessionId: SESSION_ID,
    changeId: 'demo-change',
    taskId: '1.1',
    strategy: 'cross-agent-tdd',
    transactionDigest: digest('red-transaction'),
    taskContractDigest: digest('task-contract'),
    sourceTree: RED_TREE,
    failureFingerprint: digest('red-failure'),
    redEvidenceNodeId: digest('red-node'),
    redEvidenceResultDigest: digest('red-result'),
    testPaths: ['test/feature.test.mjs'],
    fixturePaths: [],
    frozenFiles: [
      {
        path: 'test/feature.test.mjs',
        mode: '100644',
        objectId: 'd'.repeat(40),
      },
    ],
  });
}

function initialManifest(subject: ReturnType<typeof initialSubject>) {
  return createTaskStrategyImplementationManifest(manifestInput(subject));
}

function manifestInput(subject: ReturnType<typeof initialSubject>) {
  return {
    repositoryId: 'expense-app',
    baseCommit: BASE_COMMIT,
    baseTree: BASE_TREE,
    subject,
    behaviorContractRefs: [
      {
        specPath: 'specs/demo/spec.md',
        requirement: 'Demo behavior',
        scenario: 'Demo succeeds',
      },
    ],
    implementationPathScopes: ['src/**'],
  };
}

function greenFailureRecord(label: string) {
  const passedCheck: CheckEvidence = {
    checkId: 'lint',
    outcome: 'passed',
    exitCode: 0,
    runner: 'node',
    runnerDigest: digest('lint-runner'),
    destructiveDatabase: false,
  };
  const failureBody = {
    checkId: 'test',
    outcome: 'failed' as const,
    exitCode: 1,
    runner: 'node',
    runnerDigest: digest('test-runner'),
    stdoutDigest: digest(`${label}-stdout`),
    stderrDigest: digest(''),
    stdoutExcerpt: 'one test failed',
    stderrExcerpt: '',
    stdoutTruncated: true,
    stderrTruncated: false,
  };
  const failingCheck: ObservedCheckFailure = {
    ...failureBody,
    failureFingerprint: digest(canonicalJson(failureBody)),
  };
  return prepareTaskStrategyGreenFailureRecord({
    sessionId: SESSION_ID,
    currentRedTransactionDigest: digest('red-transaction'),
    currentPatchHead: {
      bindingDigest: digest(`${label}-patch-binding`),
      recordDigest: digest(`${label}-patch-record`),
      patchDigest: digest(`${label}-patch`),
      receiptDigest: digest(`${label}-patch-receipt`),
    },
    candidateTree: label === 'candidate-one' ? '1'.repeat(40) : '2'.repeat(40),
    checkDefinitions: [
      {
        checkId: 'lint',
        definition: {
          command: ['node', 'scripts/lint.mjs'],
          destructiveDatabase: false,
        },
        runner: 'node',
        runnerDigest: passedCheck.runnerDigest,
      },
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
    passedChecks: [passedCheck],
    failingCheck,
    createdAt: '2026-08-13T00:00:00.000Z',
  });
}

function withoutSubjectDigest(
  subject: ReturnType<typeof initialSubject>,
): Omit<typeof subject, 'subjectDigest'> {
  const { subjectDigest: _subjectDigest, ...body } = subject;
  return body;
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
