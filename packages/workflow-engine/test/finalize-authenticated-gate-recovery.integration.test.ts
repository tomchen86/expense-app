import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import { renderHandoff } from '../src/adapters/consumer/expense-app/handoff/handoff.ts';
import {
  cancelFinalizeRecovery,
  finalizeTask,
  inspectFinalizeRecoveryStatus,
} from '../src/application/finalize/lifecycle.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import {
  beginTaskDiffReview,
  beginTaskDiffReviewContinuation,
  reconcileTaskDiffReview,
  reconcileTaskDiffReviewContinuation,
} from '../src/application/finalize/task-diff-review-lifecycle.ts';
import {
  createTaskDiffReviewChallengeResponse,
  type TaskDiffReviewSubmission,
} from '../src/modules/assurance/task-diff-review-artifact.ts';
import { TASK_DIFF_REVIEW_COVERAGE } from '../src/modules/assurance/task-diff-review.ts';
import { workflowResultNextSteps } from '../src/modules/guidance/next-steps/workflow-guidance.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  runtimeRoot,
  sourceRepositoryRoot,
  writeReadyV2ExemptChange,
  builtInProviderDefinitionSnapshotForTest,
} from './fixture.ts';

test('authenticated changes-required Final Assurance can cancel its exact checked finalize transaction', () => {
  const { repository } = createReviewFixture();
  try {
    const session = startSession(repository, 'demo-change', '1.1');
    const implementationPath = path.join(repository, 'src/feature.ts');
    const taskPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(implementationPath, 'export const reviewed = true;\n');

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
    const challenged = challengedTaskDiffSubmission(
      blobObjectId,
      prepared.subject,
    );
    completeProviderReview(
      repository,
      prepared.invocationId,
      prepared.subject.subjectDigest,
      challenged,
    );
    const reviewed = reconcileTaskDiffReview(repository, session.sessionId);
    if (!('review' in reviewed)) assert.fail('expected a completed review');
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
    const disposition = {
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
    completeProviderReview(
      repository,
      continuation.invocationId,
      prepared.subject.subjectDigest,
      disposition,
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
      () => finalizeTask(repository, session.sessionId),
      hasCode('TASK_DIFF_REVIEW_CHANGES_REQUIRED'),
    );

    const transaction = readActiveTransaction(repository, session.sessionId);
    assert.equal(transaction.phase, 'checked');
    assert.match(fs.readFileSync(taskPath, 'utf8'), /- \[x\] 1\.1/);
    const status = inspectFinalizeRecoveryStatus(repository, session.sessionId);
    assert.ok(status);
    const cancellationCommand =
      `pnpm workflow finalize-recover ${session.sessionId} ` +
      `--cancel ${transaction.transactionId} --reason <text> --json`;
    assert.deepEqual(status, {
      state: 'recovery-required',
      transactionId: transaction.transactionId,
      phase: 'checked',
      retrySafe: false,
      recoveryCommand: cancellationCommand,
    });
    assert.equal(
      workflowResultNextSteps({
        command: 'status',
        session,
        finalize: status,
        taskStrategy: { state: 'patch-imported' },
      })[0]?.command,
      cancellationCommand,
    );

    const reason = 'Apply the authenticated review correction';
    assert.throws(
      () =>
        cancelFinalizeRecovery(
          repository,
          session.sessionId,
          transaction.transactionId,
          reason,
          { testCrashAfter: 'projection-restored' },
        ),
      /Simulated finalize cancellation/,
    );
    assert.equal(fs.existsSync(transaction.path), true);
    assert.match(fs.readFileSync(taskPath, 'utf8'), /- \[ \] 1\.1/);
    const cancelled = cancelFinalizeRecovery(
      repository,
      session.sessionId,
      transaction.transactionId,
      reason,
    );
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.transactionId, transaction.transactionId);
    assert.equal(fs.existsSync(transaction.path), false);
    assert.match(fs.readFileSync(taskPath, 'utf8'), /- \[ \] 1\.1/);
    assert.equal(
      fs.readFileSync(implementationPath, 'utf8'),
      'export const reviewed = true;\n',
    );
    assert.equal(
      git(repository, ['diff', '--cached', '--name-only', '--']),
      '',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('an arbitrary checked finalize transaction remains non-cancellable', () => {
  const { repository } = createReviewFixture({ diffReviewRequired: false });
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
    const transaction = readActiveTransaction(repository, session.sessionId);
    assert.equal(transaction.phase, 'checked');
    assert.throws(
      () =>
        cancelFinalizeRecovery(
          repository,
          session.sessionId,
          transaction.transactionId,
          'This checked transaction has no authenticated correction verdict',
        ),
      hasCode('FINALIZE_CANCELLATION_INVALID'),
    );
    assert.equal(fs.existsSync(transaction.path), true);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createReviewFixture(options: { diffReviewRequired?: boolean } = {}): {
  repository: string;
} {
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
  fs.writeFileSync(
    path.join(repository, 'scripts/pass-finalize-gate.mjs'),
    'process.exit(0);\n',
  );
  configureChecks(
    repository,
    {
      gate: {
        command: ['node', 'scripts/pass-finalize-gate.mjs'],
        destructiveDatabase: false,
      },
    },
    ['gate'],
  );
  git(repository, ['checkout', '-b', 'work/demo-change']);
  writeReadyV2ExemptChange(
    repository,
    'demo-change',
    options.diffReviewRequired === false
      ? undefined
      : { diffReview: 'required' },
  );
  commitPlanningTransition(repository, 'demo-change');
  return { repository };
}

function completeProviderReview(
  repository: string,
  invocationId: string,
  subjectDigest: string,
  semanticOutput: unknown,
): void {
  const result = runProviderWorker(repository, invocationId, {
    runner(input) {
      writeFixtureProviderRuntime(input.invocationDirectory, semanticOutput);
      return {
        invocationId,
        providerId: 'claude',
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
        providerDefinitionSnapshot:
          builtInProviderDefinitionSnapshotForTest('claude'),
      };
    },
  });
  assert.equal(result.state, 'succeeded', JSON.stringify(result.failure));
}

function challengedTaskDiffSubmission(
  blobObjectId: string,
  subject: Parameters<typeof riskPathDispositionsFor>[0],
): TaskDiffReviewSubmission {
  const evidence = [
    {
      kind: 'repository-location' as const,
      path: 'src/feature.ts',
      line: 1,
      blobObjectId,
      observation: 'The changed branch may violate the task invariant.',
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
    riskPathDispositions: riskPathDispositionsFor(subject),
    residualRisk: 'The challenged invariant requires a candidate correction.',
    uncertainty: 'Review is limited to the exact canonical candidate.',
  };
}

function riskPathDispositionsFor(
  subject: Readonly<{
    reviewRequirement: Readonly<{
      riskPaths: readonly Readonly<{ path: string; role: string }>[];
    }>;
  }>,
): TaskDiffReviewSubmission['riskPathDispositions'] {
  return subject.reviewRequirement.riskPaths.map(({ path, role }) => ({
    path,
    role: role as TaskDiffReviewSubmission['riskPathDispositions'][number]['role'],
    outcome: 'challenge-raised',
  }));
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

function readActiveTransaction(
  repository: string,
  sessionId: string,
): { path: string; phase: string; transactionId: string } {
  const transactionPath = path.join(
    runtimeRoot(repository),
    'finalize-transactions',
    `${sessionId}.json`,
  );
  return {
    path: transactionPath,
    ...(JSON.parse(fs.readFileSync(transactionPath, 'utf8')) as {
      phase: string;
      transactionId: string;
    }),
  };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code: string }).code === code;
}
