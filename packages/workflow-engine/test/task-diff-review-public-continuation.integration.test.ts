import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { loadWorkflowConfig } from '../src/adapters/consumer/expense-app/work-registry/contracts.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { renderHandoff } from '../src/adapters/consumer/expense-app/handoff/handoff.ts';
import { finalizeTask } from '../src/application/finalize/lifecycle.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import { readProviderInvocation } from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import {
  assertCurrentTaskDiffReviewSatisfied,
  beginTaskDiffReview,
  inspectTaskDiffReviewStatus,
  reconcileTaskDiffReview,
} from '../src/application/finalize/task-diff-review-lifecycle.ts';
import { parseTaskDiffReviewChallengeResponseInput } from '../src/modules/assurance/task-diff-review-input.ts';
import { readTaskDiffFinalAssuranceBinding } from '../src/runtime/storage-journal/task-diff-review-store.ts';
import {
  TASK_DIFF_REVIEW_COVERAGE,
  type TaskDiffReviewSubject,
} from '../src/modules/assurance/task-diff-review.ts';
import type {
  TaskDiffReviewContinuationSubmission,
  TaskDiffReviewSubmission,
} from '../src/modules/assurance/task-diff-review-artifact.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  runtimeRoot,
  sourceRepositoryRoot,
  writeReadyV2ExemptChange,
} from './fixture.ts';

test('public challenge response input cannot claim closure authority', () => {
  const digest = 'a'.repeat(64);
  const response = {
    challengeId: digest,
    rationale: 'Exact candidate evidence answers the challenge.',
    evidence: [],
  };
  assert.throws(
    () =>
      parseTaskDiffReviewChallengeResponseInput({
        schemaVersion: 1,
        kind: 'task-diff-review-challenge-response-input.v1',
        reviewRecordDigest: digest,
        responses: [response],
        closedBy: 'caller',
      }),
    hasCode('TASK_DIFF_REVIEW_RESPONSE_INPUT_INVALID'),
  );
  assert.throws(
    () =>
      parseTaskDiffReviewChallengeResponseInput({
        schemaVersion: 1,
        kind: 'task-diff-review-challenge-response-input.v1',
        reviewRecordDigest: digest,
        responses: [{ ...response, disposition: 'rebutted' }],
      }),
    hasCode('TASK_DIFF_REVIEW_RESPONSE_INPUT_INVALID'),
  );
});

test('review-diff publicly journals and resumes authenticated provider challenge continuation', () => {
  const repository = createReviewFixture();
  const inputRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-diff-review-continuation-input-'),
  );
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = true;\n',
    );
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );

    const prepared = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(prepared.state, 'waiting-for-provider');
    if (prepared.state !== 'waiting-for-provider') {
      assert.fail('expected initial provider review');
    }
    const reviewedBlobObjectId = candidateBlob(
      prepared.subject,
      'src/feature.ts',
    );
    const challenged = challengedSubmission(
      reviewedBlobObjectId,
      prepared.subject,
    );
    completeFakeProvider(
      repository,
      prepared.invocationId,
      challenged,
      prepared.subject.subjectDigest,
    );
    const reviewed = reconcileTaskDiffReview(repository, session.sessionId);
    assert.equal(reviewed.state, 'challenge-response-required');
    if (reviewed.state !== 'challenge-response-required') {
      assert.fail('expected a challenge response');
    }

    const responseInput = {
      schemaVersion: 1 as const,
      kind: 'task-diff-review-challenge-response-input.v1' as const,
      reviewRecordDigest: reviewed.review.recordDigest,
      responses: reviewed.review.challenges.map((challenge) => ({
        challengeId: challenge.challengeId,
        rationale:
          'The exact checked candidate and its engine-run evidence answer this challenge.',
        evidence: [challenge.evidence[0]!],
      })),
    };
    const inputPath = path.join(inputRoot, 'response.json');
    fs.writeFileSync(inputPath, `${JSON.stringify(responseInput, null, 2)}\n`);

    const beforeResponseStatus = snapshotRepositoryObservation(repository);
    const responseRequired = runCli(repository, [
      'review-diff',
      'status',
      session.sessionId,
      '--json',
    ]);
    assert.equal(responseRequired.status, 0, responseRequired.stderr);
    assert.equal(
      cliResult(responseRequired).state,
      'challenge-response-required',
    );
    assert.deepEqual(
      snapshotRepositoryObservation(repository),
      beforeResponseStatus,
    );

    const started = runCli(
      repository,
      ['review-diff', session.sessionId, '--input', inputPath, '--json'],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(started.status, 0, started.stderr);
    const waiting = cliResult(started);
    assert.equal(waiting.state, 'waiting-for-provider');
    assert.equal(
      waiting.response?.reviewRecordDigest,
      reviewed.review.recordDigest,
    );
    assert.ok(waiting.invocationId);
    const continuationInvocationId = waiting.invocationId;

    const replayedInput = runCli(
      repository,
      ['review-diff', session.sessionId, '--input', inputPath, '--json'],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(replayedInput.status, 0, replayedInput.stderr);
    assert.equal(cliResult(replayedInput).state, 'waiting-for-provider');
    assert.equal(
      cliResult(replayedInput).invocationId,
      continuationInvocationId,
    );

    const waitingReconcile = runCli(repository, [
      'review-diff',
      'reconcile',
      session.sessionId,
      '--json',
    ]);
    assert.equal(waitingReconcile.status, 0, waitingReconcile.stderr);
    assert.equal(cliResult(waitingReconcile).state, 'waiting-for-provider');
    assert.equal(
      cliResult(waitingReconcile).invocationId,
      continuationInvocationId,
    );

    const beforeWaitingStatus = snapshotRepositoryObservation(repository);
    const waitingStatus = runCli(repository, [
      'review-diff',
      'status',
      session.sessionId,
      '--json',
    ]);
    assert.equal(waitingStatus.status, 0, waitingStatus.stderr);
    assert.equal(cliResult(waitingStatus).state, 'waiting-for-provider');
    assert.equal(
      cliResult(waitingStatus).invocationId,
      continuationInvocationId,
    );
    assert.deepEqual(
      snapshotRepositoryObservation(repository),
      beforeWaitingStatus,
    );

    const responseDigest = waiting.response?.responseDigest;
    assert.ok(responseDigest);
    const continuationOutput: TaskDiffReviewContinuationSubmission = {
      schemaVersion: 1,
      reviewRecordDigest: reviewed.review.recordDigest,
      responseDigest,
      proposedDispositions: reviewed.review.challenges.map((challenge) => ({
        challengeId: challenge.challengeId,
        decision: 'rebutted',
        rationale:
          'The subject-bound response and engine evidence rebut the challenge.',
        supersededBy: null,
      })),
    };
    completeFakeProvider(
      repository,
      continuationInvocationId!,
      continuationOutput,
      reviewed.subject.subjectDigest,
    );

    const beforeSucceededStatus = snapshotRepositoryObservation(repository);
    const succeededStatus = runCli(repository, [
      'review-diff',
      'status',
      session.sessionId,
      '--json',
    ]);
    assert.equal(succeededStatus.status, 0, succeededStatus.stderr);
    assert.equal(
      cliResult(succeededStatus).state,
      'provider-succeeded-awaiting-reconciliation',
    );
    assert.deepEqual(
      snapshotRepositoryObservation(repository),
      beforeSucceededStatus,
    );
    assert.equal(
      readTaskDiffFinalAssuranceBinding(
        investigationRuntime(repository),
        reviewed.subject.subjectDigest,
      ),
      null,
    );
    assert.throws(
      () => assertCurrentTaskDiffReviewSatisfied(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_CHALLENGE_OPEN'),
    );
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_CHALLENGE_OPEN'),
    );

    const reconciled = runCli(
      repository,
      ['review-diff', session.sessionId, '--json'],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(reconciled.status, 0, reconciled.stderr);
    const satisfied = cliResult(reconciled);
    assert.equal(satisfied.state, 'satisfied');
    assert.equal(satisfied.finalAssurance?.verdict, 'satisfied');
    const commitmentDigest = satisfied.finalAssurance?.commitmentDigest;
    assert.ok(commitmentDigest);

    const reconcileReplay = runCli(repository, [
      'review-diff',
      'reconcile',
      session.sessionId,
      '--json',
    ]);
    assert.equal(reconcileReplay.status, 0, reconcileReplay.stderr);
    assert.equal(
      cliResult(reconcileReplay).finalAssurance?.commitmentDigest,
      commitmentDigest,
    );
    const inputReplay = runCli(
      repository,
      ['review-diff', session.sessionId, '--input', inputPath, '--json'],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(inputReplay.status, 0, inputReplay.stderr);
    assert.equal(
      cliResult(inputReplay).finalAssurance?.commitmentDigest,
      commitmentDigest,
    );
    assert.equal(
      readProviderInvocation(
        investigationRuntime(repository),
        continuationInvocationId!,
      ).state,
      'succeeded',
    );

    const beforeFinalStatus = snapshotRepositoryObservation(repository);
    assert.equal(
      inspectTaskDiffReviewStatus(repository, session.sessionId).state,
      'satisfied',
    );
    assert.deepEqual(
      snapshotRepositoryObservation(repository),
      beforeFinalStatus,
    );
  } finally {
    fs.rmSync(inputRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createReviewFixture(): string {
  const repository = createFixtureRepository();
  const documentPolicyPath = path.join(
    repository,
    'workflow/document-policy.json',
  );
  const documentPolicy = JSON.parse(
    fs.readFileSync(documentPolicyPath, 'utf8'),
  ) as { documents: Record<string, unknown> };
  documentPolicy.documents['docs/CURRENT_AND_NEXT_STEPS.md'] = {
    mode: 'generated',
    enforcement: 'active',
    transition: 'completion',
  };
  fs.writeFileSync(
    documentPolicyPath,
    `${JSON.stringify(documentPolicy, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
  renderHandoff(repository);
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/path-roles.json'),
    path.join(repository, 'workflow/path-roles.json'),
  );
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
    path.join(repository, 'workflow/maintainer-policy.json'),
  );
  configureChecks(
    repository,
    {
      fixture: {
        command: ['node', 'scripts/pass.mjs'],
        destructiveDatabase: false,
      },
    },
    ['fixture'],
  );
  git(repository, ['checkout', '-b', 'work/demo-change']);
  writeReadyV2ExemptChange(repository, 'demo-change', {
    diffReview: 'required',
  });
  commitPlanningTransition(repository, 'demo-change');
  return repository;
}

function challengedSubmission(
  blobObjectId: string,
  subject: TaskDiffReviewSubject,
): TaskDiffReviewSubmission {
  const evidence = [
    {
      kind: 'repository-location' as const,
      path: 'src/feature.ts',
      line: 1,
      blobObjectId,
      observation: 'The exact changed branch may violate the task invariant.',
    },
  ];
  return {
    schemaVersion: 1,
    verdict: 'advisory-reject',
    coverage: [...TASK_DIFF_REVIEW_COVERAGE],
    scopeAssessment: { kind: 'challenges' },
    findings: [
      {
        kind: 'challenge',
        severity: 'high',
        category: 'correctness-and-invariants',
        currentChangeImpact: 'required',
        summary: 'The changed branch may violate the task invariant.',
        evidence,
      },
    ],
    suggestions: [],
    riskPathDispositions: subject.reviewRequirement.riskPaths.map(
      ({ path, role }) => ({
        path,
        role: role as TaskDiffReviewSubmission['riskPathDispositions'][number]['role'],
        outcome: 'challenge-raised',
      }),
    ),
    residualRisk: 'The exact challenge requires an authenticated disposition.',
    uncertainty: 'Review is limited to the exact canonical candidate.',
  };
}

function completeFakeProvider(
  repository: string,
  invocationId: string,
  semanticOutput: unknown,
  subjectDigest: string,
) {
  return runProviderWorker(repository, invocationId, {
    runner(input) {
      writeFixtureProviderRuntime(input.invocationDirectory, semanticOutput);
      return {
        invocationId,
        providerId: input.request.providerId,
        purpose: 'task-diff-review',
        requestDigest: input.request.requestDigest,
        semanticOutput,
        semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
        assurance: 'unchanged-governed-projection',
        projection: {
          unchanged: true,
          changedCategories: [],
          beforeDigest: subjectDigest,
          afterDigest: subjectDigest,
        },
        sameUserProcessConfined: false,
        residuals: [...PROVIDER_RUNNER_RESIDUALS],
        executable: executableIdentity(),
        elapsedMs: 7,
      };
    },
  });
}

function candidateBlob(subject: TaskDiffReviewSubject, candidatePath: string) {
  const objectId = subject.transitions.find(
    ({ path: changedPath }) => changedPath === candidatePath,
  )?.after?.objectId;
  assert.ok(objectId);
  return objectId;
}

function cliResult(result: ReturnType<typeof runCli>): {
  state: string;
  invocationId?: string;
  response?: { responseDigest: string; reviewRecordDigest: string };
  finalAssurance?: { verdict: string; commitmentDigest: string } | null;
} {
  return (JSON.parse(result.stdout) as { result: never }).result;
}

function investigationRuntime(repository: string) {
  const discovered = discoverRepository(repository);
  const config = loadWorkflowConfig(discovered.repositoryRoot);
  return investigationRuntimePaths(
    discovered.gitCommonDirectory,
    config.runtimeDirectory,
  );
}

function runCli(
  repository: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.resolve(import.meta.dirname, '../src/cli.ts'),
      ...args,
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env, ...environment },
    },
  );
}

function writeFixtureProviderRuntime(
  invocationDirectory: string,
  semanticOutput: unknown,
): void {
  const runtime = path.join(invocationDirectory, 'runtime');
  fs.mkdirSync(runtime, { mode: 0o700 });
  for (const [name, content] of [
    ['prompt.json', '{}\n'],
    ['schema.json', '{}\n'],
    ['semantic-output.json', `${canonicalJson(semanticOutput)}\n`],
  ] as const) {
    fs.writeFileSync(path.join(runtime, name), content, { mode: 0o600 });
  }
}

function executableIdentity() {
  return {
    candidatePath: '/opt/homebrew/bin/claude',
    realPath: '/opt/homebrew/bin/claude',
    device: '1',
    inode: '2',
    mode: 0o100755,
    uid: 501,
    gid: 20,
    size: 1024,
    mtimeNs: '123456789',
    sha256: 'b'.repeat(64),
  };
}

function snapshotRepositoryObservation(repository: string) {
  const root = runtimeRoot(repository);
  return {
    status: git(repository, ['status', '--porcelain=v2', '-z']),
    runtime: fs
      .readdirSync(root, { recursive: true, encoding: 'utf8' })
      .map(String)
      .sort()
      .filter((relativePath) =>
        fs.lstatSync(path.join(root, relativePath)).isFile(),
      )
      .map(
        (relativePath) =>
          [
            relativePath,
            fs.readFileSync(path.join(root, relativePath), 'hex'),
          ] as const,
      ),
  };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code;
}
