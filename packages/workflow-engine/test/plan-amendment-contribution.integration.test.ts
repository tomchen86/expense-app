import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import type { ExecutionArtifact } from '../src/adapters/consumer/expense-app/work-registry/contracts.ts';
import { createInvestigationCheckpointEnvelope } from '../src/adapters/compatibility/investigation-v2/investigation-session.ts';
import {
  PLAN_REVIEW_COVERAGE,
  readPlanReviewNode,
} from '../src/modules/assurance/plan-review.ts';
import {
  createPlanningContributionEnvelope,
  createPlanReviewDispositionsEnvelope,
  createPlanReviewProgressEnvelope,
  getProposeStatus,
  resumePropose,
  startPropose,
} from '../src/application/propose/propose-orchestrator.ts';
import type { ProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  claimProviderInvocation,
  completeProviderInvocation,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import {
  PROVIDER_RUNNER_RESIDUALS,
  type ProviderRunnerReport,
} from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import {
  builtInProviderDefinitionSnapshotForTest,
  createFixtureRepository,
  git,
  isWorkflowError,
} from './fixture.ts';
import { installPlanReviewAuthority } from './plan-review-authority-fixture.ts';

const CHANGE_ID = 'amended-executed-change';

// The prior generation, exactly as an executed change carries it: every task
// completed, a committed review of the plan being replaced, and engine-owned
// artifacts whose bytes the amendment's new generation cannot reproduce.
const PRIOR_METADATA = 'schema: expense-app-v2\ncreated: 2026-07-01\n';
const PRIOR_INVESTIGATION =
  '{"kind":"investigation-artifact","note":"prior generation"}\n';
const PRIOR_PLAN_REVIEW =
  '{"kind":"plan-review-artifact","note":"prior generation review"}\n';
const PRIOR_PROPOSAL = '# Proposal\n\nShip the demo behavior.\n';
const PRIOR_DESIGN = [
  '# Design',
  '',
  'Authored prefix.',
  '',
  '## Investigation Ledger',
  '',
  '<!-- workflow:investigation-ledger:start v1 -->',
  '',
  'Prior generation ledger.',
  '',
  '<!-- workflow:investigation-ledger:end v1 -->',
  '',
  'Authored suffix.',
  '',
].join('\n');
const EXECUTED_TASKS =
  '# Tasks\n\n- [x] 1.1 Ship the demo behavior\n- [x] 1.2 Verify the demo behavior\n';
const PRIOR_SPEC = [
  '# Delta',
  '',
  '## ADDED Requirements',
  '',
  '### Requirement: Demo behavior',
  '',
  'The system SHALL provide the demo behavior.',
  '',
  '#### Scenario: Demo succeeds',
  '',
  '- **WHEN** the demo is exercised',
  '- **THEN** the behavior succeeds',
  '',
].join('\n');
// The amendment's whole point: the same delta with the dropped scenario
// identity restored.
const CORRECTED_SPEC = [
  '# Delta',
  '',
  '## ADDED Requirements',
  '',
  '### Requirement: Demo behavior',
  '',
  'The system SHALL provide the demo behavior.',
  '',
  '#### Scenario: Demo succeeds',
  '',
  '- **WHEN** the demo is exercised',
  '- **THEN** the behavior succeeds',
  '',
  '#### Scenario: Demo persists',
  '',
  '- **WHEN** the demo is replayed',
  '- **THEN** the behavior still succeeds',
  '',
].join('\n');
const AUTHORED_DESIGN = [
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
].join('\n');

const GUARD_TASK = { allowedPaths: ['src/**'], requiredChecks: ['fixture'] };
const EXECUTION_TASK: ExecutionArtifact['tasks'][string] = {
  strategy: 'direct-reviewed',
  enforcement: 'available',
  allowedPaths: ['src/**'],
  requiredChecks: ['fixture'],
  diffReview: 'policy-required',
  exemptionKind: 'narrowly-scoped-non-behavioral',
  exemptionReason:
    'The fixture exercises planning orchestration without product behavior.',
  legacyBootstrap: null,
};

test('an amendment contribution replaces the executed prior generation without reopening its work', () => {
  const repository = createFixtureRepository();
  const reviewAuthority = installPlanReviewAuthority(repository);
  try {
    git(repository, ['checkout', '-b', `work/${CHANGE_ID}`]);
    fs.writeFileSync(
      path.join(repository, 'src/amended-target.ts'),
      [
        'export const AmendGateNeedle = true;',
        'export const AmendMainNeedle = true;',
        'export const AmendBlindNeedle = true;',
        '',
      ].join('\n'),
    );
    const changeDirectory = path.join(
      repository,
      'openspec/changes',
      CHANGE_ID,
    );
    fs.mkdirSync(path.join(changeDirectory, 'specs/demo'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(changeDirectory, '.openspec.yaml'),
      PRIOR_METADATA,
    );
    fs.writeFileSync(
      path.join(changeDirectory, 'investigation.json'),
      PRIOR_INVESTIGATION,
    );
    fs.writeFileSync(
      path.join(changeDirectory, 'plan-review.json'),
      PRIOR_PLAN_REVIEW,
    );
    fs.writeFileSync(path.join(changeDirectory, 'proposal.md'), PRIOR_PROPOSAL);
    fs.writeFileSync(path.join(changeDirectory, 'design.md'), PRIOR_DESIGN);
    fs.writeFileSync(path.join(changeDirectory, 'tasks.md'), EXECUTED_TASKS);
    fs.writeFileSync(
      path.join(changeDirectory, 'specs/demo/spec.md'),
      PRIOR_SPEC,
    );
    fs.writeFileSync(
      path.join(changeDirectory, 'guard.json'),
      `${canonicalJson({
        schemaVersion: 1 as const,
        changeId: CHANGE_ID,
        tasks: { '1.1': GUARD_TASK, '1.2': GUARD_TASK },
      })}\n`,
    );
    fs.writeFileSync(
      path.join(changeDirectory, 'execution.json'),
      `${canonicalJson({
        schemaVersion: 1,
        kind: 'execution-artifact',
        changeId: CHANGE_ID,
        note: 'prior generation execution contract',
      })}\n`,
    );
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Commit the executed prior generation']);

    const started = startPropose(
      repository,
      CHANGE_ID,
      {
        schemaVersion: 1,
        summary:
          'Restore the dropped scenario identity in the executed change.',
        explicitPaths: [],
        explicitSymbols: ['AmendGateNeedle'],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      {
        explicitActor: 'codex',
        environment: {},
        providerDriver: ({ paths, request }) => {
          const claim = claimProviderInvocation(paths, request.invocationId, {
            workerId: 'fake-amendment-worker',
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
                  terms: [{ kind: 'symbol', value: 'AmendBlindNeedle' }],
                }),
              ),
              stderr: '',
            },
          });
        },
      },
    );
    assert.equal(started.state, 'awaiting-main-terms');

    const afterMain = resumePropose(
      repository,
      CHANGE_ID,
      createInvestigationCheckpointEnvelope(started.investigation!, {
        reference: 'amendment-main-survey',
        terms: [
          {
            kind: 'symbol',
            value: 'AmendMainNeedle',
            rationale: 'The main investigation identified the amended target.',
            expectedRelationship: 'The amendment depends on this symbol.',
          },
        ],
      }),
    );
    assert.equal(afterMain.state, 'awaiting-group-dispositions');

    const afterDispositions = resumePropose(
      repository,
      CHANGE_ID,
      createInvestigationCheckpointEnvelope(afterMain.investigation!, {
        dispositions: afterMain.work!.groups.map((group) => ({
          groupId: group.groupId,
          classification: 'load-bearing' as const,
          rationale: 'This tracked consumer is load-bearing for the amendment.',
          author: 'codex',
        })),
      }),
    );
    assert.equal(afterDispositions.state, 'awaiting-ledger-answers');

    // Sealing must render for a change whose planning tree already exists; an
    // amendment is exactly that state, and the render owns no byte of it.
    const sealed = resumePropose(
      repository,
      CHANGE_ID,
      createInvestigationCheckpointEnvelope(afterDispositions.investigation!, {
        answers: afterDispositions.work!.fullBlobManifest.map((entry) =>
          whyAnswer(entry.manifestEntryId),
        ),
      }),
    );
    assert.equal(sealed.state, 'awaiting-planning-contribution');
    assert.equal(
      fs.readFileSync(path.join(changeDirectory, 'investigation.json'), 'utf8'),
      PRIOR_INVESTIGATION,
    );
    assert.equal(
      fs.readFileSync(path.join(changeDirectory, '.openspec.yaml'), 'utf8'),
      PRIOR_METADATA,
    );

    const amendedPayload = {
      proposal: PRIOR_PROPOSAL,
      design: AUTHORED_DESIGN,
      specs: [{ path: 'specs/demo/spec.md', content: CORRECTED_SPEC }],
      tasks: EXECUTED_TASKS,
      guard: {
        schemaVersion: 1 as const,
        changeId: CHANGE_ID,
        tasks: { '1.1': GUARD_TASK, '1.2': GUARD_TASK },
      },
      executionTasks: { '1.1': EXECUTION_TASK, '1.2': EXECUTION_TASK },
    };

    // A plan still may not mark work done: completions beyond the committed
    // baseline stay refused.
    assert.throws(
      () =>
        resumePropose(
          repository,
          CHANGE_ID,
          createPlanningContributionEnvelope(sealed, {
            ...amendedPayload,
            tasks: `${EXECUTED_TASKS}- [x] 1.3 Invent a completion\n`,
            guard: {
              schemaVersion: 1 as const,
              changeId: CHANGE_ID,
              tasks: {
                '1.1': GUARD_TASK,
                '1.2': GUARD_TASK,
                '1.3': GUARD_TASK,
              },
            },
            executionTasks: {
              '1.1': EXECUTION_TASK,
              '1.2': EXECUTION_TASK,
              '1.3': EXECUTION_TASK,
            },
          }),
        ),
      (error: unknown) => isWorkflowError(error, 'PLANNING_TASK_STATE_INVALID'),
    );

    // Reopening a chosen subset claims the rest is unaffected; refused here
    // with the same judgment the transition applies.
    assert.throws(
      () =>
        resumePropose(
          repository,
          CHANGE_ID,
          createPlanningContributionEnvelope(sealed, {
            ...amendedPayload,
            tasks:
              '# Tasks\n\n- [x] 1.1 Ship the demo behavior\n- [ ] 1.2 Verify the demo behavior\n',
          }),
        ),
      (error: unknown) => isWorkflowError(error, 'AMENDMENT_PARTIAL_REOPEN'),
    );

    // Replacement authority reaches exactly the bytes committed at the session
    // baseline; an uncommitted local edit stays a conflict, and the failed
    // materialization rolls every touched byte back.
    const designPath = path.join(changeDirectory, 'design.md');
    fs.writeFileSync(designPath, `${PRIOR_DESIGN}Tampered line.\n`);
    assert.throws(
      () =>
        resumePropose(
          repository,
          CHANGE_ID,
          createPlanningContributionEnvelope(sealed, amendedPayload),
        ),
      (error: unknown) => isWorkflowError(error, 'UNMANAGED_PLANNING_CONFLICT'),
    );
    assert.equal(
      fs.readFileSync(path.join(changeDirectory, 'investigation.json'), 'utf8'),
      PRIOR_INVESTIGATION,
    );
    assert.equal(
      fs.readFileSync(path.join(changeDirectory, 'plan-review.json'), 'utf8'),
      PRIOR_PLAN_REVIEW,
    );
    fs.writeFileSync(designPath, PRIOR_DESIGN);

    const materialized = resumePropose(
      repository,
      CHANGE_ID,
      createPlanningContributionEnvelope(sealed, amendedPayload),
    );
    assert.equal(materialized.state, 'waiting-for-plan-review');

    // The corrected generation landed; the executed record did not move.
    assert.equal(
      fs.readFileSync(path.join(changeDirectory, 'tasks.md'), 'utf8'),
      EXECUTED_TASKS,
    );
    assert.equal(
      fs.readFileSync(path.join(changeDirectory, 'specs/demo/spec.md'), 'utf8'),
      CORRECTED_SPEC,
    );
    assert.equal(
      fs.readFileSync(path.join(changeDirectory, 'proposal.md'), 'utf8'),
      PRIOR_PROPOSAL,
    );
    assert.equal(
      fs.readFileSync(path.join(changeDirectory, '.openspec.yaml'), 'utf8'),
      PRIOR_METADATA,
    );
    const replacedInvestigation = JSON.parse(
      fs.readFileSync(path.join(changeDirectory, 'investigation.json'), 'utf8'),
    );
    assert.equal(replacedInvestigation.kind, 'investigation-artifact');
    assert.equal(replacedInvestigation.changeId, CHANGE_ID);
    // The prior generation's review reviewed the plan being replaced; the
    // amendment returns the graph to review-pending for a fresh one.
    assert.equal(
      fs.existsSync(path.join(changeDirectory, 'plan-review.json')),
      false,
    );
    assert.ok(
      fs.readFileSync(designPath, 'utf8').includes('Protected invariant:'),
    );
    const coverageEvidence = requiredCoverageEvidence(replacedInvestigation);

    // The fresh review's citations must resolve against the current amended
    // bytes: the prior review is committed at HEAD but removed from the
    // worktree, and that absence means "no committed review", not an unsafe
    // artifact.
    const investigationId = materialized.investigation!.investigationId;
    runProviderWorker(
      repository,
      getProposeStatus(repository, investigationId).planReview!.invocationId,
      {
        runner: (input) =>
          fakeRunnerReport(input.request, {
            schemaVersion: 2 as const,
            verdict: 'advisory-approve' as const,
            coverage: [...PLAN_REVIEW_COVERAGE],
            scopeAssessment: { kind: 'challenges' as const },
            findings: [
              {
                kind: 'challenge' as const,
                severity: 'medium' as const,
                category: 'missing-scope',
                currentChangeImpact: 'required' as const,
                summary:
                  'Confirm the restored scenario keeps its original body form.',
                evidence: [
                  ...coverageEvidence,
                  {
                    kind: 'planning-location' as const,
                    path: `openspec/changes/${CHANGE_ID}/specs/demo/spec.md`,
                    line: 1,
                    observation:
                      'The corrected delta restores the dropped identity.',
                  },
                ],
              },
            ],
            proposedTerms: [],
            suggestions: [],
            residualRisk:
              'The amendment cannot prove the executed work anticipated the restored scenario.',
            uncertainty:
              'Advisory review remains a semantic judgment over the exact subject.',
          }),
      },
    );
    const awaitingDisposition = resumePropose(
      repository,
      CHANGE_ID,
      createPlanReviewProgressEnvelope(
        getProposeStatus(repository, investigationId),
      ),
    );
    assert.equal(
      awaitingDisposition.state,
      'awaiting-challenge-dispositions',
      JSON.stringify(awaitingDisposition.planReview?.failure),
    );
    const trackedPlanReview = JSON.parse(
      fs.readFileSync(path.join(changeDirectory, 'plan-review.json'), 'utf8'),
    );
    const reviewNode = trackedPlanReview.nodes.find(
      (node: { type: string }) => node.type === 'plan-review',
    );
    const completed = resumePropose(
      repository,
      CHANGE_ID,
      createPlanReviewDispositionsEnvelope(awaitingDisposition, [
        {
          challengeId: readPlanReviewNode(reviewNode).findings[0]!.findingId,
          decision: 'rebutted',
          rationale:
            'The restoration reproduces the original scenario body verbatim.',
          author: reviewAuthority.identity,
          supersededBy: null,
        },
      ]),
      {
        challengeDispositionAuthority: {
          now: new Date('2026-08-10T00:00:00.000Z'),
          role: 'reviewer',
          signer: reviewAuthority.signer,
        },
      },
    );
    assert.equal(completed.state, 'planning-complete');
    assert.equal(completed.planningTransition?.kind, 'revision');
    assert.equal(
      git(repository, [
        'log',
        '-1',
        '--format=%(trailers:key=Transition,valueonly)',
      ]).trim(),
      'plan',
    );
    // The executed record survived the whole review round untouched.
    assert.equal(
      fs.readFileSync(path.join(changeDirectory, 'tasks.md'), 'utf8'),
      EXECUTED_TASKS,
    );
    assert.equal(
      git(repository, ['show', `HEAD:openspec/changes/${CHANGE_ID}/tasks.md`]),
      EXECUTED_TASKS,
    );
  } finally {
    reviewAuthority.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function requiredCoverageEvidence(investigation: {
  nodes: Array<{
    type: string;
    output?: {
      requiredTargetIds?: string[];
      targetBindings?: Array<{ targetId: string; path: string }>;
    };
  }>;
}) {
  const output = investigation.nodes.find(
    ({ type }) => type === 'plan-review-coverage-requirement',
  )?.output;
  assert.ok(output?.requiredTargetIds && output.targetBindings);
  const required = new Set(output.requiredTargetIds);
  return [
    ...new Set(
      output.targetBindings
        .filter(({ targetId }) => required.has(targetId))
        .map(({ path: targetPath }) => targetPath),
    ),
  ]
    .sort()
    .map((targetPath) => ({
      kind: 'repository-location' as const,
      path: targetPath,
      line: 1,
      observation: 'The engine-required review target was examined.',
    }));
}

function whyAnswer(manifestEntryId: string) {
  return {
    manifestEntryId,
    why: 'This complete module participates in the amended behavior.',
    protectedInvariant: 'Exact source and evidence identity remain bound.',
    reviewerQuestion: 'What prevents a stale blob from satisfying this row?',
    answer: 'The manifest binds the complete exact source digest.',
    semanticAuthor: 'codex',
    readComplete: true as const,
  };
}

test('novel reviewer terms reopen an amendment whose prior review is committed but withdrawn', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', `work/${CHANGE_ID}`]);
    fs.writeFileSync(
      path.join(repository, 'src/amended-target.ts'),
      [
        'export const AmendGateNeedle = true;',
        'export const AmendMainNeedle = true;',
        'export const AmendBlindNeedle = true;',
        'export const AmendReviewerNeedle = true;',
        '',
      ].join('\n'),
    );
    const changeDirectory = path.join(
      repository,
      'openspec/changes',
      CHANGE_ID,
    );
    fs.mkdirSync(path.join(changeDirectory, 'specs/demo'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(changeDirectory, '.openspec.yaml'),
      PRIOR_METADATA,
    );
    fs.writeFileSync(
      path.join(changeDirectory, 'investigation.json'),
      PRIOR_INVESTIGATION,
    );
    fs.writeFileSync(
      path.join(changeDirectory, 'plan-review.json'),
      PRIOR_PLAN_REVIEW,
    );
    fs.writeFileSync(path.join(changeDirectory, 'proposal.md'), PRIOR_PROPOSAL);
    fs.writeFileSync(path.join(changeDirectory, 'design.md'), PRIOR_DESIGN);
    fs.writeFileSync(path.join(changeDirectory, 'tasks.md'), EXECUTED_TASKS);
    fs.writeFileSync(
      path.join(changeDirectory, 'specs/demo/spec.md'),
      PRIOR_SPEC,
    );
    fs.writeFileSync(
      path.join(changeDirectory, 'guard.json'),
      `${canonicalJson({
        schemaVersion: 1 as const,
        changeId: CHANGE_ID,
        tasks: { '1.1': GUARD_TASK, '1.2': GUARD_TASK },
      })}\n`,
    );
    fs.writeFileSync(
      path.join(changeDirectory, 'execution.json'),
      `${canonicalJson({
        schemaVersion: 1,
        kind: 'execution-artifact',
        changeId: CHANGE_ID,
        note: 'prior generation execution contract',
      })}\n`,
    );
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'Commit the executed prior generation']);

    const started = startPropose(
      repository,
      CHANGE_ID,
      {
        schemaVersion: 1,
        summary:
          'Restore the dropped scenario identity in the executed change.',
        explicitPaths: [],
        explicitSymbols: ['AmendGateNeedle'],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      {
        explicitActor: 'codex',
        environment: {},
        providerDriver: ({ paths, request }) => {
          const claim = claimProviderInvocation(paths, request.invocationId, {
            workerId: 'fake-amendment-reopen-worker',
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
                  terms: [{ kind: 'symbol', value: 'AmendBlindNeedle' }],
                }),
              ),
              stderr: '',
            },
          });
        },
      },
    );
    const afterMain = resumePropose(
      repository,
      CHANGE_ID,
      createInvestigationCheckpointEnvelope(started.investigation!, {
        reference: 'amendment-main-survey',
        terms: [
          {
            kind: 'symbol',
            value: 'AmendMainNeedle',
            rationale: 'The main investigation identified the amended target.',
            expectedRelationship: 'The amendment depends on this symbol.',
          },
        ],
      }),
    );
    const afterDispositions = resumePropose(
      repository,
      CHANGE_ID,
      createInvestigationCheckpointEnvelope(afterMain.investigation!, {
        dispositions: afterMain.work!.groups.map((group) => ({
          groupId: group.groupId,
          classification: 'load-bearing' as const,
          rationale: 'This tracked consumer is load-bearing for the amendment.',
          author: 'codex',
        })),
      }),
    );
    const sealed = resumePropose(
      repository,
      CHANGE_ID,
      createInvestigationCheckpointEnvelope(afterDispositions.investigation!, {
        answers: afterDispositions.work!.fullBlobManifest.map((entry) =>
          whyAnswer(entry.manifestEntryId),
        ),
      }),
    );
    const materialized = resumePropose(
      repository,
      CHANGE_ID,
      createPlanningContributionEnvelope(sealed, {
        proposal: PRIOR_PROPOSAL,
        design: AUTHORED_DESIGN,
        specs: [{ path: 'specs/demo/spec.md', content: CORRECTED_SPEC }],
        tasks: EXECUTED_TASKS,
        guard: {
          schemaVersion: 1 as const,
          changeId: CHANGE_ID,
          tasks: { '1.1': GUARD_TASK, '1.2': GUARD_TASK },
        },
        executionTasks: { '1.1': EXECUTION_TASK, '1.2': EXECUTION_TASK },
      }),
    );
    assert.equal(materialized.state, 'waiting-for-plan-review');

    // A review proposing novel terms resolves its planning citations before
    // any fresh review artifact exists on disk. The prior generation's review
    // is committed at HEAD and withdrawn from the worktree; that absence means
    // "no committed review", not an unsafe artifact.
    const investigationId = materialized.investigation!.investigationId;
    runProviderWorker(
      repository,
      getProposeStatus(repository, investigationId).planReview!.invocationId,
      {
        runner: (input) =>
          fakeRunnerReport(input.request, {
            schemaVersion: 2 as const,
            verdict: 'advisory-approve' as const,
            coverage: [...PLAN_REVIEW_COVERAGE],
            scopeAssessment: { kind: 'challenges' as const },
            findings: [
              {
                kind: 'challenge' as const,
                severity: 'medium' as const,
                category: 'missing-scope',
                currentChangeImpact: 'required' as const,
                summary:
                  'Confirm the restored scenario keeps its original body form.',
                evidence: [
                  {
                    kind: 'planning-location' as const,
                    path: `openspec/changes/${CHANGE_ID}/specs/demo/spec.md`,
                    line: 1,
                    observation:
                      'The corrected delta restores the dropped identity.',
                  },
                ],
              },
            ],
            proposedTerms: [
              { kind: 'symbol' as const, value: 'AmendReviewerNeedle' },
            ],
            suggestions: [],
            residualRisk:
              'The amendment cannot prove the executed work anticipated the restored scenario.',
            uncertainty:
              'Advisory review remains a semantic judgment over the exact subject.',
          }),
      },
    );
    const reopened = resumePropose(
      repository,
      CHANGE_ID,
      createPlanReviewProgressEnvelope(
        getProposeStatus(repository, investigationId),
      ),
    );
    assert.equal(reopened.state, 'awaiting-group-dispositions');
    assert.equal(reopened.work?.termSources.reviewer, 1);
    assert.ok((reopened.work?.groups.length ?? 0) > 0);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function fakeRunnerReport(
  request: ProviderInvocationRequest,
  semanticOutput: unknown,
): ProviderRunnerReport {
  return {
    invocationId: request.invocationId,
    providerId: request.providerId,
    purpose: request.purpose,
    requestDigest: request.requestDigest,
    semanticOutput,
    semanticOutputDigest: crypto
      .createHash('sha256')
      .update(canonicalJson(semanticOutput))
      .digest('hex'),
    assurance: 'unchanged-governed-projection',
    projection: {
      unchanged: true,
      changedCategories: [],
      beforeDigest: 'a'.repeat(64),
      afterDigest: 'a'.repeat(64),
    },
    sameUserProcessConfined: false,
    residuals: [...PROVIDER_RUNNER_RESIDUALS],
    executable: {
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
    },
    elapsedMs: 5,
    providerDefinitionSnapshot: builtInProviderDefinitionSnapshotForTest(
      request.providerId,
    ),
  };
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
