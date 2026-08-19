import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { listExecutionJobs } from '../src/runtime/provider-execution/execution-runtime.ts';
import {
  executeGrantedReplacement,
  requestExecutionReplacement,
  SimulatedExecutionReplacementCrash,
} from '../src/application/control-plane/execution-replacement.ts';
import { issueExecutionBudgetGrant } from '../src/entrypoints/cli/execution-grant-cli.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { createInvestigationCheckpointEnvelope } from '../src/adapters/compatibility/investigation-v2/investigation-session.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import {
  createPlanningContributionEnvelope,
  createPlanReviewRetryEnvelope,
  getProposeStatus,
  resumePropose,
  startPropose,
} from '../src/application/propose/propose-orchestrator.ts';
import type { ProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  claimProviderInvocation,
  completeProviderInvocation,
  failProviderInvocation,
  providerInvocationExists,
  readProviderInvocationRequest,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { createFixtureRepository, git, isWorkflowError } from './fixture.ts';
import { prepareExecutionMandate } from './execution-mandate-fixture.ts';

test('granted replacement republication traverses its own reservation crash window', () => {
  const repository = createFixtureRepository();
  const changeId = 'replacement-crash-window';
  let mandate: ReturnType<typeof prepareExecutionMandate> | undefined;
  try {
    fs.writeFileSync(
      `${repository}/src/crash-window-target.ts`,
      'export const CrashWindowNeedle = true;\n',
    );
    git(repository, ['add', 'src/crash-window-target.ts']);
    git(repository, ['commit', '-m', 'Add crash window target']);
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    mandate = prepareExecutionMandate(repository, changeId);

    const started = startPropose(
      repository,
      changeId,
      {
        schemaVersion: 1,
        summary: 'Exercise the replacement reservation crash window.',
        explicitPaths: ['src/crash-window-target.ts'],
        explicitSymbols: ['CrashWindowNeedle'],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      {
        explicitActor: 'codex',
        environment: {},
        taskMandateId: mandate.taskId,
        taskMandateValidation: { signer: mandate.signer },
        providerDriver() {},
      },
    );
    const investigation = requireOrdinaryInvestigation(started);
    const paths = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );
    completeSurvey(
      paths,
      readProviderInvocationRequest(paths, investigation.providerInvocationId),
    );
    const afterMain = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(investigation, {
        reference: 'crash-window-main-terms',
        terms: [mainTerm('CrashWindowNeedle')],
      }),
    );
    const afterDispositions = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(
        requireOrdinaryInvestigation(afterMain),
        {
          dispositions: afterMain.work!.groups.map((group) => ({
            groupId: group.groupId,
            classification: 'load-bearing' as const,
            rationale: 'The complete source relationship is load-bearing.',
            author: 'codex',
          })),
        },
      ),
    );
    const sealed = resumePropose(
      repository,
      changeId,
      createInvestigationCheckpointEnvelope(
        requireOrdinaryInvestigation(afterDispositions),
        {
          answers: afterDispositions.work!.fullBlobManifest.map((entry) =>
            whyAnswer(entry.manifestEntryId),
          ),
        },
      ),
    );
    const materialized = resumePropose(
      repository,
      changeId,
      createPlanningContributionEnvelope(sealed, {
        proposal: '# Proposal\n\nAdd crash window behavior.\n',
        design: [
          '# Design',
          '',
          'Authored prefix.',
          '',
          '## Investigation Ledger',
          '',
          '<!-- workflow:investigation-ledger:start v1 -->',
          '',
          '<!-- workflow:investigation-ledger:end v1 -->',
          '',
          'Authored suffix.',
          '',
        ].join('\n'),
        specs: [
          {
            path: 'specs/demo/spec.md',
            content: [
              '# Delta',
              '',
              '## ADDED Requirements',
              '',
              '### Requirement: Crash window behavior',
              '',
              'The system SHALL recover interrupted replacements.',
              '',
              '#### Scenario: Replacement resumes',
              '',
              '- **WHEN** the republication is interrupted',
              '- **THEN** the WAL completes it',
              '',
            ].join('\n'),
          },
        ],
        tasks: '# Tasks\n\n- [ ] 1.1 Add crash window behavior\n',
        guard: {
          schemaVersion: 1,
          changeId,
          tasks: {
            '1.1': {
              allowedPaths: ['src/**'],
              requiredChecks: ['fixture'],
            },
          },
        },
        executionTasks: {
          '1.1': {
            strategy: 'direct-reviewed',
            enforcement: 'available',
            allowedPaths: ['src/**'],
            requiredChecks: ['fixture'],
            diffReview: 'policy-required',
            exemptionKind: 'narrowly-scoped-non-behavioral',
            exemptionReason: 'The fixture exercises workflow orchestration.',
            legacyBootstrap: null,
          },
        },
      }),
    );
    assert.equal(materialized.state, 'waiting-for-plan-review');

    // Two same-fingerprint failures put the ladder at its boundary, where the
    // bounded grant is the only executable exit.
    let review: ReturnType<typeof getProposeStatus> = materialized;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const invocationId = review.planReview!.invocationId;
      const claim = claimProviderInvocation(paths, invocationId, {
        workerId: `crash-window-worker-${attempt}`,
        leaseDurationMs: 1_000,
      });
      failProviderInvocation(paths, invocationId, {
        expectedRevision: claim.record.revision,
        leaseGeneration: claim.record.leaseGeneration,
        leaseToken: claim.leaseToken,
        failure: {
          kind: 'retryable',
          code: 'PLAN_REVIEW_PROCESS_FAILED',
          message: `PlanReview attempt ${attempt} failed.`,
        },
      });
      review = getProposeStatus(repository, investigation.investigationId);
      if (attempt < 2) {
        review = resumePropose(
          repository,
          changeId,
          createPlanReviewRetryEnvelope(repository, review, {
            acknowledgeProviderCost: true,
          }),
        );
      }
    }

    const failedInvocationId = review.planReview!.invocationId;
    const jobId = inspectExecutionJobForInvocation(
      repository,
      failedInvocationId,
    );
    const requested = requestExecutionReplacement(repository, jobId, {
      timeoutMs: 600_000,
    });
    const grantId = '77777777-7777-4777-8777-777777777777';
    issueExecutionBudgetGrant(repository, requested.request, {
      grantId,
      maxUses: 1,
      signer: mandate.signer,
    });

    // The republication dies after the replacement reservation is published
    // and before its invocation record exists.
    assert.throws(
      () =>
        executeGrantedReplacement(repository, jobId, grantId, {
          simulateCrashAfter: 'plan-review-reservation-replaced',
        }),
      (error: unknown) => error instanceof SimulatedExecutionReplacementCrash,
    );
    // The half-state is real: the full projection refuses to render it.
    assert.throws(
      () => getProposeStatus(repository, investigation.investigationId),
      (error: unknown) =>
        isWorkflowError(error, 'PLAN_REVIEW_INVOCATION_MISSING'),
    );

    // The WAL resume completes the interrupted publication from its own
    // transaction facts and the flow runs to completion exactly once.
    const dispatched: string[] = [];
    const completed = executeGrantedReplacement(repository, jobId, grantId, {
      providerDispatcher(_cwd, invocationId) {
        dispatched.push(invocationId);
      },
    });
    assert.equal(completed.phase, 'complete');
    assert.deepEqual(dispatched, [completed.replacementInvocationId]);
    assert.equal(
      providerInvocationExists(paths, completed.replacementInvocationId),
      true,
    );
    assert.equal(
      getProposeStatus(repository, investigation.investigationId).planReview
        ?.invocationId,
      completed.replacementInvocationId,
    );

    // Replay stays idempotent after recovery.
    const replayed = executeGrantedReplacement(repository, jobId, grantId, {
      providerDispatcher() {
        dispatched.push('unexpected');
      },
    });
    assert.deepEqual(replayed, completed);
    assert.deepEqual(dispatched, [completed.replacementInvocationId]);
  } finally {
    mandate?.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function requireOrdinaryInvestigation(
  output: ReturnType<typeof getProposeStatus>,
) {
  if (output.investigation?.kind !== 'investigation') {
    assert.fail('Expected an ordinary investigation.');
  }
  return output.investigation;
}

function inspectExecutionJobForInvocation(
  repository: string,
  invocationId: string,
): string {
  const job = listExecutionJobs(repository).find((candidate) =>
    candidate.attempts.some(
      (attempt) => attempt.legacyInvocation?.invocationId === invocationId,
    ),
  );
  assert.ok(job);
  return job.job.jobId;
}

function mainTerm(value: string) {
  return {
    kind: 'symbol' as const,
    value,
    rationale: `The main investigation identified ${value}.`,
    expectedRelationship: 'The planning change depends on this symbol.',
  };
}

function whyAnswer(manifestEntryId: string) {
  return {
    manifestEntryId,
    why: 'This complete module participates in the planned behavior.',
    protectedInvariant: 'Exact source and evidence identity remain bound.',
    reviewerQuestion: 'What prevents a stale blob from satisfying this row?',
    answer: 'The manifest binds the complete exact source digest.',
    semanticAuthor: 'codex',
    readComplete: true as const,
  };
}

function completeSurvey(
  paths: ReturnType<typeof investigationRuntimePaths>,
  request: ProviderInvocationRequest,
): void {
  const claim = claimProviderInvocation(paths, request.invocationId, {
    workerId: 'crash-window-survey-worker',
    leaseDurationMs: 60_000,
  });
  completeProviderInvocation(paths, request.invocationId, {
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
        providerWireResult(request, {
          reference: request.invocationId,
          terms: [{ kind: 'symbol', value: 'CrashWindowNeedle' }],
        }),
      ),
      stderr: '',
    },
  });
}

function providerWireResult(
  request: ProviderInvocationRequest,
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
