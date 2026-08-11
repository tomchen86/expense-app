import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { loadAiAdapterPolicy } from '../src/ai-adapter-policy.ts';
import { canonicalJson } from '../src/canonical-json.ts';
import { createEvidenceNode } from '../src/evidence-node.ts';
import { writeEvidenceNode } from '../src/evidence-object-store.ts';
import { ExitCode, workflowError } from '../src/errors.ts';
import { discoverRepository } from '../src/git.ts';
import { investigationRuntimePaths } from '../src/paths.ts';
import { createProviderInvocationRequest } from '../src/provider-contracts.ts';
import {
  createProviderInvocation,
  providerInvocationManifestDigest,
  readProviderInvocation,
  storeProviderExecutionPolicySnapshot,
  type TaskDiffReviewManifest,
} from '../src/provider-invocation-store.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/provider-runner.ts';
import { readProviderAutomaticRetrySchedule } from '../src/provider-retry-scheduler.ts';
import { runProviderWorker } from '../src/provider-worker.ts';
import { listProviderWorkerMaintenanceWarnings } from '../src/provider-worker-maintenance.ts';
import { scheduleOrdinaryRole } from '../src/role-scheduler.ts';
import {
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  type TaskDiffReviewSubmission,
} from '../src/task-diff-review-artifact.ts';
import {
  createTaskDiffReviewSubject,
  TASK_DIFF_REVIEW_COVERAGE,
} from '../src/task-diff-review.ts';
import { createFixtureRepository } from './fixture.ts';

test('provider worker durably executes the code-owned TaskDiffReview contract without write authority', () => {
  const fixture = createTaskDiffWorkerFixture('success');
  try {
    const submission = validSubmission(fixture.git.tree.length);
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
  const git = discoverRepository(repository);
  const runtime = investigationRuntimePaths(
    git.gitCommonDirectory,
    'workflow-engine',
  );
  const subject = createTaskDiffReviewSubject({
    repositoryId: 'github:tomchen86/fixture',
    changeId: 'demo-change',
    taskId: '1.1',
    baseCommit: git.head,
    baseTree: git.tree,
    candidateTree: 'c'.repeat(git.tree.length),
    transitions: [
      {
        path: 'src/a.ts',
        before: { mode: '100644', objectId: 'd'.repeat(git.tree.length) },
        after: { mode: '100644', objectId: 'e'.repeat(git.tree.length) },
      },
    ],
    taskContractDigest: '1'.repeat(64),
    requiredCheckPolicyDigest: '2'.repeat(64),
    checkEvidenceDigest: '3'.repeat(64),
    planningGenerationId: '4'.repeat(64),
    planTargetDigest: '5'.repeat(64),
    planReviewNodeId: '6'.repeat(64),
    planningAssuranceDigest: '7'.repeat(64),
    reviewRequirement: {
      required: true,
      basis: 'behavioral-strategy',
      riskPaths: [],
    },
  });
  const scheduled = scheduleOrdinaryRole({
    role: 'task-diff-reviewer',
    author: {
      providerId: 'codex',
      sessionId: 'implementation-session',
      principalId: undefined,
      identityAssurance: 'runtime-hint',
      engineSpawned: false,
    },
    targetDigest: subject.subjectDigest,
    candidates: [
      {
        providerId: 'claude',
        sessionId: `provider-session-task-diff-review-${suffix}`,
        enabled: true,
        available: true,
      },
    ],
  });
  assert.equal(scheduled.outcome, 'assigned');
  if (scheduled.outcome !== 'assigned') assert.fail('reviewer not assigned');
  const assignment = scheduled.assignment;
  const sessionId = `session-task-diff-review-${suffix}`;
  const authorization = createEvidenceNode({
    type: 'task-diff-review-authorization',
    nodeSchema: 'workflow.task-diff-review-authorization.v1',
    evaluator: 'workflow-finalize.v1',
    policyDigest: '8'.repeat(64),
    exactInputDigests: {
      assignment: sha256(canonicalJson(assignment)),
      subject: subject.subjectDigest,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'workflow.task-diff-review-authorization-output.v1',
    output: { sessionId, subject, assignment },
    runtimeMetadata: {},
  });
  writeEvidenceNode(runtime, authorization);
  const manifest: TaskDiffReviewManifest = {
    schemaVersion: 1,
    kind: 'task-diff-review-manifest',
    changeId: 'demo-change',
    taskId: '1.1',
    sessionId,
    repositoryId: 'fixture',
    repositoryIdentity: 'github:tomchen86/fixture',
    baseCommit: git.head,
    baseTree: git.tree,
    subject,
    capabilityProfile: 'repository-read-only',
  };
  const invocationId = `invocation-task-diff-review-${suffix}`;
  const request = createProviderInvocationRequest({
    invocationId,
    nonce: `task-diff-review-${suffix}-nonce-0001`,
    purpose: 'task-diff-review',
    providerId: assignment.providerId,
    roleAssignment: assignment,
    capabilityProfile: 'repository-read-only',
    repositoryId: 'fixture',
    baseCommit: git.head,
    baseTree: git.tree,
    targetDigest: subject.subjectDigest,
    inputManifestDigest: providerInvocationManifestDigest(manifest),
    authorizationNodeId: authorization.nodeId,
    writeAllowedPaths: [],
    outputSchema: TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
    evaluatorVersion: 'task-diff-review.v1',
    policyDigest: loadAiAdapterPolicy(repository).digest,
    limits: { timeoutMs: 300_000, aggregateOutputBytes: 1_048_576 },
  });
  storeProviderExecutionPolicySnapshot(
    runtime,
    request,
    loadAiAdapterPolicy(repository),
  );
  createProviderInvocation(runtime, {
    investigationId: `investigation-task-diff-review-${suffix}`,
    changeId: 'demo-change',
    attempt: 1,
    manifest,
    request,
  });
  return {
    repository,
    git,
    runtime,
    invocationId,
    request,
    dispose() {
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

function validSubmission(objectIdLength: number): TaskDiffReviewSubmission {
  return {
    schemaVersion: 1,
    verdict: 'advisory-approve',
    coverage: [...TASK_DIFF_REVIEW_COVERAGE],
    scopeAssessment: {
      kind: 'no-challenge',
      evidence: [
        {
          kind: 'repository-location',
          path: 'src/a.ts',
          line: 1,
          blobObjectId: 'e'.repeat(objectIdLength),
          observation: 'The exact candidate branch preserves the invariant.',
        },
      ],
    },
    findings: [],
    suggestions: [],
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
