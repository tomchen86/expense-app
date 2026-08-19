import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { withArchiveEligibility } from '../src/application/archive/archive-eligibility.ts';
import { verifyPullRequest } from '../src/entrypoints/ci/ci.ts';
import {
  assertDocumentationClosureCommitCurrent,
  parseDocumentationClosureFromCommitMessage,
} from '../src/runtime/managed-documents/contracts/documentation-closure.ts';
import { DOCUMENTATION_CLOSURE_ACTIVATION_MARKER } from '../src/runtime/managed-documents/ownership/documentation-closure-activation.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { commitFacts } from '../src/runtime/repository-transaction/git-transitions.ts';
import { renderHandoff } from '../src/adapters/consumer/expense-app/handoff/handoff.ts';
import { loadActiveSessionContext } from '../src/composition-root/lifecycle-context.ts';
import {
  cancelFinalizeRecovery,
  finalizeSession,
  finalizeTask,
  inspectFinalizeRecoveryStatus,
} from '../src/application/finalize/lifecycle.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import {
  readProviderInvocation,
  readProviderInvocationManifest,
  readProviderInvocationRequest,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import { readProviderAutomaticRetrySchedule } from '../src/runtime/provider-execution/provider-retry-scheduler.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import { listProviderWorkerMaintenanceWarnings } from '../src/runtime/storage-journal/provider-worker-maintenance.ts';
import {
  preparePullRequestPreMergeAssurance,
  verifyPullRequestWithPreMergeAssurance,
} from '../src/entrypoints/ci/pre-merge-assurance-git.ts';
import { runCli } from '../src/cli.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import {
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  type TaskDiffReviewContinuationSubmission,
  type TaskDiffReviewSubmission,
} from '../src/modules/assurance/task-diff-review-artifact.ts';
import {
  beginTaskDiffReview,
  beginTaskDiffReviewContinuationFromInput,
  reconcileTaskDiffReview,
  reconcileTaskDiffReviewContinuation,
} from '../src/application/finalize/task-diff-review-lifecycle.ts';
import { TASK_DIFF_REVIEW_COVERAGE } from '../src/modules/assurance/task-diff-review.ts';
import { inspectSession } from '../src/application/finalize/verification.ts';
import {
  configureChecks,
  createFixtureRepository,
  git as runFixtureGit,
  sourceRepositoryRoot,
  syncOriginMain,
  writeReadyV2ExemptChange,
} from './fixture.ts';

test('activated final task review binds documentation closure into commit and CI replay', async () => {
  const fixture = createTaskDiffWorkerFixture('documentation-closure', {
    documentationClosure: true,
  });
  try {
    const submission = validSubmission(
      fixture.reviewedBlobObjectId,
      fixture.riskPathDispositions,
      {
        decision: 'no-impact',
        notes:
          'The internal fixture implementation changes no public or operator documentation contract.',
      },
    );
    runProviderWorker(fixture.repository, fixture.invocationId, {
      runner() {
        return {
          invocationId: fixture.invocationId,
          providerId: 'claude',
          purpose: 'task-diff-review',
          requestDigest: fixture.request.requestDigest,
          semanticOutput: submission,
          semanticOutputDigest: sha256(canonicalJson(submission)),
          assurance: 'unchanged-governed-projection',
          projection: {
            unchanged: true,
            changedCategories: [],
            beforeDigest: '9'.repeat(64),
            afterDigest: '9'.repeat(64),
          },
          sameUserProcessConfined: false,
          residuals: [...PROVIDER_RUNNER_RESIDUALS],
          executable: executableIdentity(),
          elapsedMs: 8,
        };
      },
    });
    assert.equal(
      reconcileTaskDiffReview(fixture.repository, fixture.sessionId).state,
      'satisfied',
    );

    const finalized = finalizeSession(
      fixture.repository,
      fixture.sessionId,
      'Complete documented change',
    );
    const closure = parseDocumentationClosureFromCommitMessage(
      commitFacts(fixture.repository, finalized.commitHash).message,
    );
    assert.ok(closure);
    assert.equal(closure.changeId, 'demo-change');
    assert.equal(closure.taskId, '1.1');
    assert.equal(closure.assessment.decision, 'no-impact');
    assert.equal(closure.projectedCommitTree, finalized.tree);
    assertDocumentationClosureCommitCurrent({
      repositoryRoot: fixture.repository,
      commitHash: finalized.commitHash,
      changeId: 'demo-change',
      taskId: '1.1',
      changeBaseCommit: closure.requirement.changeBaseCommit,
      allowedProjectionPaths: [
        'docs/CURRENT_AND_NEXT_STEPS.md',
        'openspec/changes/demo-change/tasks.md',
      ],
    });
    assert.deepEqual(
      verifyPullRequest(
        fixture.repository,
        fixture.pullRequestBase,
        finalized.commitHash,
      ).completedTasks,
      [{ changeId: 'demo-change', taskId: '1.1' }],
    );
    let preMergeProviderCalls = 0;
    const preMergePreparation = preparePullRequestPreMergeAssurance(
      fixture.repository,
      fixture.pullRequestBase,
      finalized.commitHash,
    );
    assert.ok(preMergePreparation.prepared);
    assert.equal(preMergePreparation.prepared.reviewRequest, null);
    const preMerge = await verifyPullRequestWithPreMergeAssurance(
      fixture.repository,
      fixture.pullRequestBase,
      finalized.commitHash,
      {
        invokeIntegrationReview: async () => {
          preMergeProviderCalls += 1;
          throw new Error('fully covered single-task PR must not re-review');
        },
      },
    );
    assert.equal(preMergeProviderCalls, 0);
    assert.equal(preMerge.preMergeAssurance.integrationReview, null);
    assert.deepEqual(preMerge.preMergeAssurance.uncoveredEntryDigests, []);
    let ciOutput = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      ciOutput += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      assert.equal(
        runCli(
          [
            'ci',
            '--base',
            fixture.pullRequestBase,
            '--head',
            finalized.commitHash,
            '--json',
          ],
          fixture.repository,
        ),
        0,
      );
    } finally {
      process.stdout.write = originalWrite;
    }
    const ciResult = JSON.parse(ciOutput) as {
      result: { preMergeAssurance?: { nodeId: string } };
    };
    assert.equal(
      ciResult.result.preMergeAssurance?.nodeId,
      preMerge.preMergeAssurance.nodeId,
    );
    const replay = finalizeSession(
      fixture.repository,
      fixture.sessionId,
      'Complete documented change',
    );
    assert.equal(replay.commitHash, finalized.commitHash);
    assert.equal(replay.tree, finalized.tree);
    runFixtureGit(fixture.repository, [
      'update-ref',
      'refs/remotes/origin/main',
      finalized.commitHash,
    ]);
    runFixtureGit(fixture.repository, ['checkout', '-b', 'work/archive-demo']);
    assert.equal(
      withArchiveEligibility(
        fixture.repository,
        'demo-change',
        (eligibility) => eligibility.taskCommits[0]?.hash,
      ),
      finalized.commitHash,
    );
  } finally {
    fixture.dispose();
  }
});

test('documentation review opens exact remediation scope and requires a fresh final review', () => {
  const fixture = createTaskDiffWorkerFixture('documentation-remediation', {
    documentationClosure: true,
  });
  try {
    completeProviderInvocation(
      fixture.repository,
      fixture.invocationId,
      documentationChangesRequiredSubmission(
        fixture.reviewedBlobObjectId,
        fixture.riskPathDispositions,
      ),
    );
    const reviewed = reconcileTaskDiffReview(
      fixture.repository,
      fixture.sessionId,
    );
    assert.equal(reviewed.state, 'challenge-response-required');
    if (reviewed.state !== 'challenge-response-required') {
      assert.fail('expected documentation remediation challenge');
    }
    assert.deepEqual(
      loadActiveSessionContext(fixture.repository, fixture.sessionId).session
        .documentationRemediation,
      {
        reviewRecordDigests: [reviewed.review.recordDigest],
        paths: ['docs/ROADMAP.md'],
      },
    );
    const sessionPath = path.join(
      fixture.git.gitCommonDirectory,
      'workflow-engine',
      'sessions',
      `${fixture.sessionId}.json`,
    );
    const exactSessionBytes = fs.readFileSync(sessionPath);
    const noncanonicalSession = JSON.parse(
      exactSessionBytes.toString('utf8'),
    ) as {
      documentationRemediation: { paths: string[] };
    };
    noncanonicalSession.documentationRemediation.paths = ['docs//ROADMAP.md'];
    fs.writeFileSync(
      sessionPath,
      `${JSON.stringify(noncanonicalSession, null, 2)}\n`,
    );
    assert.throws(
      () => loadActiveSessionContext(fixture.repository, fixture.sessionId),
      hasCode('INVALID_SESSION'),
    );
    fs.writeFileSync(sessionPath, exactSessionBytes);

    const response = beginTaskDiffReviewContinuationFromInput(
      fixture.repository,
      fixture.sessionId,
      {
        schemaVersion: 1,
        kind: 'task-diff-review-challenge-response-input.v1',
        reviewRecordDigest: reviewed.review.recordDigest,
        responses: reviewed.review.challenges.map((challenge) => ({
          challengeId: challenge.challengeId,
          rationale:
            'The requested documentation remediation is accepted for the next checked candidate.',
          evidence: [challenge.evidence[0]!],
        })),
      },
    );
    assert.equal(response.state, 'waiting-for-provider');
    if (response.state !== 'waiting-for-provider') {
      assert.fail('expected provider continuation');
    }
    completeProviderInvocation(fixture.repository, response.invocationId, {
      schemaVersion: 1,
      reviewRecordDigest: reviewed.review.recordDigest,
      responseDigest: response.response.responseDigest,
      proposedDispositions: reviewed.review.challenges.map((challenge) => ({
        challengeId: challenge.challengeId,
        decision: 'accepted',
        rationale:
          'The implementation must include the exact requested documentation update.',
        supersededBy: null,
      })),
    });
    const changesRequired = reconcileTaskDiffReviewContinuation(
      fixture.repository,
      fixture.sessionId,
      response.response.responseDigest,
    );
    assert.equal(changesRequired.state, 'changes-required');

    const recovery = inspectFinalizeRecoveryStatus(
      fixture.repository,
      fixture.sessionId,
    );
    assert.equal(recovery?.state, 'recovery-required');
    assert.ok(recovery);
    cancelFinalizeRecovery(
      fixture.repository,
      fixture.sessionId,
      recovery.transactionId,
      'Apply authenticated documentation remediation',
    );
    fs.writeFileSync(
      `${fixture.repository}/docs/ROADMAP.md`,
      '# Roadmap\n\nThe reviewed feature is documented.\n',
    );
    assert.doesNotThrow(() =>
      inspectSession(fixture.repository, fixture.sessionId),
    );
    fs.writeFileSync(
      `${fixture.repository}/docs/UNREQUESTED.md`,
      '# Unrequested\n',
    );
    assert.throws(
      () => inspectSession(fixture.repository, fixture.sessionId),
      hasCode('OUT_OF_SCOPE_PATHS'),
    );
    fs.rmSync(`${fixture.repository}/docs/UNREQUESTED.md`);
    assert.throws(
      () => finalizeTask(fixture.repository, fixture.sessionId),
      hasCode('TASK_DIFF_REVIEW_REQUIRED'),
    );
    const prepared = beginTaskDiffReview(
      fixture.repository,
      fixture.sessionId,
      { explicitActor: 'codex', environment: {} },
    );
    assert.equal(prepared.state, 'waiting-for-provider');
    if (prepared.state !== 'waiting-for-provider') {
      assert.fail('expected a fresh final review');
    }
    assert.notEqual(
      prepared.subject.subjectDigest,
      reviewed.subject.subjectDigest,
    );
    const documentationRequirement = prepared.subject.documentationRequirement;
    assert.equal(documentationRequirement?.required, true);
    if (documentationRequirement?.required !== true) {
      assert.fail('expected final documentation requirement');
    }
    assert.deepEqual(documentationRequirement.changedPaths, [
      'docs/ROADMAP.md',
      'src/feature.ts',
    ]);
    const reviewedBlobObjectId = prepared.subject.transitions.find(
      ({ path: changedPath }) => changedPath === 'docs/ROADMAP.md',
    )?.after?.objectId;
    assert.ok(reviewedBlobObjectId);
    const manifest = readProviderInvocationManifest(
      fixture.runtime,
      prepared.invocationId,
    );
    assert.equal(manifest.kind, 'task-diff-review-manifest');
    if (manifest.kind !== 'task-diff-review-manifest') {
      assert.fail('expected initial review manifest');
    }
    const reviewedPaths = new Set(manifest.reviewScope.reviewedPaths);
    completeProviderInvocation(
      fixture.repository,
      prepared.invocationId,
      validSubmission(
        reviewedBlobObjectId,
        prepared.subject.reviewRequirement.riskPaths
          .filter(({ path }) => reviewedPaths.has(path))
          .map(({ path, role }) => ({
            path,
            role: role as TaskDiffReviewSubmission['riskPathDispositions'][number]['role'],
            outcome: 'no-challenge',
          })),
        {
          decision: 'updated',
          paths: ['docs/ROADMAP.md'],
          notes:
            'The exact requested roadmap update is present in the candidate.',
        },
        'docs/ROADMAP.md',
      ),
    );
    assert.equal(
      reconcileTaskDiffReview(fixture.repository, fixture.sessionId).state,
      'satisfied',
    );
    const finalized = finalizeSession(
      fixture.repository,
      fixture.sessionId,
      'Complete remediated documentation',
    );
    const closure = parseDocumentationClosureFromCommitMessage(
      commitFacts(fixture.repository, finalized.commitHash).message,
    );
    assert.ok(closure);
    assert.equal(closure.assessment.decision, 'updated');
    assert.deepEqual(closure.remediation, {
      reviewRecordDigests: [reviewed.review.recordDigest],
      paths: ['docs/ROADMAP.md'],
    });
  } finally {
    fixture.dispose();
  }
});

test('provider worker durably executes the code-owned TaskDiffReview contract without write authority', () => {
  const fixture = createTaskDiffWorkerFixture('success');
  try {
    const submission = validSubmission(
      fixture.reviewedBlobObjectId,
      fixture.riskPathDispositions,
    );
    const result = runProviderWorker(fixture.repository, fixture.invocationId, {
      runner(input) {
        assert.equal(
          sha256(canonicalJson(input.semanticOutputSchema)),
          TASK_DIFF_REVIEW_OUTPUT_SCHEMA.digest,
        );
        assert.equal(input.request.writeAllowedPaths.length, 0);
        return {
          invocationId: fixture.invocationId,
          providerId: 'claude',
          purpose: 'task-diff-review',
          requestDigest: fixture.request.requestDigest,
          semanticOutput: submission,
          semanticOutputDigest: sha256(canonicalJson(submission)),
          assurance: 'unchanged-governed-projection',
          projection: {
            unchanged: true,
            changedCategories: [],
            beforeDigest: '9'.repeat(64),
            afterDigest: '9'.repeat(64),
          },
          sameUserProcessConfined: false,
          residuals: [...PROVIDER_RUNNER_RESIDUALS],
          executable: executableIdentity(),
          elapsedMs: 8,
        };
      },
    });

    assert.equal(result.state, 'succeeded', JSON.stringify(result));
    const durable = readProviderInvocation(
      fixture.runtime,
      fixture.invocationId,
    );
    assert.equal(durable.purpose, 'task-diff-review');
    assert.equal(
      durable.result?.runtimeObservation?.assurance,
      'unchanged-governed-projection',
    );
    assert.equal(
      durable.result?.outputDigest,
      sha256(
        canonicalJson({
          id: TASK_DIFF_REVIEW_OUTPUT_SCHEMA.id,
          version: TASK_DIFF_REVIEW_OUTPUT_SCHEMA.version,
          output: submission,
        }),
      ),
    );
    assert.equal(
      reconcileTaskDiffReview(fixture.repository, fixture.sessionId).state,
      'satisfied',
    );
  } finally {
    fixture.dispose();
  }
});

test('TaskDiffReview provider failure cannot enter the legacy survey or plan-review retry routes', () => {
  const fixture = createTaskDiffWorkerFixture('failed');
  try {
    const failed = runProviderWorker(fixture.repository, fixture.invocationId, {
      runner() {
        throw workflowError(
          'PROVIDER_RATE_LIMIT',
          'The provider asked the worker to retry later.',
          ExitCode.verification,
          { details: { retryAfterMs: 1_000 } },
        );
      },
      automaticRetry: {
        enabled: true,
        dispatcher() {
          assert.fail('unsupported TaskDiffReview retry was dispatched');
        },
      },
    });
    assert.equal(failed.state, 'failed');
    assert.equal(
      readProviderAutomaticRetrySchedule(
        fixture.repository,
        fixture.invocationId,
      ),
      null,
    );
    assert.deepEqual(
      listProviderWorkerMaintenanceWarnings(fixture.repository),
      [],
    );
  } finally {
    fixture.dispose();
  }
});

function createTaskDiffWorkerFixture(
  suffix: string,
  options: { documentationClosure?: boolean } = {},
) {
  const repository = createFixtureRepository();
  if (options.documentationClosure) {
    fs.copyFileSync(
      `${sourceRepositoryRoot}/${DOCUMENTATION_CLOSURE_ACTIVATION_MARKER}`,
      `${repository}/${DOCUMENTATION_CLOSURE_ACTIVATION_MARKER}`,
    );
  }
  const documentPolicyPath = `${repository}/workflow/document-policy.json`;
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
  fs.mkdirSync(`${repository}/docs`, { recursive: true });
  renderHandoff(repository);
  fs.copyFileSync(
    `${sourceRepositoryRoot}/workflow/path-roles.json`,
    `${repository}/workflow/path-roles.json`,
  );
  fs.copyFileSync(
    `${sourceRepositoryRoot}/workflow/maintainer-policy.json`,
    `${repository}/workflow/maintainer-policy.json`,
  );
  fs.writeFileSync(
    `${repository}/scripts/task-diff-review-check.mjs`,
    'process.exit(0);\n',
  );
  configureChecks(
    repository,
    {
      reviewed: {
        command: ['node', 'scripts/task-diff-review-check.mjs'],
        destructiveDatabase: false,
      },
    },
    ['reviewed'],
  );
  if (options.documentationClosure) {
    syncOriginMain(repository);
  }
  const pullRequestBase = runFixtureGit(repository, [
    'rev-parse',
    'HEAD',
  ]).trim();
  runFixtureGit(repository, ['checkout', '-b', 'work/demo-change']);
  writeReadyV2ExemptChange(repository);
  commitPlanningTransition(repository, 'demo-change');
  const session = startSession(repository, 'demo-change', '1.1');
  fs.writeFileSync(
    `${repository}/src/feature.ts`,
    `export const reviewed = ${JSON.stringify(suffix)};\n`,
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
  const git = discoverRepository(repository);
  const runtime = investigationRuntimePaths(
    git.gitCommonDirectory,
    'workflow-engine',
  );
  const reviewedBlobObjectId = prepared.subject.transitions.find(
    ({ path: changedPath }) => changedPath === 'src/feature.ts',
  )?.after?.objectId;
  assert.ok(reviewedBlobObjectId);
  return {
    repository,
    git,
    runtime,
    invocationId: prepared.invocationId,
    request: readProviderInvocationRequest(runtime, prepared.invocationId),
    pullRequestBase,
    sessionId: session.sessionId,
    reviewedBlobObjectId,
    riskPathDispositions: prepared.subject.reviewRequirement.riskPaths.map(
      ({ path, role }) => ({
        path,
        role: role as TaskDiffReviewSubmission['riskPathDispositions'][number]['role'],
        outcome: 'no-challenge' as const,
      }),
    ),
    dispose() {
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

function validSubmission(
  blobObjectId: string,
  riskPathDispositions: TaskDiffReviewSubmission['riskPathDispositions'],
  documentationAssessment?: TaskDiffReviewSubmission['documentationAssessment'],
  evidencePath = 'src/feature.ts',
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
          path: evidencePath,
          line: 1,
          blobObjectId,
          observation: 'The exact candidate branch preserves the invariant.',
        },
      ],
    },
    findings: [],
    suggestions: [],
    riskPathDispositions,
    residualRisk: 'No release-blocking residual risk was identified.',
    uncertainty: 'Review is limited to the exact canonical candidate.',
    ...(documentationAssessment === undefined
      ? {}
      : { documentationAssessment }),
  };
}

function documentationChangesRequiredSubmission(
  blobObjectId: string,
  riskPathDispositions: TaskDiffReviewSubmission['riskPathDispositions'],
): TaskDiffReviewSubmission {
  const evidence = {
    kind: 'repository-location' as const,
    path: 'src/feature.ts',
    line: 1,
    blobObjectId,
    observation:
      'The implementation is not yet accompanied by the required roadmap update.',
  };
  return {
    schemaVersion: 1,
    verdict: 'advisory-reject',
    coverage: [...TASK_DIFF_REVIEW_COVERAGE],
    scopeAssessment: { kind: 'challenges' },
    findings: [
      {
        kind: 'challenge',
        severity: 'high',
        category: 'consumers-generated-and-mirrored-artifacts',
        currentChangeImpact: 'required',
        summary: 'The final change requires an exact roadmap update.',
        evidence: [evidence],
      },
    ],
    suggestions: [],
    riskPathDispositions: riskPathDispositions.map((entry) => ({
      ...entry,
      outcome:
        entry.path === evidence.path
          ? ('challenge-raised' as const)
          : ('no-challenge' as const),
    })),
    residualRisk: 'The candidate must be reviewed again after remediation.',
    uncertainty: 'Review is limited to the exact canonical candidate.',
    documentationAssessment: {
      decision: 'needs-changes',
      requiredPaths: ['docs/ROADMAP.md'],
      notes: 'Add the exact roadmap update before final change closure.',
    },
  };
}

function completeProviderInvocation(
  repository: string,
  invocationId: string,
  semanticOutput:
    TaskDiffReviewSubmission | TaskDiffReviewContinuationSubmission,
) {
  return runProviderWorker(repository, invocationId, {
    runner(input) {
      writeFixtureProviderRuntime(input.invocationDirectory, semanticOutput);
      return {
        invocationId,
        providerId: input.request.providerId,
        purpose: 'task-diff-review' as const,
        requestDigest: input.request.requestDigest,
        semanticOutput,
        semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
        assurance: 'unchanged-governed-projection' as const,
        projection: {
          unchanged: true as const,
          changedCategories: [],
          beforeDigest: '9'.repeat(64),
          afterDigest: '9'.repeat(64),
        },
        sameUserProcessConfined: false,
        residuals: [...PROVIDER_RUNNER_RESIDUALS],
        executable: executableIdentity(),
        elapsedMs: 8,
      };
    },
  });
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

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code;
}
