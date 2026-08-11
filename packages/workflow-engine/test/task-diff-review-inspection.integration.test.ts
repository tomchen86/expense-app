import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import { issueCollaborationGrant } from '../src/collaboration-grant.ts';
import { inspectCollaborationGrants } from '../src/collaboration-grant-store.ts';
import { loadWorkflowConfig } from '../src/contracts.ts';
import { discoverRepository } from '../src/git.ts';
import { renderHandoff } from '../src/handoff.ts';
import { completeTask, finalizeTask, finishSession } from '../src/lifecycle.ts';
import {
  verifySshSignatureWithPublicKey,
  type MaintainerSignerProvider,
} from '../src/maintainer-signer.ts';
import { investigationRuntimePaths } from '../src/paths.ts';
import { commitPlanningTransition } from '../src/planning-transition.ts';
import {
  claimProviderInvocation,
  completeProviderInvocation,
  providerInvocationManifestDigest,
  readProviderInvocation,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
} from '../src/provider-invocation-store.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/provider-runner.ts';
import { runProviderWorker } from '../src/provider-worker.ts';
import { checkSession, startSession } from '../src/session.ts';
import {
  assertCurrentTaskDiffReviewSatisfied,
  beginTaskDiffReviewContinuation,
  beginTaskDiffReview,
  inspectTaskDiffReviewStatus,
  inspectTaskDiffReviewSubject,
  reconcileTaskDiffReviewContinuation,
  reconcileTaskDiffReview,
} from '../src/task-diff-review-lifecycle.ts';
import {
  createTaskDiffReviewChallengeResponse,
  type TaskDiffReviewSubmission,
} from '../src/task-diff-review-artifact.ts';
import { TASK_DIFF_REVIEW_COVERAGE } from '../src/task-diff-review.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  runtimeRoot,
  sourceRepositoryRoot,
  writeReadyV2ExemptChange,
} from './fixture.ts';

test('review-diff inspect derives one exact checked candidate subject without rerunning checks', () => {
  const { repository, counterPath } = createReviewFixture();
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = true;\n',
    );
    fs.chmodSync(path.join(repository, 'src/feature.ts'), 0o755);

    assert.throws(
      () =>
        finalizeTask(repository, session.sessionId, process.env, {
          testCrashAfter: 'checked',
        }),
      /Simulated finalize interruption/,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    const first = inspectTaskDiffReviewSubject(repository, session.sessionId);
    const replay = inspectTaskDiffReviewSubject(repository, session.sessionId);
    assert.deepEqual(replay, first);
    assert.equal(first.changeId, 'demo-change');
    assert.equal(first.taskId, '1.1');
    assert.equal(first.repositoryId, 'github:R_kgDOOotVag');
    assert.equal(first.reviewRequirement.required, true);
    assert.equal(first.reviewRequirement.basis, 'risk-role');
    assert.match(first.subjectDigest, /^[0-9a-f]{64}$/);
    assert.match(first.checkEvidenceDigest, /^[0-9a-f]{64}$/);
    assert.match(first.taskContractDigest, /^[0-9a-f]{64}$/);
    assert.match(first.requiredCheckPolicyDigest, /^[0-9a-f]{64}$/);
    const transaction = JSON.parse(
      fs.readFileSync(
        path.join(
          runtimeRoot(repository),
          'finalize-transactions',
          `${session.sessionId}.json`,
        ),
        'utf8',
      ),
    ) as { candidateTree: string };
    assert.equal(first.candidateTree, transaction.candidateTree);
    assert.deepEqual(
      first.transitions.find(
        ({ path: changedPath }) => changedPath === 'src/feature.ts',
      ),
      {
        path: 'src/feature.ts',
        before: null,
        after: {
          mode: '100755',
          objectId: git(repository, [
            'rev-parse',
            `${first.candidateTree}:src/feature.ts`,
          ]).trim(),
        },
      },
    );

    const inspected = runCli(repository, [
      'review-diff',
      'inspect',
      session.sessionId,
      '--json',
    ]);
    assert.equal(inspected.status, 0, inspected.stderr);
    assert.deepEqual(
      (JSON.parse(inspected.stdout) as { result: unknown }).result,
      first,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = false;\n',
    );
    assert.throws(
      () => inspectTaskDiffReviewSubject(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_CANDIDATE_DIVERGED'),
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('review-diff inspect is unavailable before checks freeze a candidate', () => {
  const { repository } = createReviewFixture();
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    assert.throws(
      () => inspectTaskDiffReviewSubject(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_NOT_READY'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('review-diff lifecycle binds a fresh provider reviewer to the exact WorkflowSession and adopts only its fixed-runner result', () => {
  const { repository, counterPath } = createReviewFixture();
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = true;\n',
    );
    assert.throws(
      () =>
        finalizeTask(repository, session.sessionId, process.env, {
          testCrashAfter: 'checked',
        }),
      /Simulated finalize interruption/,
    );

    const prepared = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(prepared.state, 'waiting-for-provider');
    assert.equal(prepared.sessionId, session.sessionId);
    assert.equal(prepared.implementationActor.providerId, 'codex');
    assert.equal(
      prepared.implementationActor.identityAssurance,
      'self-declared',
    );
    assert.equal(prepared.assignment.providerId, 'claude');
    assert.equal(prepared.assignment.role, 'task-diff-reviewer');
    assert.equal(
      prepared.assignment.targetDigest,
      prepared.subject.subjectDigest,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    const replay = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.deepEqual(replay, prepared);

    const runtime = investigationRuntime(repository);
    const request = readProviderInvocationRequest(
      runtime,
      prepared.invocationId,
    );
    const manifest = readProviderInvocationManifest(
      runtime,
      prepared.invocationId,
    );
    assert.equal(request.purpose, 'task-diff-review');
    assert.equal(request.writeAllowedPaths.length, 0);
    assert.equal(request.targetDigest, prepared.subject.subjectDigest);
    assert.equal(
      providerInvocationManifestDigest(manifest),
      request.inputManifestDigest,
    );
    assert.equal(
      readProviderInvocation(runtime, prepared.invocationId).state,
      'prepared',
    );

    const reviewedBlobObjectId = prepared.subject.transitions.find(
      ({ path: changedPath }) => changedPath === 'src/feature.ts',
    )?.after?.objectId;
    assert.ok(reviewedBlobObjectId);
    const submission = validTaskDiffSubmission(reviewedBlobObjectId);
    const worker = runProviderWorker(repository, prepared.invocationId, {
      runner(input) {
        return {
          invocationId: prepared.invocationId,
          providerId: 'claude',
          purpose: 'task-diff-review',
          requestDigest: input.request.requestDigest,
          semanticOutput: submission,
          semanticOutputDigest: sha256(canonicalJson(submission)),
          assurance: 'unchanged-governed-projection',
          projection: {
            unchanged: true,
            changedCategories: [],
            beforeDigest: prepared.subject.subjectDigest,
            afterDigest: prepared.subject.subjectDigest,
          },
          sameUserProcessConfined: false,
          residuals: [...PROVIDER_RUNNER_RESIDUALS],
          executable: executableIdentity(),
          elapsedMs: 7,
        };
      },
    });
    assert.equal(worker.state, 'succeeded');

    const reviewed = reconcileTaskDiffReview(repository, session.sessionId);
    assert.equal(reviewed.state, 'satisfied');
    assert.equal(reviewed.review.subjectDigest, prepared.subject.subjectDigest);
    assert.equal(reviewed.review.assignment.implementerProviderId, 'codex');
    assert.equal(reviewed.review.assignment.reviewerProviderId, 'claude');
    assert.deepEqual(
      assertCurrentTaskDiffReviewSatisfied(repository, session.sessionId),
      reviewed.review,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('review-diff refuses an evaluator-only result without a fixed-runner observation', () => {
  const { repository } = createReviewFixture();
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = true;\n',
    );
    assert.throws(
      () =>
        finalizeTask(repository, session.sessionId, process.env, {
          testCrashAfter: 'checked',
        }),
      /Simulated finalize interruption/,
    );
    const prepared = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(prepared.state, 'waiting-for-provider');
    const runtime = investigationRuntime(repository);
    const request = readProviderInvocationRequest(
      runtime,
      prepared.invocationId,
    );
    const reviewedBlobObjectId = prepared.subject.transitions.find(
      ({ path: changedPath }) => changedPath === 'src/feature.ts',
    )?.after?.objectId;
    assert.ok(reviewedBlobObjectId);
    const claim = claimProviderInvocation(runtime, prepared.invocationId, {
      workerId: 'task-diff-review-evaluator-only',
      leaseDurationMs: 60_000,
    });
    completeProviderInvocation(runtime, prepared.invocationId, {
      expectedRevision: claim.record.revision,
      leaseGeneration: claim.record.leaseGeneration,
      leaseToken: claim.leaseToken,
      outcome: {
        exitCode: 0,
        signal: null,
        timedOut: false,
        spawnErrorCode: null,
        elapsedMs: 1,
        stdout: JSON.stringify(
          providerWireResult(
            request,
            validTaskDiffSubmission(reviewedBlobObjectId),
          ),
        ),
        stderr: '',
      },
    });
    assert.throws(
      () => reconcileTaskDiffReview(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_PROVIDER_OBSERVATION_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('review-diff provider worker refuses a candidate that changed after reservation before claiming it', () => {
  const { repository } = createReviewFixture();
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = true;\n',
    );
    assert.throws(
      () =>
        finalizeTask(repository, session.sessionId, process.env, {
          testCrashAfter: 'checked',
        }),
      /Simulated finalize interruption/,
    );
    const prepared = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(prepared.state, 'waiting-for-provider');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = false;\n',
    );
    let launched = false;
    assert.throws(
      () =>
        runProviderWorker(repository, prepared.invocationId, {
          runner() {
            launched = true;
            throw new Error('must not launch');
          },
        }),
      hasCode('TASK_DIFF_REVIEW_CANDIDATE_DIVERGED'),
    );
    assert.equal(launched, false);
    assert.equal(
      readProviderInvocation(
        investigationRuntime(repository),
        prepared.invocationId,
      ).state,
      'prepared',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('finalize pauses before staging for a required review and resumes without rerunning checks after the exact result is adopted', () => {
  const { repository, counterPath } = createReviewFixture();
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
    const transaction = JSON.parse(
      fs.readFileSync(
        path.join(
          runtimeRoot(repository),
          'finalize-transactions',
          `${session.sessionId}.json`,
        ),
        'utf8',
      ),
    ) as { phase: string; previousIndexTree: string };
    assert.equal(transaction.phase, 'checked');
    assert.equal(
      git(repository, ['write-tree']).trim(),
      transaction.previousIndexTree,
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');

    const prepared = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(prepared.state, 'waiting-for-provider');
    const reviewedBlobObjectId = prepared.subject.transitions.find(
      ({ path: changedPath }) => changedPath === 'src/feature.ts',
    )?.after?.objectId;
    assert.ok(reviewedBlobObjectId);
    const submission = validTaskDiffSubmission(reviewedBlobObjectId);
    assert.equal(
      runProviderWorker(repository, prepared.invocationId, {
        runner(input) {
          return {
            invocationId: prepared.invocationId,
            providerId: 'claude',
            purpose: 'task-diff-review',
            requestDigest: input.request.requestDigest,
            semanticOutput: submission,
            semanticOutputDigest: sha256(canonicalJson(submission)),
            assurance: 'unchanged-governed-projection',
            projection: {
              unchanged: true,
              changedCategories: [],
              beforeDigest: prepared.subject.subjectDigest,
              afterDigest: prepared.subject.subjectDigest,
            },
            sameUserProcessConfined: false,
            residuals: [...PROVIDER_RUNNER_RESIDUALS],
            executable: executableIdentity(),
            elapsedMs: 7,
          };
        },
      }).state,
      'succeeded',
    );
    assert.equal(
      reconcileTaskDiffReview(repository, session.sessionId).state,
      'satisfied',
    );

    const finalized = finalizeTask(repository, session.sessionId);
    assert.equal(finalized.session.finishReportId, finalized.finishReportId);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a corrected candidate receives a distinct immutable TaskDiffReview generation in the same WorkflowSession', () => {
  const { repository, counterPath } = createReviewFixture();
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
    const first = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(first.state, 'waiting-for-provider');

    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = false;\n',
    );
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('FINALIZE_TRANSACTION_DIVERGED'),
    );
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
    const second = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(second.state, 'waiting-for-provider');
    assert.notEqual(second.subject.subjectDigest, first.subject.subjectDigest);
    assert.notEqual(second.invocationId, first.invocationId);
    assert.equal(
      readProviderInvocation(
        investigationRuntime(repository),
        first.invocationId,
      ).state,
      'prepared',
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '2');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('review-diff CLI resumes the durable happy path from ready through fixed-runner reconciliation', () => {
  const { repository, counterPath } = createReviewFixture();
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

    const ready = runCli(repository, [
      'review-diff',
      'status',
      session.sessionId,
      '--json',
    ]);
    assert.equal(ready.status, 0, ready.stderr);
    assert.equal(
      (JSON.parse(ready.stdout) as { result: { state: string } }).result.state,
      'ready',
    );

    const started = runCli(
      repository,
      ['review-diff', session.sessionId, '--actor', 'codex', '--json'],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(started.status, 0, started.stderr);
    const startedResult = (
      JSON.parse(started.stdout) as {
        result: {
          state: string;
          invocationId: string;
          subject: { subjectDigest: string; transitions: unknown[] };
        };
      }
    ).result;
    assert.equal(startedResult.state, 'waiting-for-provider');
    assert.equal(
      readProviderInvocation(
        investigationRuntime(repository),
        startedResult.invocationId,
      ).state,
      'prepared',
    );

    const reviewedBlobObjectId = (
      startedResult.subject.transitions as Array<{
        path: string;
        after: { objectId: string } | null;
      }>
    ).find(({ path: changedPath }) => changedPath === 'src/feature.ts')?.after
      ?.objectId;
    assert.ok(reviewedBlobObjectId);
    const submission = validTaskDiffSubmission(reviewedBlobObjectId);
    assert.equal(
      runProviderWorker(repository, startedResult.invocationId, {
        runner(input) {
          return {
            invocationId: startedResult.invocationId,
            providerId: 'claude',
            purpose: 'task-diff-review',
            requestDigest: input.request.requestDigest,
            semanticOutput: submission,
            semanticOutputDigest: sha256(canonicalJson(submission)),
            assurance: 'unchanged-governed-projection',
            projection: {
              unchanged: true,
              changedCategories: [],
              beforeDigest: startedResult.subject.subjectDigest,
              afterDigest: startedResult.subject.subjectDigest,
            },
            sameUserProcessConfined: false,
            residuals: [...PROVIDER_RUNNER_RESIDUALS],
            executable: executableIdentity(),
            elapsedMs: 7,
          };
        },
      }).state,
      'succeeded',
    );

    const awaiting = runCli(repository, [
      'review-diff',
      'status',
      session.sessionId,
      '--json',
    ]);
    assert.equal(awaiting.status, 0, awaiting.stderr);
    assert.equal(
      (JSON.parse(awaiting.stdout) as { result: { state: string } }).result
        .state,
      'provider-succeeded-awaiting-reconciliation',
    );
    const resumed = runCli(repository, [
      'review-diff',
      session.sessionId,
      '--actor',
      'codex',
      '--json',
    ]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(
      (JSON.parse(resumed.stdout) as { result: { state: string } }).result
        .state,
      'satisfied',
    );
    const finalized = finalizeTask(repository, session.sessionId);
    assert.equal(finalized.session.finishReportId, finalized.finishReportId);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('advisory dispositions cannot close a challenge until the shared verifier mints Final Assurance', () => {
  const { repository, counterPath } = createReviewFixture();
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
    const blobObjectId = prepared.subject.transitions.find(
      ({ path: changedPath }) => changedPath === 'src/feature.ts',
    )?.after?.objectId;
    assert.ok(blobObjectId);
    const challenged = challengedTaskDiffSubmission(blobObjectId);
    assert.equal(
      runProviderWorker(repository, prepared.invocationId, {
        runner(input) {
          writeFixtureProviderRuntime(input.invocationDirectory, challenged);
          return {
            invocationId: prepared.invocationId,
            providerId: 'claude',
            purpose: 'task-diff-review',
            requestDigest: input.request.requestDigest,
            semanticOutput: challenged,
            semanticOutputDigest: sha256(canonicalJson(challenged)),
            assurance: 'unchanged-governed-projection',
            projection: {
              unchanged: true,
              changedCategories: [],
              beforeDigest: prepared.subject.subjectDigest,
              afterDigest: prepared.subject.subjectDigest,
            },
            sameUserProcessConfined: false,
            residuals: [...PROVIDER_RUNNER_RESIDUALS],
            executable: executableIdentity(),
            elapsedMs: 7,
          };
        },
      }).state,
      'succeeded',
    );
    const reviewed = reconcileTaskDiffReview(repository, session.sessionId);
    assert.equal(reviewed.state, 'challenge-response-required');
    assert.equal(reviewed.review.challenges.length, 1);
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_CHALLENGE_OPEN'),
    );

    const response = createTaskDiffReviewChallengeResponse({
      review: reviewed.review,
      responses: reviewed.review.challenges.map((challenge) => ({
        challengeId: challenge.challengeId,
        rationale:
          'The exact checked candidate and passing check evidence answer the challenge.',
        evidence: [challenge.evidence[0]!],
      })),
    });
    const continuation = beginTaskDiffReviewContinuation(
      repository,
      session.sessionId,
      response,
    );
    assert.equal(continuation.state, 'waiting-for-provider');
    assert.equal(continuation.assignment.providerId, 'claude');
    assert.notEqual(
      continuation.assignment.sessionId,
      reviewed.assignment.sessionId,
    );
    const semanticOutput = {
      schemaVersion: 1 as const,
      reviewRecordDigest: reviewed.review.recordDigest,
      responseDigest: response.responseDigest,
      proposedDispositions: reviewed.review.challenges.map((challenge) => ({
        challengeId: challenge.challengeId,
        decision: 'rebutted' as const,
        rationale:
          'The bound response and candidate evidence rebut the challenge.',
        supersededBy: null,
      })),
    };
    const continuationResult = runProviderWorker(
      repository,
      continuation.invocationId,
      {
        runner(input) {
          writeFixtureProviderRuntime(
            input.invocationDirectory,
            semanticOutput,
          );
          return {
            invocationId: continuation.invocationId,
            providerId: 'claude',
            purpose: 'task-diff-review',
            requestDigest: input.request.requestDigest,
            semanticOutput,
            semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
            assurance: 'unchanged-governed-projection',
            projection: {
              unchanged: true,
              changedCategories: [],
              beforeDigest: prepared.subject.subjectDigest,
              afterDigest: prepared.subject.subjectDigest,
            },
            sameUserProcessConfined: false,
            residuals: [...PROVIDER_RUNNER_RESIDUALS],
            executable: executableIdentity(),
            elapsedMs: 7,
          };
        },
      },
    );
    assert.equal(
      continuationResult.state,
      'succeeded',
      JSON.stringify(continuationResult.failure),
    );
    assert.throws(
      () =>
        reconcileTaskDiffReviewContinuation(
          repository,
          session.sessionId,
          response.responseDigest,
          { testCrashAfter: 'advisory-result-persisted' },
        ),
      /Simulated TaskDiffReview continuation interruption/,
    );
    assert.equal(
      inspectTaskDiffReviewStatus(repository, session.sessionId).state,
      'challenge-closure-required',
    );
    assert.throws(
      () => assertCurrentTaskDiffReviewSatisfied(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_CHALLENGE_OPEN'),
    );
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_CHALLENGE_OPEN'),
    );

    const closed = reconcileTaskDiffReviewContinuation(
      repository,
      session.sessionId,
      response.responseDigest,
    );
    assert.equal(closed.state, 'satisfied');
    assert.equal(closed.finalAssurance?.verdict, 'satisfied');
    assert.equal(
      closed.finalAssurance?.subjectDigest,
      reviewed.subject.subjectDigest,
    );
    assert.equal(
      assertCurrentTaskDiffReviewSatisfied(repository, session.sessionId)
        ?.recordDigest,
      reviewed.review.recordDigest,
    );
    const finalized = finalizeTask(repository, session.sessionId);
    assert.equal(finalized.session.finishReportId, finalized.finishReportId);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('an accepted continuation decision requires a new candidate and never satisfies finalize', () => {
  const { repository } = createReviewFixture();
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
    const blobObjectId = prepared.subject.transitions.find(
      ({ path: changedPath }) => changedPath === 'src/feature.ts',
    )?.after?.objectId;
    assert.ok(blobObjectId);
    const challenged = challengedTaskDiffSubmission(blobObjectId);
    runProviderWorker(repository, prepared.invocationId, {
      runner(input) {
        writeFixtureProviderRuntime(input.invocationDirectory, challenged);
        return {
          invocationId: prepared.invocationId,
          providerId: 'claude',
          purpose: 'task-diff-review',
          requestDigest: input.request.requestDigest,
          semanticOutput: challenged,
          semanticOutputDigest: sha256(canonicalJson(challenged)),
          assurance: 'unchanged-governed-projection',
          projection: {
            unchanged: true,
            changedCategories: [],
            beforeDigest: prepared.subject.subjectDigest,
            afterDigest: prepared.subject.subjectDigest,
          },
          sameUserProcessConfined: false,
          residuals: [...PROVIDER_RUNNER_RESIDUALS],
          executable: executableIdentity(),
          elapsedMs: 7,
        };
      },
    });
    const reviewed = reconcileTaskDiffReview(repository, session.sessionId);
    if (!('review' in reviewed)) throw new Error('review required');
    const response = createTaskDiffReviewChallengeResponse({
      review: reviewed.review,
      responses: reviewed.review.challenges.map((challenge) => ({
        challengeId: challenge.challengeId,
        rationale: 'The challenge is accepted and the candidate must change.',
        evidence: [challenge.evidence[0]!],
      })),
    });
    const continuation = beginTaskDiffReviewContinuation(
      repository,
      session.sessionId,
      response,
    );
    const semanticOutput = {
      schemaVersion: 1 as const,
      reviewRecordDigest: reviewed.review.recordDigest,
      responseDigest: response.responseDigest,
      proposedDispositions: reviewed.review.challenges.map((challenge) => ({
        challengeId: challenge.challengeId,
        decision: 'accepted' as const,
        rationale: 'The candidate must change before completion.',
        supersededBy: null,
      })),
    };
    const continuationResult = runProviderWorker(
      repository,
      continuation.invocationId,
      {
        runner(input) {
          writeFixtureProviderRuntime(
            input.invocationDirectory,
            semanticOutput,
          );
          return {
            invocationId: continuation.invocationId,
            providerId: 'claude',
            purpose: 'task-diff-review',
            requestDigest: input.request.requestDigest,
            semanticOutput,
            semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
            assurance: 'unchanged-governed-projection',
            projection: {
              unchanged: true,
              changedCategories: [],
              beforeDigest: prepared.subject.subjectDigest,
              afterDigest: prepared.subject.subjectDigest,
            },
            sameUserProcessConfined: false,
            residuals: [...PROVIDER_RUNNER_RESIDUALS],
            executable: executableIdentity(),
            elapsedMs: 7,
          };
        },
      },
    );
    assert.equal(
      continuationResult.state,
      'succeeded',
      JSON.stringify(continuationResult.failure),
    );
    assert.equal(
      reconcileTaskDiffReviewContinuation(
        repository,
        session.sessionId,
        response.responseDigest,
      ).state,
      'changes-required',
    );
    assert.throws(
      () => assertCurrentTaskDiffReviewSatisfied(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_CHANGES_REQUIRED'),
    );
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_CHANGES_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('legacy complete-task refuses a review-required candidate instead of bypassing Final Assurance', () => {
  const { repository } = createReviewFixture();
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = true;\n',
    );
    checkSession(repository, session.sessionId);
    assert.throws(
      () => completeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('legacy finish re-evaluates the shared review predicate after completion projection', () => {
  const { repository } = createReviewFixture({
    configurePathRoles(registry) {
      registry.roles.ordinary.unshift('src/**');
      registry.roles['contract-surface'].push(
        'openspec/changes/demo-change/tasks.md',
      );
    },
  });
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = true;\n',
    );
    checkSession(repository, session.sessionId);
    completeTask(repository, session.sessionId);
    assert.throws(
      () => finishSession(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('review-diff shortage pauses with the existing typed collaboration-grant vocabulary', () => {
  const { repository } = createReviewFixture({
    configureAdapterPolicy(policy) {
      policy.providers.claude.enabled = false;
    },
  });
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
    const pausedCommand = runCli(
      repository,
      ['review-diff', session.sessionId, '--actor', 'codex', '--json'],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(pausedCommand.status, 0, pausedCommand.stderr);
    const paused = (
      JSON.parse(pausedCommand.stdout) as {
        result: ReturnType<typeof beginTaskDiffReview>;
      }
    ).result;
    assert.equal(paused.state, 'collaboration-grant-required');
    if (paused.state !== 'collaboration-grant-required') {
      assert.fail('expected typed TaskDiffReview collaboration-grant pause');
    }
    assert.equal(paused.inputSchema.lifecyclePhase, 'task-diff-review');
    assert.equal(paused.inputSchema.conflictingRole, 'task-diff-reviewer');
    assert.equal(
      paused.inputSchema.grantRequest?.degradedForm,
      'same-provider-fresh-session',
    );
    assert.equal(
      paused.inputSchema.grantRequest?.targetDigest,
      paused.subject.subjectDigest,
    );
    assert.equal(paused.inputSchema.resumeOption, '--grant <grant-id>');
    assert.equal(
      inspectTaskDiffReviewStatus(repository, session.sessionId).state,
      'ready',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('same-provider TaskDiffReview consumes one exact grant and satisfies the shared gate without a challenge', () => {
  const signing = createTaskDiffReviewSigningFixture();
  const { repository } = createReviewFixture({
    configureAdapterPolicy(policy) {
      policy.providers.claude.enabled = false;
    },
    configureMaintainerPolicy(policy) {
      policy.trustedSigners = [signing.trustedSigner];
    },
  });
  try {
    const repositoryOrigin = (
      JSON.parse(
        fs.readFileSync(
          path.join(repository, 'workflow/maintainer-policy.json'),
          'utf8',
        ),
      ) as { repository: { origin: string } }
    ).repository.origin;
    git(repository, ['remote', 'add', 'origin', repositoryOrigin]);
    const session = startSession(repository, 'demo-change', '1.1');
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const reviewed = true;\n',
    );
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
    const pausedCommand = runCli(
      repository,
      ['review-diff', session.sessionId, '--actor', 'codex', '--json'],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(pausedCommand.status, 0, pausedCommand.stderr);
    const paused = (
      JSON.parse(pausedCommand.stdout) as {
        result: ReturnType<typeof beginTaskDiffReview>;
      }
    ).result;
    assert.equal(paused.state, 'collaboration-grant-required');
    if (
      paused.state !== 'collaboration-grant-required' ||
      paused.inputSchema.grantRequest === null
    ) {
      assert.fail('expected an exact same-provider grant request');
    }
    const now = new Date();
    const grant = issueCollaborationGrant(
      repository,
      paused.inputSchema.grantRequest,
      {
        grantId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        now,
        signer: signing.signer,
      },
    );
    const replayedPauseCommand = runCli(
      repository,
      ['review-diff', session.sessionId, '--actor', 'codex', '--json'],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(replayedPauseCommand.status, 0, replayedPauseCommand.stderr);
    const replayedPause = (
      JSON.parse(replayedPauseCommand.stdout) as {
        result: ReturnType<typeof beginTaskDiffReview>;
      }
    ).result;
    assert.equal(replayedPause.state, 'collaboration-grant-required');
    if (replayedPause.state !== 'collaboration-grant-required') {
      assert.fail('expected the same durable TaskDiffReview pause');
    }
    assert.deepEqual(
      replayedPause.inputSchema.grantRequest,
      paused.inputSchema.grantRequest,
    );
    const started = runCli(
      repository,
      [
        'review-diff',
        session.sessionId,
        '--actor',
        'codex',
        '--grant',
        grant.grantId,
        '--json',
      ],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(started.status, 0, started.stderr);
    const prepared = (
      JSON.parse(started.stdout) as {
        result: ReturnType<typeof beginTaskDiffReview>;
      }
    ).result;
    assert.equal(prepared.state, 'waiting-for-provider');
    if (prepared.state !== 'waiting-for-provider') {
      assert.fail('expected granted TaskDiffReview provider work');
    }
    assert.equal(prepared.assignment.providerId, 'codex');
    assert.equal(
      prepared.assignment.achievedIndependence,
      'session-independent',
    );
    assert.ok('grantId' in prepared.assignment);
    assert.equal(prepared.assignment.grantId, grant.grantId);

    const reviewedBlobObjectId = prepared.subject.transitions.find(
      ({ path: changedPath }) => changedPath === 'src/feature.ts',
    )?.after?.objectId;
    assert.ok(reviewedBlobObjectId);
    const submission = validTaskDiffSubmission(reviewedBlobObjectId);
    assert.equal(
      runProviderWorker(repository, prepared.invocationId, {
        runner(input) {
          return {
            invocationId: prepared.invocationId,
            providerId: 'codex',
            purpose: 'task-diff-review',
            requestDigest: input.request.requestDigest,
            semanticOutput: submission,
            semanticOutputDigest: sha256(canonicalJson(submission)),
            assurance: 'unchanged-governed-projection',
            projection: {
              unchanged: true,
              changedCategories: [],
              beforeDigest: prepared.subject.subjectDigest,
              afterDigest: prepared.subject.subjectDigest,
            },
            sameUserProcessConfined: false,
            residuals: [...PROVIDER_RUNNER_RESIDUALS],
            executable: executableIdentity(),
            elapsedMs: 7,
          };
        },
      }).state,
      'succeeded',
    );
    const reviewed = reconcileTaskDiffReview(repository, session.sessionId, {
      collaborationGrantValidation: { now, verifier: signing.signer },
    });
    assert.equal(reviewed.state, 'satisfied');
    assert.equal(
      reviewed.review.assignment.achievedIndependence,
      'session-independent',
    );
    assert.deepEqual(
      assertCurrentTaskDiffReviewSatisfied(repository, session.sessionId),
      reviewed.review,
    );
    assert.equal(
      inspectCollaborationGrants(
        discoverRepository(repository).gitCommonDirectory,
        grant.grantId,
      )[0]?.state,
      'consumed',
    );
    const resumed = runCli(
      repository,
      [
        'review-diff',
        session.sessionId,
        '--actor',
        'codex',
        '--grant',
        grant.grantId,
        '--json',
      ],
      { WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1' },
    );
    assert.equal(resumed.status, 0, resumed.stderr);
    const resumedResult = (
      JSON.parse(resumed.stdout) as {
        result: ReturnType<typeof beginTaskDiffReview>;
      }
    ).result;
    assert.equal(resumedResult.state, 'satisfied');
    if (resumedResult.state !== 'satisfied') {
      assert.fail('expected the same consumed TaskDiffReview result');
    }
    assert.equal(resumedResult.invocationId, prepared.invocationId);
    assert.equal(
      resumedResult.review.recordDigest,
      reviewed.review.recordDigest,
    );
  } finally {
    signing.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createReviewFixture(
  options: {
    configurePathRoles?: (registry: {
      roles: Record<string, string[]>;
    }) => void;
    configureAdapterPolicy?: (policy: {
      providers: Record<'codex' | 'claude', { enabled: boolean }>;
    }) => void;
    configureMaintainerPolicy?: (policy: {
      trustedSigners: Array<{
        identity: string;
        publicKey: string;
        fingerprint: string;
      }>;
    }) => void;
  } = {},
): {
  repository: string;
  counterPath: string;
} {
  const repository = createFixtureRepository();
  const counterPath = path.join(repository, '.git', 'review-diff-count');
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
  if (options.configurePathRoles) {
    const registryPath = path.join(repository, 'workflow/path-roles.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as {
      roles: Record<string, string[]>;
    };
    options.configurePathRoles(registry);
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  }
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
    path.join(repository, 'workflow/maintainer-policy.json'),
  );
  if (options.configureMaintainerPolicy) {
    const policyPath = path.join(repository, 'workflow/maintainer-policy.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
      trustedSigners: Array<{
        identity: string;
        publicKey: string;
        fingerprint: string;
      }>;
    };
    options.configureMaintainerPolicy(policy);
    fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  }
  if (options.configureAdapterPolicy) {
    const policyPath = path.join(repository, 'workflow/ai-adapter-policy.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
      providers: Record<'codex' | 'claude', { enabled: boolean }>;
    };
    options.configureAdapterPolicy(policy);
    fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  }
  configureCountingCheck(repository, counterPath);
  git(repository, ['checkout', '-b', 'work/demo-change']);
  writeReadyV2ExemptChange(repository);
  commitPlanningTransition(repository, 'demo-change');
  return { repository, counterPath };
}

function configureCountingCheck(repository: string, counterPath: string): void {
  fs.writeFileSync(
    path.join(repository, 'scripts/count-review-diff.mjs'),
    [
      "import fs from 'node:fs';",
      'const counterPath = process.argv[2];',
      "const current = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
      'fs.writeFileSync(counterPath, String(current + 1));',
      '',
    ].join('\n'),
  );
  configureChecks(
    repository,
    {
      counted: {
        command: ['node', 'scripts/count-review-diff.mjs', counterPath],
        destructiveDatabase: false,
      },
    },
    ['counted'],
  );
}

function investigationRuntime(repository: string) {
  const repo = discoverRepository(repository);
  const config = loadWorkflowConfig(repo.repositoryRoot);
  return investigationRuntimePaths(
    repo.gitCommonDirectory,
    config.runtimeDirectory,
  );
}

function validTaskDiffSubmission(
  blobObjectId: string,
): TaskDiffReviewSubmission {
  return {
    schemaVersion: 1,
    verdict: 'advisory-approve',
    coverage: [...TASK_DIFF_REVIEW_COVERAGE],
    scopeAssessment: {
      kind: 'no-challenge',
      evidence: [
        {
          kind: 'repository-location',
          path: 'src/feature.ts',
          line: 1,
          blobObjectId,
          observation: 'The exact candidate preserves the declared invariant.',
        },
      ],
    },
    findings: [],
    suggestions: [],
    residualRisk: 'No release-blocking residual risk was identified.',
    uncertainty: 'Review is limited to the exact canonical candidate.',
  };
}

function challengedTaskDiffSubmission(
  blobObjectId: string,
): TaskDiffReviewSubmission {
  const base = validTaskDiffSubmission(blobObjectId);
  const evidence =
    base.scopeAssessment.kind === 'no-challenge'
      ? base.scopeAssessment.evidence
      : [];
  return {
    ...base,
    verdict: 'advisory-reject',
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
  };
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

function providerWireResult(
  request: ReturnType<typeof readProviderInvocationRequest>,
  output: unknown,
) {
  return {
    schemaVersion: 1,
    requestDigest: request.requestDigest,
    invocationId: request.invocationId,
    nonce: request.nonce,
    purpose: request.purpose,
    providerId: request.providerId,
    roleAssignmentDigest: request.roleAssignmentDigest,
    capabilityProfile: request.capabilityProfile,
    repositoryId: request.repositoryId,
    baseCommit: request.baseCommit,
    baseTree: request.baseTree,
    targetDigest: request.targetDigest,
    inputManifestDigest: request.inputManifestDigest,
    authorizationNodeId: request.authorizationNodeId,
    outputSchema: request.outputSchema,
    evaluatorVersion: request.evaluatorVersion,
    policyDigest: request.policyDigest,
    limits: request.limits,
    observedTouchedPaths: [],
    output,
  };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function createTaskDiffReviewSigningFixture(): {
  signer: MaintainerSignerProvider;
  trustedSigner: {
    identity: string;
    publicKey: string;
    fingerprint: string;
  };
  dispose(): void;
} {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'task-diff-review-signing-')),
  );
  const keyPath = path.join(root, 'review-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
  const publicKey = fs
    .readFileSync(`${keyPath}.pub`, 'utf8')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
  const fingerprint = execFileSync(
    'ssh-keygen',
    ['-l', '-E', 'sha256', '-f', `${keyPath}.pub`],
    { encoding: 'utf8' },
  ).match(/SHA256:[A-Za-z0-9+/]+/)?.[0];
  if (!fingerprint)
    throw new Error('TaskDiffReview fixture fingerprint missing.');
  const identity = 'task-diff-review-maintainer';
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {},
    identity: () => identity,
    sign(payload, namespace) {
      assert.ok(namespace);
      const payloadPath = path.join(root, 'payload');
      fs.writeFileSync(payloadPath, payload, { mode: 0o600 });
      execFileSync('ssh-keygen', [
        '-Y',
        'sign',
        '-f',
        keyPath,
        '-n',
        namespace,
        payloadPath,
      ]);
      const signature = fs.readFileSync(`${payloadPath}.sig`, 'utf8');
      fs.rmSync(payloadPath, { force: true });
      fs.rmSync(`${payloadPath}.sig`, { force: true });
      return signature;
    },
    verify(payload, signature, requestedIdentity, namespace) {
      assert.ok(namespace);
      verifySshSignatureWithPublicKey(
        payload,
        signature,
        requestedIdentity,
        publicKey,
        namespace,
      );
    },
  };
  return {
    signer,
    trustedSigner: { identity, publicKey, fingerprint },
    dispose() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function runCli(
  repository: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
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

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code;
}
