import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { canonicalJson } from '../src/canonical-json.ts';
import { ExitCode, workflowError } from '../src/errors.ts';
import { discoverRepository } from '../src/git.ts';
import { renderHandoff } from '../src/handoff.ts';
import { finalizeTask } from '../src/lifecycle.ts';
import { investigationRuntimePaths } from '../src/paths.ts';
import { commitPlanningTransition } from '../src/planning-transition.ts';
import {
  readProviderInvocation,
  readProviderInvocationRequest,
} from '../src/provider-invocation-store.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/provider-runner.ts';
import { readProviderAutomaticRetrySchedule } from '../src/provider-retry-scheduler.ts';
import { runProviderWorker } from '../src/provider-worker.ts';
import { listProviderWorkerMaintenanceWarnings } from '../src/provider-worker-maintenance.ts';
import { startSession } from '../src/session.ts';
import {
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  type TaskDiffReviewSubmission,
} from '../src/task-diff-review-artifact.ts';
import {
  beginTaskDiffReview,
  reconcileTaskDiffReview,
} from '../src/task-diff-review-lifecycle.ts';
import { TASK_DIFF_REVIEW_COVERAGE } from '../src/task-diff-review.ts';
import {
  configureChecks,
  createFixtureRepository,
  git as runFixtureGit,
  sourceRepositoryRoot,
  writeReadyV2ExemptChange,
} from './fixture.ts';

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

function createTaskDiffWorkerFixture(suffix: string) {
  const repository = createFixtureRepository();
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
          observation: 'The exact candidate branch preserves the invariant.',
        },
      ],
    },
    findings: [],
    suggestions: [],
    riskPathDispositions,
    residualRisk: 'No release-blocking residual risk was identified.',
    uncertainty: 'Review is limited to the exact canonical candidate.',
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

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
