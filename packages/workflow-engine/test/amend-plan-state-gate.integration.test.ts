import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  readContentRecord,
  writeContentRecord,
} from '../src/runtime/storage-journal/content-record-store.ts';
import {
  commitPlanAmendment,
  commitPlanningTransition,
} from '../src/application/propose/planning-transition.ts';
import { validateCiPlanningCommit } from '../src/entrypoints/ci/ci-planning.ts';
import { validateOpenSpecPlanning } from '../src/adapters/planning/openspec/documents/planning-contract.ts';
import { readPlanningTransitionReport } from '../src/runtime/storage-journal/planning-report.ts';
import { loadWorkflowConfig } from '../src/adapters/consumer/expense-app/work-registry/contracts.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { committedPlanningGeneration } from '../src/runtime/repository-transaction/planning-generation-history.ts';
import { inspectPlanningExecutionEpoch } from '../src/modules/lifecycle/planning-execution-epoch.ts';
import { withArchiveEligibility } from '../src/application/archive/archive-eligibility.ts';
import {
  createPlanningAmendmentDecision,
  readPlanningAmendmentDecision,
  renderPlanningAmendmentDecisionMarker,
  replacePlanningAmendmentDecisionMarker,
} from '../src/modules/lifecycle/planning-amendment-decision.ts';
import {
  activateInvestigationPlanning,
  createFixtureRepository,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
  syncOriginMain,
  writeReadyV2ExemptChange,
} from './fixture.ts';

test('amend-plan refuses a reviewed generation whose execution is not complete', () => {
  const repository = plannedV2Fixture();
  try {
    prepareReviewedCorrection(repository);
    const before = repositoryState(repository);

    assert.throws(
      () =>
        commitPlanAmendment(repository, 'demo-change', {
          reason: 'archive-applicability-failure',
          executionImpact: 'none',
        }),
      (error: unknown) => isWorkflowError(error, 'AMENDMENT_STATE_INELIGIBLE'),
    );

    assert.deepEqual(repositoryState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('amend-plan admits a completed generation with exact task-commit evidence', () => {
  const repository = plannedV2Fixture();
  try {
    completeTask(repository);
    prepareReviewedCorrection(repository);

    const result = commitPlanAmendment(repository, 'demo-change', {
      reason: 'archive-applicability-failure',
      executionImpact: 'none',
    });

    assert.equal(result.amendment?.executionImpact, 'none');
    assert.deepEqual(result.amendment?.reopenedTasks, []);
    const report = readAmendmentReport(
      repository,
      result.reportId,
    ) as unknown as {
      amendment: unknown;
    };
    assert.deepEqual(report.amendment, {
      status: 'recorded',
      reason: 'archive-applicability-failure',
      executionImpact: 'none',
      rationale: result.amendment?.rationale,
      decisionDigest: result.amendment?.decisionDigest,
      planningGeneration: result.amendment?.planningGeneration,
      amendsPlanningGeneration: result.amendment?.amendsPlanningGeneration,
      planReview: result.amendment?.planReview,
      executionDisposition: {
        kind: 'carried-forward',
        tasks: [
          {
            taskId: '1.1',
            source: 'managed-task-commit',
            commitHash: result.baselineHead,
          },
        ],
      },
    });
    const epoch = inspectPlanningExecutionEpoch(repository, 'demo-change');
    assert.equal(epoch.context.workflow.currentEpoch, 2);
    assert.equal(epoch.context.workflow.checkpoint, 'execution-complete');
    assert.deepEqual(
      epoch.context.currentManifest.items.map(({ identity }) => identity),
      ['task:1.1'],
    );
    assert.deepEqual(
      epoch.context.transitionReceipts[0]?.schemaVersion === 2
        ? epoch.context.transitionReceipts[0].carryForwardManifest
            .carriedForward
        : null,
      [
        {
          identity: 'task:1.1',
          reason:
            'Exact managed task evidence remains valid under the reviewed no-impact amendment.',
        },
      ],
    );
    assert.ok(
      epoch.retention.records
        .filter(({ epoch: evidenceEpoch }) => evidenceEpoch === 1)
        .every(({ retention }) => retention === 'expiring'),
    );
    assert.equal(git(repository, ['status', '--porcelain']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a missing v2 amendment disposition is never projected as carry-forward evidence', () => {
  const repository = plannedV2Fixture();
  try {
    completeTask(repository);
    prepareReviewedCorrection(repository);
    const result = commitPlanAmendment(repository, 'demo-change', {
      reason: 'archive-applicability-failure',
      executionImpact: 'none',
    });
    const reportsDirectory = amendmentReportsDirectory(repository);
    const persisted = readContentRecord(reportsDirectory, result.reportId);
    const missingDisposition = { ...persisted };
    delete missingDisposition.amendment;
    const missingDispositionId = writeContentRecord(
      reportsDirectory,
      missingDisposition,
    );

    assert.throws(
      () =>
        readPlanningTransitionReport(reportsDirectory, missingDispositionId),
      (error: unknown) => isWorkflowError(error, 'PLANNING_REPORT_INVALID'),
    );

    const legacy = { ...missingDisposition };
    delete legacy.reportVersion;
    const legacyId = writeContentRecord(reportsDirectory, legacy);
    const legacyProjection = readPlanningTransitionReport(
      reportsDirectory,
      legacyId,
    );
    assert.equal(legacyProjection.reportVersion, 1);
    assert.deepEqual(legacyProjection.amendment, { status: 'not-recorded' });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('the durable amendment report binds its reviewed rationale to the decision digest', () => {
  const repository = plannedV2Fixture();
  try {
    completeTask(repository);
    prepareReviewedCorrection(repository);
    const result = commitPlanAmendment(repository, 'demo-change', {
      reason: 'archive-applicability-failure',
      executionImpact: 'none',
    });
    const reportsDirectory = amendmentReportsDirectory(repository);
    const tampered = structuredClone(
      readContentRecord(reportsDirectory, result.reportId),
    ) as unknown as ReturnType<typeof readContentRecord> & {
      amendment: { status: string; rationale: string };
    };
    assert.equal(tampered.amendment.status, 'recorded');
    tampered.amendment.rationale =
      'A different rationale was inserted after the reviewed decision.';
    const tamperedId = writeContentRecord(reportsDirectory, tampered);

    assert.throws(
      () => readPlanningTransitionReport(reportsDirectory, tamperedId),
      (error: unknown) => isWorkflowError(error, 'PLANNING_REPORT_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('amend-plan requires a decision already covered by the fresh review', () => {
  const repository = plannedV2Fixture();
  try {
    completeTask(repository);
    const proposalPath = path.join(
      repository,
      'openspec/changes/demo-change/proposal.md',
    );
    fs.appendFileSync(proposalPath, '\nReviewed archive correction.\n');
    writeReadyV2ExemptChange(repository);

    assert.throws(
      () =>
        commitPlanAmendment(repository, 'demo-change', {
          reason: 'archive-applicability-failure',
          executionImpact: 'none',
        }),
      (error: unknown) => isWorkflowError(error, 'AMENDMENT_DECISION_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('the CLI cannot replace the reviewed amendment reason or impact decision', () => {
  const repository = plannedV2Fixture();
  try {
    completeTask(repository);
    prepareReviewedCorrection(repository);

    assert.throws(
      () =>
        commitPlanAmendment(repository, 'demo-change', {
          reason: 'caller-overrode-reviewed-reason',
          executionImpact: 'none',
        }),
      (error: unknown) => isWorkflowError(error, 'AMENDMENT_DECISION_MISMATCH'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('an amendment decision cannot claim a generation other than its exact parent', () => {
  const repository = plannedV2Fixture();
  try {
    completeTask(repository);
    const proposalPath = path.join(
      repository,
      'openspec/changes/demo-change/proposal.md',
    );
    const stale = createPlanningAmendmentDecision({
      reason: 'archive-applicability-failure',
      executionImpact: 'none',
      rationale:
        'The correction restores archive applicability without invalidating completed execution.',
      amendsPlanningGeneration: 'f'.repeat(64),
    });
    fs.writeFileSync(
      proposalPath,
      replacePlanningAmendmentDecisionMarker(
        `${fs.readFileSync(proposalPath, 'utf8').trimEnd()}\n\nReviewed archive correction.\n`,
        stale,
      ),
    );
    writeReadyV2ExemptChange(repository);

    assert.throws(
      () =>
        commitPlanAmendment(repository, 'demo-change', {
          reason: 'archive-applicability-failure',
          executionImpact: 'none',
        }),
      (error: unknown) => isWorkflowError(error, 'AMENDMENT_DECISION_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI replay rejects trailers whose reviewed decision names another parent generation', () => {
  const repository = plannedV2Fixture();
  try {
    completeTask(repository);
    const priorGeneration = committedPlanningGeneration(
      repository,
      'HEAD',
      'openspec/changes',
      'demo-change',
    );
    assert.notEqual(priorGeneration, null);
    const proposalPath = path.join(
      repository,
      'openspec/changes/demo-change/proposal.md',
    );
    const stale = createPlanningAmendmentDecision({
      reason: 'archive-applicability-failure',
      executionImpact: 'none',
      rationale:
        'The correction claims a different parent and must not survive immutable replay.',
      amendsPlanningGeneration: 'f'.repeat(64),
    });
    fs.writeFileSync(
      proposalPath,
      replacePlanningAmendmentDecisionMarker(
        `${fs.readFileSync(proposalPath, 'utf8').trimEnd()}\n\nReviewed archive correction.\n`,
        stale,
      ),
    );
    writeReadyV2ExemptChange(repository);
    const assurance = validateOpenSpecPlanning(
      repository,
      'demo-change',
      'expense-app-v2',
    ).planningAssurance;
    assert.notEqual(assurance, null);
    git(repository, ['add', '-A']);
    git(repository, [
      'commit',
      '-m',
      'Amend plan demo-change',
      '-m',
      [
        'Change: demo-change',
        'Transition: amend-plan',
        `Planning-Generation: ${assurance!.planningGenerationId}`,
        `Amends-Planning-Generation: ${priorGeneration}`,
        'Execution-Impact: none',
        `Plan-Review: ${assurance!.reviewNodeId}`,
      ].join('\n'),
    ]);
    const forged = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => validateCiPlanningCommit(repository, forged, 'demo-change'),
      (error: unknown) =>
        isWorkflowError(error, 'CI_PLANNING_AMENDMENT_PROVENANCE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('duplicate reviewed amendment markers are refused rather than selected', () => {
  const repository = plannedV2Fixture();
  try {
    completeTask(repository);
    prepareReviewedCorrection(repository);
    const proposalPath = path.join(
      repository,
      'openspec/changes/demo-change/proposal.md',
    );
    const proposal = fs.readFileSync(proposalPath, 'utf8');
    const decision = readPlanningAmendmentDecision(proposal);
    assert.notEqual(decision, null);
    fs.appendFileSync(
      proposalPath,
      `\n${renderPlanningAmendmentDecisionMarker(decision!)}\n`,
    );
    writeReadyV2ExemptChange(repository);

    assert.throws(
      () =>
        commitPlanAmendment(repository, 'demo-change', {
          reason: 'archive-applicability-failure',
          executionImpact: 'none',
        }),
      (error: unknown) => isWorkflowError(error, 'AMENDMENT_DECISION_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('amend-plan admits a pre-epoch completed generation without forged task evidence', () => {
  const repository = preEpochCompletedFixture();
  try {
    prepareReviewedCorrection(repository);

    const result = commitPlanAmendment(repository, 'demo-change', {
      reason: 'archive-applicability-failure',
      executionImpact: 'none',
    });

    assert.equal(result.amendment?.executionImpact, 'none');
    assert.deepEqual(result.amendment?.reopenedTasks, []);
    const report = readAmendmentReport(
      repository,
      result.reportId,
    ) as unknown as {
      reportVersion: number;
      amendment: {
        executionDisposition: unknown;
      };
    };
    assert.equal(report.reportVersion, 3);
    assert.deepEqual(report.amendment.executionDisposition, {
      kind: 'carried-forward',
      tasks: [
        {
          taskId: '1.1',
          source: 'pre-epoch-exemption',
          commitHash: null,
        },
      ],
    });
    assert.equal(git(repository, ['status', '--porcelain']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a post-activation plan cannot forge the pre-epoch task exemption', () => {
  const repository = preEpochCompletedFixture('before-plan');
  try {
    prepareReviewedCorrection(repository);
    const before = repositoryState(repository);

    assert.throws(
      () =>
        commitPlanAmendment(repository, 'demo-change', {
          reason: 'archive-applicability-failure',
          executionImpact: 'none',
        }),
      (error: unknown) => isWorkflowError(error, 'AMENDMENT_STATE_INELIGIBLE'),
    );
    assert.deepEqual(repositoryState(repository), before);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a stale side branch cannot forge pre-epoch evidence after the protected cutover', () => {
  const repository = preEpochCompletedFixture(
    'stale-after-protected-activation',
  );
  try {
    prepareReviewedCorrection(repository);

    assert.throws(
      () =>
        commitPlanAmendment(repository, 'demo-change', {
          reason: 'archive-applicability-failure',
          executionImpact: 'none',
        }),
      (error: unknown) => isWorkflowError(error, 'AMENDMENT_STATE_INELIGIBLE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('required-impact amendment may reopen every task only after the prior generation completed', () => {
  const repository = plannedV2Fixture();
  try {
    completeTask(repository);
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [x] 1.1', '- [ ] 1.1'),
    );
    prepareReviewedCorrection(repository, {
      reason: 'execution-contract-changed',
      executionImpact: 'required',
      rationale:
        'The execution contract changed, so the completed task must run again.',
    });

    const result = commitPlanAmendment(repository, 'demo-change', {
      reason: 'execution-contract-changed',
      executionImpact: 'required',
    });

    assert.equal(result.amendment?.executionImpact, 'required');
    assert.deepEqual(result.amendment?.reopenedTasks, ['1.1']);
    const report = readAmendmentReport(
      repository,
      result.reportId,
    ) as unknown as {
      amendment: {
        executionDisposition: unknown;
      };
    };
    assert.deepEqual(report.amendment.executionDisposition, {
      kind: 'reopened',
      taskIds: ['1.1'],
    });
    const epoch = inspectPlanningExecutionEpoch(repository, 'demo-change');
    assert.equal(epoch.context.workflow.currentEpoch, 2);
    assert.equal(
      epoch.context.workflow.checkpoint,
      'execution-restart-required',
    );
    assert.deepEqual(epoch.context.currentManifest.items, []);
    assert.deepEqual(epoch.context.transitionReceipts[0]?.invalidated, [
      'task:1.1',
    ]);
    assert.ok(
      epoch.retention.records
        .filter(({ epoch: evidenceEpoch }) => evidenceEpoch === 1)
        .every(({ retention }) => retention === 'expiring'),
    );
    assert.match(fs.readFileSync(tasksPath, 'utf8'), /- \[ \] 1\.1/);
    assert.equal(git(repository, ['status', '--porcelain']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a completed required-impact re-execution is the exact evidence for the next amendment', () => {
  const repository = plannedV2Fixture();
  try {
    completeTask(repository);
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [x] 1.1', '- [ ] 1.1'),
    );
    prepareReviewedCorrection(repository, {
      reason: 'execution-contract-changed',
      executionImpact: 'required',
      rationale:
        'The execution contract changed, so the completed task must run again.',
    });
    commitPlanAmendment(repository, 'demo-change', {
      reason: 'execution-contract-changed',
      executionImpact: 'required',
    });

    completeTask(repository);
    prepareReviewedCorrection(repository);
    const result = commitPlanAmendment(repository, 'demo-change', {
      reason: 'archive-applicability-failure',
      executionImpact: 'none',
    });

    assert.equal(result.amendment?.executionImpact, 'none');
    assert.deepEqual(result.amendment?.reopenedTasks, []);
    assert.equal(git(repository, ['status', '--porcelain']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('successive no-impact amendments advance one continuous execution epoch', () => {
  const repository = plannedV2Fixture();
  try {
    completeTask(repository);
    prepareReviewedCorrection(repository);
    commitPlanAmendment(repository, 'demo-change', {
      reason: 'archive-applicability-failure',
      executionImpact: 'none',
    });
    prepareReviewedCorrection(repository);

    commitPlanAmendment(repository, 'demo-change', {
      reason: 'archive-applicability-failure',
      executionImpact: 'none',
    });

    const epoch = inspectPlanningExecutionEpoch(repository, 'demo-change');
    assert.equal(epoch.context.workflow.currentEpoch, 3);
    assert.equal(epoch.context.transitionReceipts.length, 2);
    assert.equal(epoch.context.workflow.checkpoint, 'execution-complete');
    assert.deepEqual(
      epoch.context.currentManifest.items.map(({ identity }) => identity),
      ['task:1.1'],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive admission projects completed required-impact execution into the current epoch', () => {
  const repository = plannedV2Fixture();
  try {
    completeTask(repository);
    const tasksPath = path.join(
      repository,
      'openspec/changes/demo-change/tasks.md',
    );
    fs.writeFileSync(
      tasksPath,
      fs.readFileSync(tasksPath, 'utf8').replace('- [x] 1.1', '- [ ] 1.1'),
    );
    prepareReviewedCorrection(repository, {
      reason: 'execution-contract-changed',
      executionImpact: 'required',
      rationale:
        'The execution contract changed, so the completed task must run again.',
    });
    commitPlanAmendment(repository, 'demo-change', {
      reason: 'execution-contract-changed',
      executionImpact: 'required',
    });
    completeTask(repository);
    git(repository, ['update-ref', 'refs/heads/main', 'HEAD']);
    syncOriginMain(repository);

    withArchiveEligibility(
      repository,
      'demo-change',
      (eligibility) => eligibility,
    );

    const epoch = inspectPlanningExecutionEpoch(repository, 'demo-change');
    assert.equal(epoch.context.workflow.currentEpoch, 3);
    assert.equal(epoch.context.workflow.checkpoint, 'execution-complete');
    assert.deepEqual(
      epoch.context.currentManifest.items.map(({ identity }) => identity),
      ['task:1.1'],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('archive admission recovers an amendment committed before its epoch publication', () => {
  const repository = plannedV2Fixture();
  try {
    completeTask(repository);
    prepareReviewedCorrection(repository);
    assert.throws(
      () =>
        commitPlanAmendment(
          repository,
          'demo-change',
          {
            reason: 'archive-applicability-failure',
            executionImpact: 'none',
          },
          process.env,
          {
            afterRefUpdateBeforeEpoch: () => {
              throw new Error(
                'simulated process crash before epoch publication',
              );
            },
          },
        ),
      /simulated process crash/,
    );
    git(repository, ['update-ref', 'refs/heads/main', 'HEAD']);
    syncOriginMain(repository);

    withArchiveEligibility(
      repository,
      'demo-change',
      (eligibility) => eligibility,
    );

    const epoch = inspectPlanningExecutionEpoch(repository, 'demo-change');
    assert.equal(epoch.context.workflow.currentEpoch, 2);
    assert.equal(epoch.context.workflow.checkpoint, 'execution-complete');
    assert.deepEqual(
      epoch.context.currentManifest.items.map(({ identity }) => identity),
      ['task:1.1'],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

for (const contract of ['tasks', 'guard'] as const) {
  test(`no-impact amendment refuses a reviewed ${contract} contract change`, () => {
    const repository = plannedV2Fixture();
    try {
      completeTask(repository);
      if (contract === 'tasks') {
        const tasksPath = path.join(
          repository,
          'openspec/changes/demo-change/tasks.md',
        );
        fs.writeFileSync(
          tasksPath,
          fs
            .readFileSync(tasksPath, 'utf8')
            .replace('Demo task', 'Retitled execution task'),
        );
      } else {
        const guardPath = path.join(
          repository,
          'openspec/changes/demo-change/guard.json',
        );
        const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
          tasks: Record<string, { allowedPaths: string[] }>;
        };
        guard.tasks['1.1']!.allowedPaths.push('additional/**');
        fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
      }
      prepareReviewedCorrection(repository);
      const before = repositoryState(repository);

      assert.throws(
        () =>
          commitPlanAmendment(repository, 'demo-change', {
            reason: 'archive-applicability-failure',
            executionImpact: 'none',
          }),
        (error: unknown) =>
          isWorkflowError(error, 'AMENDMENT_EXECUTION_IMPACT_REQUIRED'),
      );

      assert.deepEqual(repositoryState(repository), before);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}

test('amend-plan CLI exposes the completed-generation transition with exact provenance', () => {
  const repository = plannedV2Fixture();
  try {
    completeTask(repository);
    prepareReviewedCorrection(repository);

    const output = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(sourceRepositoryRoot, 'packages/workflow-engine/src/cli.ts'),
        'amend-plan',
        'demo-change',
        '--reason',
        'archive-applicability-failure',
        '--execution-impact',
        'none',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      result: { amendment: { executionImpact: string } };
    };
    assert.equal(payload.command, 'amend-plan');
    assert.equal(payload.ok, true);
    assert.equal(payload.result.amendment.executionImpact, 'none');
    assert.match(
      git(repository, ['show', '-s', '--format=%B', 'HEAD']),
      /Transition: amend-plan[\s\S]*Execution-Impact: none/,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

for (const evidence of ['missing', 'ambiguous'] as const) {
  test(`amend-plan refuses completed state with ${evidence} exact task-commit evidence`, () => {
    const repository = plannedV2Fixture();
    try {
      if (evidence === 'missing') {
        const tasksPath = path.join(
          repository,
          'openspec/changes/demo-change/tasks.md',
        );
        fs.writeFileSync(
          tasksPath,
          fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
        );
        git(repository, ['add', '-A']);
        git(repository, ['commit', '-m', 'Forge completed planning state']);
      } else {
        completeTask(repository);
        git(repository, [
          'commit',
          '--allow-empty',
          '-m',
          'Duplicate demo execution authority',
          '-m',
          'Change: demo-change\nTask: 1.1',
        ]);
      }
      prepareReviewedCorrection(repository);
      const before = repositoryState(repository);

      assert.throws(
        () =>
          commitPlanAmendment(repository, 'demo-change', {
            reason: 'archive-applicability-failure',
            executionImpact: 'none',
          }),
        (error: unknown) =>
          isWorkflowError(
            error,
            evidence === 'ambiguous'
              ? 'TASK_EXECUTION_GENERATION_INVALID'
              : 'AMENDMENT_STATE_INELIGIBLE',
          ),
      );

      assert.deepEqual(repositoryState(repository), before);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}

function plannedV2Fixture(): string {
  const repository = createFixtureRepository();
  git(repository, ['checkout', '-b', 'work/demo-change']);
  writeReadyV2ExemptChange(repository);
  commitPlanningTransition(repository, 'demo-change');
  return repository;
}

function preEpochCompletedFixture(
  activation:
    | 'after-plan'
    | 'before-plan'
    | 'stale-after-protected-activation' = 'after-plan',
): string {
  const repository = createFixtureRepository();
  const preActivationHead = git(repository, ['rev-parse', 'HEAD']).trim();
  if (
    activation === 'before-plan' ||
    activation === 'stale-after-protected-activation'
  ) {
    activateInvestigationPlanning(repository);
    syncOriginMain(repository);
  }
  git(repository, [
    'checkout',
    '-b',
    'work/demo-change',
    ...(activation === 'stale-after-protected-activation'
      ? [preActivationHead]
      : []),
  ]);
  writeReadyV2ExemptChange(repository);
  const tasksPath = path.join(
    repository,
    'openspec/changes/demo-change/tasks.md',
  );
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
  );
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Bootstrap completed execution']);
  fs.appendFileSync(
    path.join(repository, 'openspec/changes/demo-change/design.md'),
    '\nCanonical planning epoch.\n',
  );
  git(repository, ['add', '-A']);
  git(repository, [
    'commit',
    '-m',
    'Plan demo-change',
    '-m',
    'Change: demo-change\nTransition: plan',
  ]);
  if (
    activation === 'after-plan' ||
    activation === 'stale-after-protected-activation'
  ) {
    activateInvestigationPlanning(repository);
  }
  return repository;
}

function completeTask(repository: string): void {
  const tasksPath = path.join(
    repository,
    'openspec/changes/demo-change/tasks.md',
  );
  fs.writeFileSync(
    tasksPath,
    fs.readFileSync(tasksPath, 'utf8').replace('- [ ] 1.1', '- [x] 1.1'),
  );
  git(repository, ['add', '-A']);
  git(repository, [
    'commit',
    '-m',
    'Complete demo execution',
    '-m',
    'Change: demo-change\nTask: 1.1',
  ]);
}

function prepareReviewedCorrection(
  repository: string,
  input: {
    reason: string;
    executionImpact: 'none' | 'required';
    rationale: string;
  } = {
    reason: 'archive-applicability-failure',
    executionImpact: 'none',
    rationale:
      'The correction restores archive applicability without invalidating completed execution.',
  },
): void {
  const proposalPath = path.join(
    repository,
    'openspec/changes/demo-change/proposal.md',
  );
  const amendsPlanningGeneration = committedPlanningGeneration(
    repository,
    'HEAD',
    'openspec/changes',
    'demo-change',
  );
  assert.notEqual(amendsPlanningGeneration, null);
  const decision = createPlanningAmendmentDecision({
    ...input,
    amendsPlanningGeneration: amendsPlanningGeneration!,
  });
  fs.writeFileSync(
    proposalPath,
    replacePlanningAmendmentDecisionMarker(
      `${fs.readFileSync(proposalPath, 'utf8').trimEnd()}\n\nReviewed archive correction.\n`,
      decision,
    ),
  );
  writeReadyV2ExemptChange(repository);
}

function repositoryState(repository: string) {
  return {
    head: git(repository, ['rev-parse', 'HEAD']).trim(),
    index: git(repository, ['write-tree']).trim(),
    status: git(repository, ['status', '--porcelain=v2', '-z']),
  };
}

function readAmendmentReport(repository: string, reportId: string) {
  return readPlanningTransitionReport(
    amendmentReportsDirectory(repository),
    reportId,
  );
}

function amendmentReportsDirectory(repository: string): string {
  const locator = discoverRepository(repository);
  const config = loadWorkflowConfig(locator.repositoryRoot);
  return path.join(
    locator.gitCommonDirectory,
    config.runtimeDirectory,
    'planning-reports',
  );
}
