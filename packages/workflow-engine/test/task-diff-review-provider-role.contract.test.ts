import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProviderInvocationRequest,
  evaluateProviderProcess,
  type ProviderInvocationRequest,
  type ProviderProcessOutcome,
} from '../src/provider-contracts.ts';
import {
  providerInvocationManifestDigest,
  type TaskDiffReviewManifest,
} from '../src/provider-invocation-store.ts';
import { requireProviderCapability } from '../src/provider-registry.ts';
import {
  admitRoleResult,
  scheduleOrdinaryRole,
  type RoleAssignment,
  type RoleParticipant,
} from '../src/role-scheduler.ts';
import {
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_OUTPUT_VALIDATOR,
  type TaskDiffReviewSubmission,
} from '../src/task-diff-review-artifact.ts';
import {
  createTaskDiffReviewSubject,
  TASK_DIFF_REVIEW_COVERAGE,
} from '../src/task-diff-review.ts';

const TARGET = '3'.repeat(64);

test('task-diff-reviewer is a distinct provider-independent read-only role and manifest purpose', () => {
  assert.equal(
    requireProviderCapability(
      'claude',
      'task-diff-review',
      'repository-read-only',
    ).id,
    'claude',
  );
  const assignment = taskDiffAssignment();
  assert.deepEqual(assignment, {
    role: 'task-diff-reviewer',
    providerId: 'claude',
    sessionId: 'task-diff-review-session',
    targetDigest: TARGET,
    requiredIndependence: 'provider-independent',
    achievedIndependence: 'provider-independent',
  });

  const request = taskDiffRequest(assignment);
  assert.equal(request.purpose, 'task-diff-review');
  assert.equal(request.roleAssignment.role, 'task-diff-reviewer');
  assert.deepEqual(request.outputSchema, TASK_DIFF_REVIEW_OUTPUT_SCHEMA);

  const manifest = taskDiffManifest();
  assert.match(providerInvocationManifestDigest(manifest), /^[0-9a-f]{64}$/);
  assert.throws(() =>
    providerInvocationManifestDigest({
      ...manifest,
      subject: {
        ...manifest.subject,
        candidateTree: 'f'.repeat(40),
      },
    }),
  );
  assert.throws(() =>
    providerInvocationManifestDigest({
      ...manifest,
      subject: taskDiffSubject('github:tomchen86/other-repository'),
    }),
  );
});

test('task-diff-review provider output admits only exact engine-spawned invocation evidence', () => {
  const assignment = taskDiffAssignment();
  const request = taskDiffRequest(assignment);
  const output = validSubmission();
  const result = evaluateProviderProcess(
    request,
    processOutcome(providerResult(request, output)),
    TASK_DIFF_REVIEW_OUTPUT_VALIDATOR,
  );
  const admitted = admitRoleResult({
    assignment,
    author: participant({
      providerId: 'codex',
      sessionId: 'implementation-session',
      engineSpawned: false,
    }),
    participant: participant({
      providerId: 'claude',
      sessionId: 'task-diff-review-session',
      identityAssurance: 'adapter-assigned',
      engineSpawned: true,
    }),
    content: {
      kind: 'task-diff-review',
      nodeId: '9'.repeat(64),
      resultDigest: result.outputDigest,
      outputSchema: TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
      evaluator: 'task-diff-review.v1',
      policyDigest: '6'.repeat(64),
      contentDigest: result.outputDigest,
      current: true,
    },
    providerInvocation: {
      invocationId: request.invocationId,
      requestDigest: request.requestDigest,
      outputDigest: result.outputDigest,
      providerId: assignment.providerId,
      sessionId: assignment.sessionId,
      targetDigest: assignment.targetDigest,
      engineSpawned: true,
    },
    grantUse: null,
    grantValidation: null,
  });

  assert.equal(admitted.role, 'task-diff-reviewer');
  assert.equal(admitted.content.kind, 'task-diff-review');
  assert.equal(admitted.form, 'ordinary-provider');
  assert.equal(admitted.providerInvocation?.outputDigest, result.outputDigest);

  assert.throws(() =>
    createProviderInvocationRequest({
      ...requestInput(assignment),
      purpose: 'plan-review',
    }),
  );
});

function taskDiffAssignment(): RoleAssignment {
  const scheduled = scheduleOrdinaryRole({
    role: 'task-diff-reviewer',
    author: participant({
      providerId: 'codex',
      sessionId: 'implementation-session',
      engineSpawned: false,
    }),
    targetDigest: TARGET,
    candidates: [
      {
        providerId: 'claude',
        sessionId: 'task-diff-review-session',
        enabled: true,
        available: true,
      },
    ],
  });
  if (scheduled.outcome !== 'assigned') {
    throw new Error('fixture task diff reviewer was not scheduled');
  }
  return scheduled.assignment;
}

function taskDiffRequest(assignment: RoleAssignment) {
  return createProviderInvocationRequest(requestInput(assignment));
}

function requestInput(assignment: RoleAssignment) {
  return {
    invocationId: 'invocation-task-diff-review',
    nonce: 'task-diff-review-nonce-0001',
    purpose: 'task-diff-review' as const,
    providerId: assignment.providerId,
    roleAssignment: assignment,
    capabilityProfile: 'repository-read-only' as const,
    repositoryId: 'expense-app',
    baseCommit: 'a'.repeat(40),
    baseTree: 'b'.repeat(40),
    targetDigest: TARGET,
    inputManifestDigest: '4'.repeat(64),
    authorizationNodeId: '5'.repeat(64),
    writeAllowedPaths: [] as string[],
    outputSchema: TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
    evaluatorVersion: 'task-diff-review.v1',
    policyDigest: '6'.repeat(64),
    limits: { timeoutMs: 60_000, aggregateOutputBytes: 262_144 },
  };
}

function taskDiffManifest(): TaskDiffReviewManifest {
  return {
    schemaVersion: 1,
    kind: 'task-diff-review-manifest',
    changeId: 'demo-change',
    taskId: '1.1',
    sessionId: 'session-11111111-1111-4111-8111-111111111111',
    repositoryId: 'expense-app',
    repositoryIdentity: 'github:tomchen86/expense-app',
    baseCommit: 'a'.repeat(40),
    baseTree: 'b'.repeat(40),
    subject: taskDiffSubject('github:tomchen86/expense-app'),
    capabilityProfile: 'repository-read-only',
  };
}

function taskDiffSubject(repositoryId: string) {
  return createTaskDiffReviewSubject({
    repositoryId,
    changeId: 'demo-change',
    taskId: '1.1',
    baseCommit: 'a'.repeat(40),
    baseTree: 'b'.repeat(40),
    candidateTree: 'c'.repeat(40),
    transitions: [
      {
        path: 'src/a.ts',
        before: { mode: '100644', objectId: 'd'.repeat(40) },
        after: { mode: '100644', objectId: 'e'.repeat(40) },
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
}

function validSubmission(): TaskDiffReviewSubmission {
  const evidence = {
    kind: 'repository-location' as const,
    path: 'src/a.ts',
    line: 1,
    blobObjectId: 'e'.repeat(40),
    observation: 'The changed branch preserves the task invariant.',
  };
  return {
    schemaVersion: 1,
    verdict: 'advisory-approve',
    coverage: [...TASK_DIFF_REVIEW_COVERAGE],
    scopeAssessment: { kind: 'no-challenge', evidence: [evidence] },
    findings: [],
    suggestions: [],
    residualRisk: 'No release-blocking residual risk was identified.',
    uncertainty: 'Review is limited to the exact canonical candidate.',
  };
}

function participant(override: Partial<RoleParticipant>): RoleParticipant {
  return {
    providerId: 'codex',
    sessionId: 'session-a',
    principalId: undefined,
    identityAssurance: 'runtime-hint',
    engineSpawned: true,
    ...override,
  };
}

function providerResult(request: ProviderInvocationRequest, output: unknown) {
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

function processOutcome(result: unknown): ProviderProcessOutcome {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnErrorCode: null,
    elapsedMs: 10,
    stdout: JSON.stringify(result),
    stderr: '',
  };
}
