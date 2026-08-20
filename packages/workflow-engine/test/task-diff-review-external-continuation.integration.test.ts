import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  createDirectHumanReviewAttestation,
  issueCollaborationGrant,
} from '../src/modules/authority/collaboration-grant.ts';
import {
  failCollaborationReservation,
  inspectCollaborationGrants,
} from '../src/runtime/storage-journal/collaboration-grant-store.ts';
import { loadWorkflowConfig } from '../src/adapters/consumer/expense-app/work-registry/contracts.ts';
import { readEvidenceNode } from '../src/runtime/storage-journal/evidence-object-store.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { renderHandoff } from '../src/adapters/consumer/expense-app/handoff/handoff.ts';
import { finalizeTask } from '../src/application/finalize/lifecycle.ts';
import {
  verifySshSignatureWithPublicKey,
  type MaintainerSignerProvider,
} from '../src/adapters/signing/ssh/maintainer-signer.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import {
  assertCurrentTaskDiffReviewSatisfied,
  beginTaskDiffReview,
  beginTaskDiffReviewContinuation,
  loadCurrentExternalTaskDiffTerminalAssurance,
  reconcileTaskDiffReview,
  submitExternalTaskDiffReview,
  submitExternalTaskDiffReviewContinuation,
} from '../src/application/finalize/task-diff-review-lifecycle.ts';
import {
  createTaskDiffReviewChallengeResponse,
  type TaskDiffFinalAssuranceException,
  type TaskDiffReviewContinuationSubmission,
  type TaskDiffReviewSubmission,
} from '../src/modules/assurance/task-diff-review-artifact.ts';
import {
  readTaskDiffExternalContinuationBinding,
  readTaskDiffExternalReviewBinding,
  taskDiffExternalContinuationTargetDigest,
} from '../src/runtime/storage-journal/task-diff-review-external-store.ts';
import {
  readTaskDiffFinalAssuranceBinding,
  readTaskDiffReviewResultBinding,
} from '../src/runtime/storage-journal/task-diff-review-store.ts';
import {
  TASK_DIFF_REVIEW_COVERAGE,
  type TaskDiffReviewSubject,
} from '../src/modules/assurance/task-diff-review.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  sourceRepositoryRoot,
  writeReadyV2ExemptChange,
  builtInProviderDefinitionSnapshotForTest,
  builtInProviderExecutableIdentityForTest,
} from './fixture.ts';

test('provider review reaches FAR only through an authenticated external continuation and replays after crash', () => {
  const signing = createSigningFixture();
  const repository = createReviewFixture(signing);
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
      assert.fail('expected provider review');
    }
    completeFakeProvider(
      repository,
      prepared.invocationId,
      challengedSubmission(prepared.subject),
      prepared.subject.subjectDigest,
    );
    const reviewed = reconcileTaskDiffReview(repository, session.sessionId);
    assert.equal(reviewed.state, 'challenge-response-required');
    if (
      reviewed.state !== 'challenge-response-required' ||
      ('source' in reviewed && reviewed.source === 'external')
    ) {
      assert.fail('expected provider challenge');
    }
    const response = challengeResponse(reviewed.review);
    const closureInput = closureInputFor(
      reviewed.review.subject,
      reviewed.review,
      response,
    );
    const targetDigest = taskDiffExternalContinuationTargetDigest({
      subjectDigest: reviewed.review.subjectDigest,
      reviewRecordDigest: reviewed.review.recordDigest,
      responseDigest: response.responseDigest,
    });
    const now = new Date();
    const prematureGrant = issueExternalGrant(
      repository,
      signing,
      reviewed.review.subject,
      targetDigest,
      '99999999-9999-4999-8999-999999999999',
      'independent-closer',
      now,
    );
    assert.throws(
      () =>
        submitExternalTaskDiffReviewContinuation(
          repository,
          session.sessionId,
          response,
          closureInput,
          grantOptions(signing, prematureGrant.grantId, now, 15_000),
        ),
      hasCode('TASK_DIFF_EXTERNAL_CONTINUATION_PROVIDER_SHORTAGE_REQUIRED'),
    );
    assert.equal(
      inspectCollaborationGrants(
        discoverRepository(repository).gitCommonDirectory,
        prematureGrant.grantId,
      )[0]?.state,
      'available',
    );
    const failedProviderContinuation = beginTaskDiffReviewContinuation(
      repository,
      session.sessionId,
      response,
    );
    if (failedProviderContinuation.state !== 'waiting-for-provider') {
      assert.fail('expected an exact provider continuation attempt');
    }
    failFakeProvider(
      repository,
      failedProviderContinuation.invocationId,
      'PROVIDER_RATE_LIMIT',
    );

    const authorityFree = submitExternalTaskDiffReviewContinuation(
      repository,
      session.sessionId,
      response,
      closureInput,
    );
    assert.equal(authorityFree.state, 'collaboration-grant-required');
    if (authorityFree.state !== 'collaboration-grant-required') {
      assert.fail('expected exact continuation grant pause');
    }
    assert.equal(authorityFree.targetDigest, targetDigest);
    assert.equal(
      authorityFree.inputSchema.responseDigest,
      response.responseDigest,
    );
    assert.throws(
      () => assertCurrentTaskDiffReviewSatisfied(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_CHALLENGE_OPEN'),
    );
    assert.equal(
      readTaskDiffFinalAssuranceBinding(
        investigationRuntime(repository),
        reviewed.subject.subjectDigest,
      ),
      null,
    );

    const badGrant = issueExternalGrant(
      repository,
      signing,
      reviewed.subject,
      targetDigest,
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'provider:codex',
      now,
    );
    assert.throws(
      () =>
        submitExternalTaskDiffReviewContinuation(
          repository,
          session.sessionId,
          response,
          closureInput,
          grantOptions(signing, badGrant.grantId, now, 30_000),
        ),
      (error: unknown) =>
        hasCode('TASK_DIFF_REVIEW_INDEPENDENCE_INVALID')(error) ||
        hasCode('REVIEW_CHALLENGE_INVALID')(error),
    );
    assert.equal(
      inspectCollaborationGrants(
        discoverRepository(repository).gitCommonDirectory,
        badGrant.grantId,
      )[0]?.state,
      'failed',
    );

    const replacementResponse = challengeResponse(
      reviewed.review,
      'Replacement response remains bound to the same exact challenged review.',
    );
    const replacementInput = closureInputFor(
      reviewed.review.subject,
      reviewed.review,
      replacementResponse,
    );
    const replacementTargetDigest = taskDiffExternalContinuationTargetDigest({
      subjectDigest: reviewed.review.subjectDigest,
      reviewRecordDigest: reviewed.review.recordDigest,
      responseDigest: replacementResponse.responseDigest,
    });
    const pendingGrant = issueDirectHumanExternalGrant(
      repository,
      signing,
      reviewed.review.subject,
      targetDigest,
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      now,
    );
    assert.throws(
      () =>
        submitExternalTaskDiffReviewContinuation(
          repository,
          session.sessionId,
          response,
          closureInput,
          {
            ...grantOptions(signing, pendingGrant.grantId, now, 45_000),
            testCrashAfter: 'grant-reserved',
          },
        ),
      /Simulated external TaskDiffReview continuation interruption/,
    );
    assert.equal(
      inspectCollaborationGrants(
        discoverRepository(repository).gitCommonDirectory,
        pendingGrant.grantId,
      )[0]?.state,
      'reserved',
    );
    const pending = submitExternalTaskDiffReviewContinuation(
      repository,
      session.sessionId,
      response,
      closureInput,
      grantOptions(signing, pendingGrant.grantId, now, 60_000),
    );
    assert.equal(pending.state, 'direct-human-attestation-required');
    if (pending.state !== 'direct-human-attestation-required') {
      assert.fail('expected a durable external continuation reservation');
    }
    assert.throws(
      () =>
        beginTaskDiffReviewContinuation(
          repository,
          session.sessionId,
          response,
        ),
      hasCode('TASK_DIFF_REVIEW_LINEAGE_CONFLICT'),
    );
    const grant = issueExternalGrant(
      repository,
      signing,
      reviewed.review.subject,
      replacementTargetDigest,
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      'independent-closer',
      now,
    );
    assert.throws(
      () =>
        submitExternalTaskDiffReviewContinuation(
          repository,
          session.sessionId,
          replacementResponse,
          replacementInput,
          grantOptions(signing, grant.grantId, now, 60_000),
        ),
      hasCode('TASK_DIFF_EXTERNAL_CONTINUATION_ATTEMPT_ACTIVE'),
    );
    failCollaborationReservation(
      discoverRepository(repository).gitCommonDirectory,
      pendingGrant.grantId,
      pending.transitionDigest,
      'Terminal failed external continuation attempt permits replacement.',
      new Date(now.getTime() + 75_000),
    );
    assert.throws(
      () =>
        submitExternalTaskDiffReviewContinuation(
          repository,
          session.sessionId,
          replacementResponse,
          replacementInput,
          {
            ...grantOptions(signing, grant.grantId, now, 90_000),
            testCrashAfter: 'grant-consumed',
          },
        ),
      /Simulated external TaskDiffReview continuation interruption/,
    );
    const completed = submitExternalTaskDiffReviewContinuation(
      repository,
      session.sessionId,
      replacementResponse,
      replacementInput,
      grantOptions(signing, grant.grantId, now, 120_000),
    );
    assert.equal(completed.state, 'satisfied');
    assert.equal(completed.finalAssurance.verdict, 'satisfied');
    assert.equal(
      loadCurrentExternalTaskDiffTerminalAssurance(
        repository,
        session.sessionId,
      )?.finalAssurance.commitmentDigest,
      completed.finalAssurance.commitmentDigest,
    );
    assert.doesNotThrow(() =>
      assertCurrentTaskDiffReviewSatisfied(repository, session.sessionId),
    );
    assert.deepEqual(
      submitExternalTaskDiffReviewContinuation(
        repository,
        session.sessionId,
        replacementResponse,
        replacementInput,
        grantOptions(signing, grant.grantId, now, 150_000),
      ),
      completed,
    );

    const runtime = investigationRuntime(repository);
    const reviewBinding = readTaskDiffReviewResultBinding(
      runtime,
      session.sessionId,
      reviewed.subject.subjectDigest,
    );
    assert.ok(reviewBinding);
    const continuationBinding = readTaskDiffExternalContinuationBinding(
      runtime,
      replacementTargetDigest,
    );
    assert.ok(continuationBinding);
    const assuranceBinding = readTaskDiffFinalAssuranceBinding(
      runtime,
      reviewed.subject.subjectDigest,
    );
    assert.ok(assuranceBinding);
    const assuranceNode = readEvidenceNode(
      runtime,
      assuranceBinding.assuranceNodeId,
    );
    assert.deepEqual(assuranceNode.provenanceParentNodeIds, {
      continuation: continuationBinding.authorityNodeId,
      review: reviewBinding.providerResultNodeId,
    });
  } finally {
    signing.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('direct-human continuation binds the exposed authority-free node before FAR', () => {
  const signing = createSigningFixture();
  const repository = createReviewFixture(signing);
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
    if (prepared.state !== 'waiting-for-provider') {
      assert.fail('expected provider review');
    }
    completeFakeProvider(
      repository,
      prepared.invocationId,
      challengedSubmission(prepared.subject),
      prepared.subject.subjectDigest,
    );
    const reviewed = reconcileTaskDiffReview(repository, session.sessionId);
    if (
      reviewed.state !== 'challenge-response-required' ||
      ('source' in reviewed && reviewed.source === 'external')
    ) {
      assert.fail('expected provider challenge');
    }
    const response = challengeResponse(reviewed.review);
    const failedProviderContinuation = beginTaskDiffReviewContinuation(
      repository,
      session.sessionId,
      response,
    );
    if (failedProviderContinuation.state !== 'waiting-for-provider') {
      assert.fail('expected an exact provider continuation attempt');
    }
    failFakeProvider(
      repository,
      failedProviderContinuation.invocationId,
      'PROVIDER_CAPACITY',
    );
    const closureInput = closureInputFor(
      reviewed.subject,
      reviewed.review,
      response,
    );
    const targetDigest = taskDiffExternalContinuationTargetDigest({
      subjectDigest: reviewed.review.subjectDigest,
      reviewRecordDigest: reviewed.review.recordDigest,
      responseDigest: response.responseDigest,
    });
    const now = new Date();
    const grant = issueDirectHumanExternalGrant(
      repository,
      signing,
      reviewed.subject,
      targetDigest,
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      now,
    );
    const paused = submitExternalTaskDiffReviewContinuation(
      repository,
      session.sessionId,
      response,
      closureInput,
      grantOptions(signing, grant.grantId, now, 30_000),
    );
    assert.equal(paused.state, 'direct-human-attestation-required');
    if (paused.state !== 'direct-human-attestation-required') {
      assert.fail('expected direct-human continuation pause');
    }
    const wrong = createDirectHumanReviewAttestation(
      repository,
      {
        grantEnvelope: grant.envelope,
        transitionDigest: paused.transitionDigest,
        reviewNodeId: 'f'.repeat(64),
        reviewResultDigest: paused.contentResultDigest,
      },
      { now: new Date(now.getTime() + 60_000), signer: signing.signer },
    );
    assert.throws(() =>
      submitExternalTaskDiffReviewContinuation(
        repository,
        session.sessionId,
        response,
        closureInput,
        {
          collaborationGrant: {
            grantId: grant.grantId,
            now: new Date(now.getTime() + 90_000),
            verifier: signing.signer,
            directHumanReviewAttestation: wrong,
          },
        },
      ),
    );
    const attestation = createDirectHumanReviewAttestation(
      repository,
      {
        grantEnvelope: grant.envelope,
        transitionDigest: paused.transitionDigest,
        reviewNodeId: paused.contentNodeId,
        reviewResultDigest: paused.contentResultDigest,
      },
      { now: new Date(now.getTime() + 120_000), signer: signing.signer },
    );
    const completed = submitExternalTaskDiffReviewContinuation(
      repository,
      session.sessionId,
      response,
      closureInput,
      {
        collaborationGrant: {
          grantId: grant.grantId,
          now: new Date(now.getTime() + 150_000),
          directHumanReviewAttestation: attestation,
        },
      },
    );
    assert.equal(completed.state, 'satisfied');
    assert.equal(
      completed.finalAssurance.reviewerAuthority.kind,
      'grant-attributed-external-reviewer',
    );
  } finally {
    signing.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('external initial review and external continuation retain two independently authenticated grant stages', () => {
  const signing = createSigningFixture();
  const repository = createReviewFixture(signing, true);
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
    const paused = beginTaskDiffReview(repository, session.sessionId, {
      explicitActor: 'codex',
      environment: {},
    });
    assert.equal(paused.state, 'collaboration-grant-required');
    if (paused.state !== 'collaboration-grant-required') {
      assert.fail('expected external review pause');
    }
    const now = new Date();
    const reviewGrant = issueExternalGrant(
      repository,
      signing,
      paused.subject,
      paused.subject.subjectDigest,
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      'initial-external-reviewer',
      now,
    );
    const externalReview = submitExternalTaskDiffReview(
      repository,
      session.sessionId,
      {
        schemaVersion: 1,
        kind: 'task-diff-review-submission-input.v1',
        subjectDigest: paused.subject.subjectDigest,
        submission: challengedSubmission(paused.subject),
      },
      {
        explicitActor: 'codex',
        environment: {},
        ...grantOptions(signing, reviewGrant.grantId, now, 30_000),
      },
    );
    assert.equal(externalReview.state, 'challenge-response-required');
    if (
      externalReview.state !== 'challenge-response-required' ||
      !('source' in externalReview) ||
      externalReview.source !== 'external'
    ) {
      assert.fail('expected external challenge');
    }
    const response = challengeResponse(externalReview.review);
    const closureInput = closureInputFor(
      externalReview.subject,
      externalReview.review,
      response,
    );
    const targetDigest = taskDiffExternalContinuationTargetDigest({
      subjectDigest: externalReview.subject.subjectDigest,
      reviewRecordDigest: externalReview.review.recordDigest,
      responseDigest: response.responseDigest,
    });
    const closureGrant = issueExternalGrant(
      repository,
      signing,
      externalReview.subject,
      targetDigest,
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      'external-challenge-closer',
      now,
    );
    const completed = submitExternalTaskDiffReviewContinuation(
      repository,
      session.sessionId,
      response,
      closureInput,
      grantOptions(signing, closureGrant.grantId, now, 60_000),
    );
    assert.equal(completed.state, 'satisfied');
    assert.deepEqual(
      completed.finalAssurance.exceptions.map(
        (entry: TaskDiffFinalAssuranceException) => entry.stage,
      ),
      ['review', 'challenge-closure'],
    );
    assert.notEqual(
      completed.finalAssurance.exceptions[0]?.grantUseDigest,
      completed.finalAssurance.exceptions[1]?.grantUseDigest,
    );

    const runtime = investigationRuntime(repository);
    const reviewBinding = readTaskDiffExternalReviewBinding(
      runtime,
      externalReview.subject.subjectDigest,
    );
    assert.ok(reviewBinding);
    const continuationBinding = readTaskDiffExternalContinuationBinding(
      runtime,
      targetDigest,
    );
    assert.ok(continuationBinding);
    const assuranceBinding = readTaskDiffFinalAssuranceBinding(
      runtime,
      externalReview.subject.subjectDigest,
    );
    assert.ok(assuranceBinding);
    assert.deepEqual(
      readEvidenceNode(runtime, assuranceBinding.assuranceNodeId)
        .provenanceParentNodeIds,
      {
        continuation: continuationBinding.authorityNodeId,
        review: reviewBinding.authorityNodeId,
      },
    );
  } finally {
    signing.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function challengeResponse(
  review: Parameters<typeof createTaskDiffReviewChallengeResponse>[0]['review'],
  rationale = 'The exact checked candidate answers this challenge.',
) {
  return createTaskDiffReviewChallengeResponse({
    review,
    responses: review.challenges.map((challenge) => ({
      challengeId: challenge.challengeId,
      rationale,
      evidence: [challenge.evidence[0]!],
    })),
  });
}

function closureInputFor(
  subject: TaskDiffReviewSubject,
  review: Parameters<typeof createTaskDiffReviewChallengeResponse>[0]['review'],
  response: ReturnType<typeof createTaskDiffReviewChallengeResponse>,
) {
  return {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-closure-input.v1' as const,
    subjectDigest: subject.subjectDigest,
    reviewRecordDigest: review.recordDigest,
    responseDigest: response.responseDigest,
    proposedDispositions: review.challenges.map((challenge) => ({
      challengeId: challenge.challengeId,
      decision: 'rebutted' as const,
      rationale: 'The authenticated external reviewer rebuts this challenge.',
      supersededBy: null,
    })),
  };
}

function issueExternalGrant(
  repository: string,
  signing: ReturnType<typeof createSigningFixture>,
  subject: TaskDiffReviewSubject,
  targetDigest: string,
  grantId: string,
  callerId: string,
  now: Date,
) {
  return issueCollaborationGrant(
    repository,
    {
      changeId: 'demo-change',
      taskId: '1.1',
      baselineCommit: subject.baseCommit,
      baselineTree: subject.baseTree,
      targetDigest,
      lifecyclePhase: 'task-diff-review',
      rolePair: {
        authorRole: 'task-implementer',
        conflictingRole: 'task-diff-reviewer',
      },
      availableActor: {
        kind: 'caller',
        callerId,
        assurance: 'self-declared',
      },
      degradedForm: 'caller-supplied',
      reason: 'Exact external TaskDiffReview challenge continuation authority.',
      ttlMinutes: 30,
      maxUses: 1,
    },
    { grantId, now, signer: signing.signer },
  );
}

function issueDirectHumanExternalGrant(
  repository: string,
  signing: ReturnType<typeof createSigningFixture>,
  subject: TaskDiffReviewSubject,
  targetDigest: string,
  grantId: string,
  now: Date,
) {
  return issueCollaborationGrant(
    repository,
    {
      changeId: 'demo-change',
      taskId: '1.1',
      baselineCommit: subject.baseCommit,
      baselineTree: subject.baseTree,
      targetDigest,
      lifecyclePhase: 'task-diff-review',
      rolePair: {
        authorRole: 'task-implementer',
        conflictingRole: 'task-diff-reviewer',
      },
      availableActor: {
        kind: 'direct-human',
        identity: signing.trustedSigner.identity,
        assurance: 'maintainer-signed',
      },
      degradedForm: 'direct-human-review',
      reason: 'Exact direct-human TaskDiffReview challenge closure authority.',
      ttlMinutes: 30,
      maxUses: 1,
    },
    { grantId, now, signer: signing.signer },
  );
}

function grantOptions(
  signing: ReturnType<typeof createSigningFixture>,
  grantId: string,
  now: Date,
  offsetMs: number,
) {
  return {
    collaborationGrant: {
      grantId,
      now: new Date(now.getTime() + offsetMs),
      verifier: signing.signer,
    },
  };
}

function challengedSubmission(
  subject: TaskDiffReviewSubject,
): TaskDiffReviewSubmission {
  const transition = subject.transitions.find(
    ({ path: candidate }) => candidate === 'src/feature.ts',
  );
  assert.ok(transition?.after);
  const evidence = [
    {
      kind: 'repository-location' as const,
      path: 'src/feature.ts',
      line: 1,
      blobObjectId: transition.after.objectId,
      observation: 'The exact candidate may violate the task invariant.',
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
      ({ path: riskPath, role }) => ({
        path: riskPath,
        role: role as TaskDiffReviewSubmission['riskPathDispositions'][number]['role'],
        outcome: 'challenge-raised',
      }),
    ),
    residualRisk: 'The challenge requires authenticated closure.',
    uncertainty: 'Review is limited to the exact candidate.',
  };
}

function completeFakeProvider(
  repository: string,
  invocationId: string,
  output: TaskDiffReviewSubmission | TaskDiffReviewContinuationSubmission,
  subjectDigest: string,
) {
  return runProviderWorker(repository, invocationId, {
    runner(input) {
      const runtime = path.join(input.invocationDirectory, 'runtime');
      fs.mkdirSync(runtime, { mode: 0o700 });
      for (const [name, content] of [
        ['prompt.json', '{}\n'],
        ['schema.json', '{}\n'],
        ['semantic-output.json', `${canonicalJson(output)}\n`],
      ] as const) {
        fs.writeFileSync(path.join(runtime, name), content, { mode: 0o600 });
      }
      return {
        invocationId,
        providerId: input.request.providerId,
        purpose: 'task-diff-review' as const,
        requestDigest: input.request.requestDigest,
        semanticOutput: output,
        semanticOutputDigest: digest(output),
        assurance: 'unchanged-governed-projection' as const,
        projection: {
          unchanged: true as const,
          changedCategories: [],
          beforeDigest: subjectDigest,
          afterDigest: subjectDigest,
        },
        sameUserProcessConfined: false as const,
        residuals: [...PROVIDER_RUNNER_RESIDUALS],
        executable: builtInProviderExecutableIdentityForTest(input.providerId),
        elapsedMs: 7,
        providerDefinitionSnapshot: builtInProviderDefinitionSnapshotForTest(
          input.providerId,
        ),
      };
    },
  });
}

function failFakeProvider(
  repository: string,
  invocationId: string,
  code: 'PROVIDER_RATE_LIMIT' | 'PROVIDER_CAPACITY',
) {
  const failed = runProviderWorker(repository, invocationId, {
    runner() {
      throw workflowError(
        code,
        'The exact TaskDiffReview continuation provider is unavailable.',
        ExitCode.verification,
      );
    },
  });
  assert.equal(failed.state, 'failed');
  assert.equal(failed.failure?.code, code);
}

function createReviewFixture(
  signing: ReturnType<typeof createSigningFixture>,
  disableProviders = false,
): string {
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
  const maintainerPolicyPath = path.join(
    repository,
    'workflow/maintainer-policy.json',
  );
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
    maintainerPolicyPath,
  );
  const maintainerPolicy = JSON.parse(
    fs.readFileSync(maintainerPolicyPath, 'utf8'),
  ) as {
    repository: { origin: string };
    trustedSigners: unknown[];
  };
  maintainerPolicy.trustedSigners = [signing.trustedSigner];
  fs.writeFileSync(
    maintainerPolicyPath,
    `${JSON.stringify(maintainerPolicy, null, 2)}\n`,
  );
  git(repository, [
    'remote',
    'add',
    'origin',
    maintainerPolicy.repository.origin,
  ]);
  if (disableProviders) {
    const adapterPolicyPath = path.join(
      repository,
      'workflow/ai-adapter-policy.json',
    );
    const adapterPolicy = JSON.parse(
      fs.readFileSync(adapterPolicyPath, 'utf8'),
    ) as { providers: Record<'codex' | 'claude', { enabled: boolean }> };
    adapterPolicy.providers.codex.enabled = false;
    adapterPolicy.providers.claude.enabled = false;
    fs.writeFileSync(
      adapterPolicyPath,
      `${JSON.stringify(adapterPolicy, null, 2)}\n`,
    );
  }
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

function investigationRuntime(repository: string) {
  const discovered = discoverRepository(repository);
  const config = loadWorkflowConfig(discovered.repositoryRoot);
  return investigationRuntimePaths(
    discovered.gitCommonDirectory,
    config.runtimeDirectory,
  );
}

function createSigningFixture(): {
  signer: MaintainerSignerProvider;
  trustedSigner: {
    identity: string;
    publicKey: string;
    fingerprint: string;
  };
  dispose(): void;
} {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'external-continuation-signing-')),
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
  if (!fingerprint) throw new Error('fixture fingerprint missing');
  const identity = 'task-diff-review-maintainer';
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {},
    identity: () => identity,
    sign(payload, namespace) {
      if (!namespace) throw new Error('signature namespace missing');
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
      if (!namespace) throw new Error('signature namespace missing');
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

function digest(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : canonicalJson(value))
    .digest('hex');
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code;
}
